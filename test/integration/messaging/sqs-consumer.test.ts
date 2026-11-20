import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { FAULT_EXIT_CODE } from "../../../src/infrastructure/system/env-fault-injector.adapter";
import { startTestApp, type TestApp } from "../../support/app.support";
import { AppProcess, eventually } from "../../support/app-process.support";
import { sql, testOrm, truncateAll } from "../../support/database.support";
import { bettingPayload } from "../../support/fixtures.support";
import { assertLedgerInvariant, ledgerEntries, walletBalance } from "../../support/invariant.support";
import {
    createTestQueues,
    deleteTestQueues,
    drainQueue,
    queueDepth,
    sendWagerMessage,
    type TestQueues,
} from "../../support/sqs.support";

const money = (amount: string) => ({ amount, currency: "BRL" });

let queues: TestQueues;
let testApp: TestApp;

beforeAll(async () => {
    queues = await createTestQueues({ maxReceiveCount: 2, visibilityTimeoutSeconds: 2 });
    testApp = await startTestApp({
        ...queues.env,
        SQS_CONSUMER_ENABLED: "true",
        SQS_WAIT_TIME_SECONDS: "1",
        DB_LOCK_TIMEOUT_MS: "500",
    });
});

afterAll(async () => {
    await testApp.close();
    await deleteTestQueues(queues);
});

beforeEach(truncateAll);

async function wallet(amount = "100.00", http = testApp.http) {
    const response = await http.createWallet(amount);
    return { walletId: response.body.id, playerId: response.body.playerId };
}

function message(target: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    const data = bettingPayload(target.walletId, target.playerId, overrides);
    return {
        messageId: `msg-${randomUUID()}`,
        data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
    };
}

async function inboxRows() {
    return sql<{ message_id: string; processed: boolean }>(
        "select message_id, processed_at is not null as processed from inbox_messages order by received_at",
    );
}

async function settled(queueUrl: string) {
    await eventually(
        () => queueDepth(queueUrl),
        (depth) => depth.visible === 0 && depth.inFlight === 0,
        20_000,
        200,
    );
}

describe("SQS consumer", () => {
    test("processes a message, records the inbox and deletes it after commit", async () => {
        const target = await wallet();
        const envelope = message(target, { money: money("30.00") });
        await sendWagerMessage(queues.wagerQueueUrl, envelope);

        await eventually(
            () => walletBalance(target.walletId),
            (balance) => balance === "70.00",
        );
        await settled(queues.wagerQueueUrl);
        expect(await inboxRows()).toEqual([{ message_id: envelope.messageId, processed: true }]);
        const [transaction] = await sql<{ status: string }>(
            "select status from wager_transactions where external_transaction_id = ?",
            [envelope.data.externalTransactionId],
        );
        expect(transaction?.status).toBe("PROCESSED");
        await assertLedgerInvariant(target.walletId);
    });

    test("a redelivered message id is deduplicated by the inbox", async () => {
        const target = await wallet();
        const envelope = message(target, { money: money("10.00") });
        await sendWagerMessage(queues.wagerQueueUrl, envelope, { deduplicationId: randomUUID() });
        await sendWagerMessage(queues.wagerQueueUrl, envelope, { deduplicationId: randomUUID() });

        await settled(queues.wagerQueueUrl);
        expect(await walletBalance(target.walletId)).toBe("90.00");
        expect((await inboxRows()).length).toBe(1);
        expect((await ledgerEntries(target.walletId)).filter((entry) => entry.direction === "DEBIT").length).toBe(1);
    });

    test("a new message carrying an already processed idempotency key is replayed", async () => {
        const target = await wallet();
        const first = message(target, { money: money("10.00") });
        await sendWagerMessage(queues.wagerQueueUrl, first);
        await sendWagerMessage(queues.wagerQueueUrl, { ...first, messageId: `msg-${randomUUID()}` });

        await settled(queues.wagerQueueUrl);
        expect(await walletBalance(target.walletId)).toBe("90.00");
        expect((await inboxRows()).map((row) => row.processed)).toEqual([true, true]);
    });

    test("HTTP and SQS share the same idempotency", async () => {
        const target = await wallet();
        const envelope = message(target, { money: money("15.00") });
        const { idempotencyKey, ...payload } = envelope.data;
        const http = await testApp.http.submit(payload, idempotencyKey);
        expect(http.status).toBe(200);

        await sendWagerMessage(queues.wagerQueueUrl, envelope);
        await settled(queues.wagerQueueUrl);

        expect(await walletBalance(target.walletId)).toBe("85.00");
        expect(await inboxRows()).toEqual([{ message_id: envelope.messageId, processed: true }]);
    });

    test("the same message id with a different payload goes to the DLQ", async () => {
        const target = await wallet();
        const envelope = message(target, { money: money("10.00") });
        await sendWagerMessage(queues.wagerQueueUrl, envelope);
        await settled(queues.wagerQueueUrl);
        await sendWagerMessage(
            queues.wagerQueueUrl,
            { ...envelope, data: { ...envelope.data, money: money("99.00") } },
            { deduplicationId: randomUUID() },
        );

        const [dead] = await drainQueue(queues.wagerDlqUrl, { expected: 1, timeoutMs: 15_000 });
        expect(dead?.messageAttributes.deadLetterReason).toBe("INBOX_PAYLOAD_MISMATCH");
        expect(await walletBalance(target.walletId)).toBe("90.00");
    });

    test.each([
        ["malformed JSON", "{not json"],
        ["missing fields", JSON.stringify({ messageId: "m-1", type: "WagerTransactionRequested", data: {} })],
        [
            "wrong type",
            JSON.stringify({ messageId: "m-2", type: "Other", occurredAt: new Date().toISOString(), data: {} }),
        ],
    ])("%s is dead-lettered immediately", async (_name, rawBody) => {
        await sendWagerMessage(
            queues.wagerQueueUrl,
            { messageId: randomUUID(), data: { walletId: "invalid" } },
            { rawBody },
        );

        const [dead] = await drainQueue(queues.wagerDlqUrl, { expected: 1, timeoutMs: 15_000 });
        expect(dead?.messageAttributes.deadLetterReason).toBe("INVALID_MESSAGE");
        expect(await inboxRows()).toEqual([]);
    });

    test("the internal OPENING kind is rejected as an invalid message", async () => {
        const target = await wallet();
        await sendWagerMessage(queues.wagerQueueUrl, message(target, { kind: "OPENING" }));

        const [dead] = await drainQueue(queues.wagerDlqUrl, { expected: 1, timeoutMs: 15_000 });
        expect(dead?.messageAttributes.deadLetterReason).toBe("INVALID_MESSAGE");
        expect(await walletBalance(target.walletId)).toBe("100.00");
    });

    test("business rejections are acked, persisted and not retried", async () => {
        const target = await wallet("5.00");
        const envelope = message(target, { money: money("50.00") });
        await sendWagerMessage(queues.wagerQueueUrl, envelope);
        await sendWagerMessage(queues.wagerQueueUrl, message({ walletId: randomUUID(), playerId: randomUUID() }));

        await settled(queues.wagerQueueUrl);
        expect((await queueDepth(queues.wagerDlqUrl)).visible).toBe(0);
        const [transaction] = await sql<{ status: string; failure_code: string }>(
            "select status, failure_code from wager_transactions where external_transaction_id = ?",
            [envelope.data.externalTransactionId],
        );
        expect(transaction).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    });

    test("a transient failure is retried with backoff and then succeeds", async () => {
        const target = await wallet();
        const orm = await testOrm();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const locker = orm.em.fork().transactional(async (em) => {
            await em.execute("select id from wallets where id = ? for update", [target.walletId]);
            await held;
        });
        await Bun.sleep(100);

        await sendWagerMessage(queues.wagerQueueUrl, message(target, { money: money("20.00") }));
        await Bun.sleep(1500);
        expect(await walletBalance(target.walletId)).toBe("100.00");
        release();
        await locker;

        await eventually(
            () => walletBalance(target.walletId),
            (balance) => balance === "80.00",
            15_000,
        );
        await settled(queues.wagerQueueUrl);
        await assertLedgerInvariant(target.walletId);
    });

    test("a message that keeps failing transiently ends in the DLQ after the receive limit", async () => {
        const target = await wallet();
        const orm = await testOrm();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const locker = orm.em.fork().transactional(async (em) => {
            await em.execute("select id from wallets where id = ? for update", [target.walletId]);
            await held;
        });
        await Bun.sleep(100);

        try {
            await sendWagerMessage(queues.wagerQueueUrl, message(target, { money: money("20.00") }));
            const [dead] = await drainQueue(queues.wagerDlqUrl, { expected: 1, timeoutMs: 20_000 });
            expect(dead?.messageAttributes.deadLetterReason).toBe("RETRIES_EXHAUSTED");
        } finally {
            release();
            await locker;
        }
        expect(await walletBalance(target.walletId)).toBe("100.00");
    });
});

describe("SQS consumer crash recovery", () => {
    let isolated: TestQueues;

    beforeAll(async () => {
        isolated = await createTestQueues({ maxReceiveCount: 5, visibilityTimeoutSeconds: 2 });
    });

    afterAll(async () => {
        await deleteTestQueues(isolated);
    });

    test("a worker that dies after commit and before ack does not duplicate the debit", async () => {
        const target = await wallet();
        const envelope = message(target, { money: money("25.00") });
        const processEnv = { ...isolated.env, SQS_WAIT_TIME_SECONDS: "1", OUTBOX_PUBLISHER_ENABLED: "false" };

        const crashing = await AppProcess.start({
            http: false,
            env: { ...processEnv, FAULT_INJECTION: "crash-after-commit" },
        });
        await sendWagerMessage(isolated.wagerQueueUrl, envelope);
        expect(await crashing.exited).toBe(FAULT_EXIT_CODE);
        expect(await walletBalance(target.walletId)).toBe("75.00");
        expect((await queueDepth(isolated.wagerQueueUrl)).inFlight).toBe(1);

        const recovering = await AppProcess.start({ http: false, env: processEnv });
        try {
            await settled(isolated.wagerQueueUrl);
        } finally {
            await recovering.stop("SIGKILL");
        }
        expect(recovering.hasLog('"replay":true')).toBe(true);
        expect(await walletBalance(target.walletId)).toBe("75.00");
        expect((await ledgerEntries(target.walletId)).filter((entry) => entry.direction === "DEBIT").length).toBe(1);
        await assertLedgerInvariant(target.walletId);
    });

    test.skipIf(process.platform === "win32")("SIGTERM finishes in-flight messages and releases the rest", async () => {
        const targets = await Promise.all(Array.from({ length: 4 }, () => wallet("1000.00")));
        const processEnv = {
            ...isolated.env,
            SQS_WAIT_TIME_SECONDS: "1",
            SQS_VISIBILITY_TIMEOUT_SECONDS: "30",
            OUTBOX_PUBLISHER_ENABLED: "false",
        };
        const first = await AppProcess.start({ http: false, env: processEnv });
        for (let index = 0; index < 40; index += 1) {
            const target = targets[index % targets.length];
            if (target) {
                await sendWagerMessage(isolated.wagerQueueUrl, message(target, { money: money("1.00") }));
            }
        }
        await first.waitForLog("message.acked", 15_000);
        first.kill("SIGTERM");
        expect(await first.exited).toBe(0);
        expect(first.hasLog("consumer.draining")).toBe(true);

        const second = await AppProcess.start({ http: false, env: processEnv });
        try {
            await eventually(
                async () => Number((await sql<{ c: string }>("select count(*) as c from inbox_messages"))[0]?.c),
                (count) => count === 40,
                20_000,
            );
        } finally {
            await second.stop("SIGKILL");
        }
        for (const target of targets) {
            expect(await walletBalance(target.walletId)).toBe("990.00");
            await assertLedgerInvariant(target.walletId);
        }
    });
});
