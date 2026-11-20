import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../../src/application/ports/unit-of-work.port";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs-client.factory";
import { SqsEventPublisher } from "../../../src/infrastructure/messaging/sqs-event-publisher.adapter";
import { SqsQueueRegistry } from "../../../src/infrastructure/messaging/sqs-queue-registry.service";
import { createMikroOrmConfig } from "../../../src/infrastructure/persistence/mikro-orm.config";
import { FAULT_EXIT_CODE } from "../../../src/infrastructure/system/env-fault-injector.adapter";
import { AppProcess, eventually } from "../../support/app-process.support";
import { rejectionOf } from "../../support/assertions.support";
import { sql, testOrm, truncateAll } from "../../support/database.support";
import { testEnvironment } from "../../support/environment.support";
import { bettingPayload } from "../../support/fixtures.support";
import { assertLedgerInvariant, walletBalance } from "../../support/invariant.support";
import {
    createTestQueues,
    deleteTestQueues,
    drainQueue,
    type TestQueues,
    testSqsClient,
} from "../../support/sqs.support";
import { publishUseCase, seedWallet, submitUseCase, unitOfWorkFor } from "../../support/use-cases.support";

let queues: TestQueues;
let unitOfWork: UnitOfWork;

beforeAll(async () => {
    queues = await createTestQueues();
    unitOfWork = unitOfWorkFor(await testOrm());
});

afterAll(async () => {
    await deleteTestQueues(queues);
});

beforeEach(truncateAll);

function eventsPublisher(client = testSqsClient()) {
    return new SqsEventPublisher(client, new SqsQueueRegistry(client), queues.names.events);
}

async function createWallet(amount = "100.00") {
    const wallet = await seedWallet(unitOfWork, amount);
    await sql("delete from outbox_messages");
    return wallet;
}

function betCommand(target: { walletId: string; playerId: string }, amount = "10.00") {
    const payload = bettingPayload(target.walletId, target.playerId, { money: { amount, currency: "BRL" } });
    return {
        ...payload,
        kind: WagerTransactionKind.Bet as const,
        idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
        source: "http" as const,
        correlationId: `corr-${randomUUID()}`,
    };
}

async function pendingOutbox(): Promise<number> {
    const [row] = await sql<{ count: string }>(
        "select count(*) as count from outbox_messages where published_at is null",
    );
    return Number(row?.count ?? 0);
}

describe("transactional outbox", () => {
    test("transaction, ledger, wallet and outbox are committed atomically", async () => {
        const target = await createWallet();
        const failingOutbox: UnitOfWork = {
            run: (work) =>
                unitOfWork.run((repositories) =>
                    work({
                        ...repositories,
                        outbox: {
                            ...repositories.outbox,
                            insert: async () => {
                                throw new Error("outbox unavailable");
                            },
                        },
                    }),
                ),
        };

        const error = await rejectionOf(submitUseCase(failingOutbox).execute(betCommand(target)));

        expect((error as Error).message).toBe("outbox unavailable");
        expect(await walletBalance(target.walletId)).toBe("100.00");
        const [counts] = await sql<{ transactions: string; entries: string; outbox: string }>(
            `select
                (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET') as transactions,
                (select count(*) from wallet_ledger_entries where wallet_id = ?) as entries,
                (select count(*) from outbox_messages) as outbox`,
            [target.walletId, target.walletId],
        );
        expect(counts).toEqual({ transactions: "0", entries: "1", outbox: "0" });
        await assertLedgerInvariant(target.walletId);
    });

    test("events are only visible to the publisher after commit", async () => {
        const target = await createWallet();
        await submitUseCase(unitOfWork).execute(betCommand(target));

        const result = await publishUseCase(unitOfWork, eventsPublisher()).execute();
        expect(result.published).toBe(2);

        const received = await drainQueue(queues.eventsQueueUrl, { expected: 2 });
        expect(received.map((message) => message.body.eventType).sort()).toEqual([
            "WagerTransactionProcessed",
            "WalletBalanceChanged",
        ]);
        expect(received.every((message) => message.attributes.MessageGroupId === target.walletId)).toBe(true);
        expect(received.every((message) => message.messageAttributes.eventType === message.body.eventType)).toBe(true);
        expect(await pendingOutbox()).toBe(0);
    });

    test("two concurrent publishers never claim the same message", async () => {
        const target = await createWallet("10000.00");
        for (let index = 0; index < 100; index += 1) {
            await submitUseCase(unitOfWork).execute(betCommand(target, "1.00"));
        }
        expect(await pendingOutbox()).toBe(200);

        const secondOrm = await MikroORM.init(createMikroOrmConfig(testEnvironment({ DB_POOL_MAX: "5" })));
        const publishers = [
            publishUseCase(unitOfWork, eventsPublisher(), 15),
            publishUseCase(unitOfWorkFor(secondOrm), eventsPublisher(createSqsClient(testEnvironment())), 15),
        ];
        const claims: string[][] = [[], []];
        try {
            await Promise.all(
                publishers.map(async (publisher, index) => {
                    for (;;) {
                        const result = await publisher.execute();
                        if (result.claimed.length === 0) {
                            return;
                        }
                        claims[index]?.push(...result.claimed);
                    }
                }),
            );
        } finally {
            await secondOrm.close(true);
        }

        const [first = [], second = []] = claims;
        expect(first.length).toBeGreaterThan(0);
        expect(second.length).toBeGreaterThan(0);
        expect(first.filter((id) => second.includes(id))).toEqual([]);
        expect(first.length + second.length).toBe(200);
        expect(await pendingOutbox()).toBe(0);

        const received = await drainQueue(queues.eventsQueueUrl, { expected: 200, timeoutMs: 30_000 });
        expect(new Set(received.map((message) => message.body.eventId)).size).toBe(200);
    });

    test("a broker outage keeps events pending with backoff", async () => {
        const target = await createWallet();
        await submitUseCase(unitOfWork).execute(betCommand(target));
        const deadBroker = createSqsClient(testEnvironment({ AWS_ENDPOINT_URL: "http://127.0.0.1:1" }));

        const result = await publishUseCase(unitOfWork, eventsPublisher(deadBroker)).execute();

        expect(result).toMatchObject({ published: 0, failed: 2 });
        const rows = await sql<{ attempts: number; due_in_ms: number; last_error: string | null }>(
            "select attempts, extract(epoch from (next_attempt_at - now())) * 1000 as due_in_ms, last_error from outbox_messages",
        );
        expect(rows.length).toBe(2);
        expect(rows.every((row) => row.attempts === 1 && Number(row.due_in_ms) > 0 && row.last_error)).toBe(true);
        expect((await publishUseCase(unitOfWork, eventsPublisher()).execute()).claimed.length).toBe(0);
    });
});

describe("outbox crash recovery", () => {
    test("an event committed by a process that died before publishing is published by another instance", async () => {
        const writer = await AppProcess.start({
            env: { ...queues.env, OUTBOX_PUBLISHER_ENABLED: "false", SQS_CONSUMER_ENABLED: "false" },
        });
        const wallet = await writer.http?.createWallet("100.00");
        if (!wallet || !writer.http) throw new Error("writer not started");
        const bet = await writer.http.submit(bettingPayload(wallet.body.id, wallet.body.playerId));
        expect(bet.status).toBe(200);
        await writer.stop("SIGKILL");
        expect(await pendingOutbox()).toBe(4);

        const publisher = await AppProcess.start({
            http: false,
            env: { ...queues.env, SQS_CONSUMER_ENABLED: "false", PENDING_REFERENCE_WORKER_ENABLED: "false" },
        });
        try {
            await eventually(pendingOutbox, (pending) => pending === 0);
        } finally {
            await publisher.stop("SIGKILL");
        }
        const received = await drainQueue(queues.eventsQueueUrl, { expected: 4 });
        expect(received.map((message) => message.body.eventType).sort()).toEqual([
            "WagerTransactionProcessed",
            "WagerTransactionProcessed",
            "WalletBalanceChanged",
            "WalletBalanceChanged",
        ]);
    });

    test("a publisher that dies after sending but before committing causes a safe duplicate", async () => {
        const target = await createWallet();
        await submitUseCase(unitOfWork).execute(betCommand(target));

        const crashing = await AppProcess.start({
            http: false,
            waitForStartup: false,
            env: {
                ...queues.env,
                SQS_CONSUMER_ENABLED: "false",
                PENDING_REFERENCE_WORKER_ENABLED: "false",
                FAULT_INJECTION: "crash-before-publish-commit",
            },
        });
        expect(await crashing.exited).toBe(FAULT_EXIT_CODE);
        expect(await pendingOutbox()).toBe(2);

        const recovering = await AppProcess.start({
            http: false,
            env: { ...queues.env, SQS_CONSUMER_ENABLED: "false", PENDING_REFERENCE_WORKER_ENABLED: "false" },
        });
        try {
            await eventually(pendingOutbox, (pending) => pending === 0);
        } finally {
            await recovering.stop("SIGKILL");
        }

        const received = await drainQueue(queues.eventsQueueUrl, { timeoutMs: 8_000 });
        const uniqueEvents = new Set(received.map((message) => message.body.eventId));
        expect(uniqueEvents.size).toBe(2);
        expect(received.length).toBeGreaterThanOrEqual(2);
    });
});
