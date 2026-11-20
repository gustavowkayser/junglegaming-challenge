import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { UnitOfWork } from "../../../src/application/ports/unit-of-work.port";
import type { SubmitWagerTransactionCommand } from "../../../src/application/wagering/submit-wager-transaction.command";
import { type SubmittableKind, WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { startTestApp, type TestApp } from "../../support/app.support";
import { eventually } from "../../support/app-process.support";
import { sql, testOrm, truncateAll } from "../../support/database.support";
import { bettingPayload } from "../../support/fixtures.support";
import { assertLedgerInvariant, ledgerEntries, walletBalance } from "../../support/invariant.support";
import { createTestQueues, deleteTestQueues, sendWagerMessage, type TestQueues } from "../../support/sqs.support";
import {
    referencePolicy,
    resolveUseCase,
    seedWallet,
    submitUseCase,
    unitOfWorkFor,
} from "../../support/use-cases.support";

const fastPolicy = referencePolicy({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 });
let unitOfWork: UnitOfWork;

beforeAll(async () => {
    unitOfWork = unitOfWorkFor(await testOrm());
});

beforeEach(truncateAll);

const money = (amount: string) => ({ amount, currency: "BRL" });

function command(
    target: { walletId: string; playerId: string },
    kind: SubmittableKind,
    amount: string,
    overrides: Record<string, unknown> = {},
): SubmitWagerTransactionCommand {
    const payload = bettingPayload(target.walletId, target.playerId, { money: money(amount), ...overrides });
    return {
        ...payload,
        kind,
        idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
        source: "http",
        correlationId: randomUUID(),
    };
}

async function statusOf(transactionId: string) {
    const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number }>(
        "select status, failure_code, reference_attempts from wager_transactions where id = ?",
        [transactionId],
    );
    return row;
}

async function eventsFor(transactionId: string) {
    const rows = await sql<{ event_type: string }>(
        "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by occurred_at, event_type",
        [transactionId],
    );
    return rows.map((row) => row.event_type);
}

describe("pending reference resolution", () => {
    test("a REFUND that arrives before its BET is applied once the BET is processed", async () => {
        const target = await seedWallet(unitOfWork);
        const submit = submitUseCase(unitOfWork, fastPolicy);
        const bet = command(target, WagerTransactionKind.Bet, "40.00");
        const refund = command(target, WagerTransactionKind.Refund, "40.00", {
            referenceExternalTransactionId: bet.externalTransactionId,
        });

        const pending = await submit.execute(refund);
        expect(pending.status).toBe("PENDING_REFERENCE");
        expect(await eventsFor(pending.transactionId)).toEqual(["WagerTransactionPendingReference"]);

        expect((await submit.execute(bet)).balance).toEqual(money("60.00"));
        const reports = await resolveUseCase(unitOfWork, fastPolicy).execute();

        expect(reports).toEqual([{ transactionId: pending.transactionId, outcome: "processed" }]);
        expect((await statusOf(pending.transactionId))?.status).toBe("PROCESSED");
        expect(await walletBalance(target.walletId)).toBe("100.00");
        expect(await eventsFor(pending.transactionId)).toEqual([
            "WagerTransactionPendingReference",
            "WagerTransactionProcessed",
            "WalletBalanceChanged",
        ]);
        await assertLedgerInvariant(target.walletId);

        const replay = await submit.execute({ ...refund, correlationId: randomUUID() });
        expect(replay).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: money("100.00") });
    });

    test("processing the referenced transaction expedites its dependents", async () => {
        const target = await seedWallet(unitOfWork);
        const slowPolicy = referencePolicy({ baseDelayMs: 600_000, maxDelayMs: 600_000 });
        const submit = submitUseCase(unitOfWork, slowPolicy);
        const bet = command(target, WagerTransactionKind.Bet, "10.00");
        const refund = await submit.execute(
            command(target, WagerTransactionKind.Refund, "10.00", {
                referenceExternalTransactionId: bet.externalTransactionId,
            }),
        );
        expect(await resolveUseCase(unitOfWork, slowPolicy).execute()).toEqual([]);

        await submit.execute(bet);
        const reports = await resolveUseCase(unitOfWork, slowPolicy).execute();

        expect(reports).toEqual([{ transactionId: refund.transactionId, outcome: "processed" }]);
    });

    test("a reference that never arrives is rejected with REFERENCE_NOT_FOUND after the retry budget", async () => {
        const target = await seedWallet(unitOfWork);
        const refund = await submitUseCase(unitOfWork, fastPolicy).execute(
            command(target, WagerTransactionKind.Refund, "10.00", { referenceExternalTransactionId: "ghost-bet" }),
        );
        const resolver = resolveUseCase(unitOfWork, fastPolicy);

        const final = await eventually(
            async () => {
                await resolver.execute();
                return statusOf(refund.transactionId);
            },
            (row) => row?.status === "REJECTED",
            10_000,
            60,
        );

        expect(final).toEqual({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND", reference_attempts: 3 });
        expect(await eventsFor(refund.transactionId)).toEqual([
            "WagerTransactionPendingReference",
            "WagerTransactionRejected",
        ]);
        expect(await walletBalance(target.walletId)).toBe("100.00");
    });

    test("a ROLLBACK of a rejected BET is rejected as REFERENCE_NOT_PROCESSED", async () => {
        const target = await seedWallet(unitOfWork, "10.00");
        const submit = submitUseCase(unitOfWork, fastPolicy);
        const bet = command(target, WagerTransactionKind.Bet, "50.00");
        const rollback = await submit.execute(
            command(target, WagerTransactionKind.Rollback, "50.00", {
                referenceExternalTransactionId: bet.externalTransactionId,
            }),
        );
        expect((await submit.execute(bet)).failureCode).toBe("INSUFFICIENT_FUNDS");

        const [report] = await resolveUseCase(unitOfWork, fastPolicy).execute();

        expect(report).toEqual({
            transactionId: rollback.transactionId,
            outcome: "rejected",
            failureCode: "REFERENCE_NOT_PROCESSED",
        });
        expect(await walletBalance(target.walletId)).toBe("10.00");
    });

    test("concurrent resolvers apply each pending reversal exactly once", async () => {
        const target = await seedWallet(unitOfWork, "1000.00");
        const submit = submitUseCase(unitOfWork, fastPolicy);
        const bets = Array.from({ length: 20 }, () => command(target, WagerTransactionKind.Bet, "5.00"));
        const refunds = await Promise.all(
            bets.map((bet) =>
                submit.execute(
                    command(target, WagerTransactionKind.Refund, "5.00", {
                        referenceExternalTransactionId: bet.externalTransactionId,
                    }),
                ),
            ),
        );
        for (const bet of bets) {
            await submit.execute(bet);
        }

        const results = await Promise.all([
            resolveUseCase(unitOfWork, fastPolicy).execute(),
            resolveUseCase(unitOfWork, fastPolicy).execute(),
            resolveUseCase(unitOfWork, fastPolicy).execute(),
        ]);

        const processed = results.flat().filter((report) => report.outcome === "processed");
        expect(processed.length).toBe(20);
        expect(new Set(processed.map((report) => report.transactionId)).size).toBe(20);
        for (const refund of refunds) {
            expect((await statusOf(refund.transactionId))?.status).toBe("PROCESSED");
        }
        const credits = (await ledgerEntries(target.walletId)).filter((entry) => entry.direction === "CREDIT");
        expect(credits.length).toBe(21);
        expect(await walletBalance(target.walletId)).toBe("1000.00");
        await assertLedgerInvariant(target.walletId);
    });
});

describe("pending reference worker", () => {
    let queues: TestQueues;
    let testApp: TestApp;

    beforeAll(async () => {
        queues = await createTestQueues({ visibilityTimeoutSeconds: 2 });
        testApp = await startTestApp({
            ...queues.env,
            SQS_CONSUMER_ENABLED: "true",
            SQS_WAIT_TIME_SECONDS: "1",
            PENDING_REFERENCE_WORKER_ENABLED: "true",
            PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
            PENDING_REFERENCE_BASE_DELAY_MS: "200",
        });
    });

    afterAll(async () => {
        await testApp.close();
        await deleteTestQueues(queues);
    });

    test("a ROLLBACK delivered by SQS before its WIN is resolved automatically", async () => {
        const wallet = await testApp.http.createWallet("100.00");
        const target = { walletId: wallet.body.id, playerId: wallet.body.playerId };
        const win = bettingPayload(target.walletId, target.playerId, { kind: "WIN", money: money("30.00") });
        const rollback = bettingPayload(target.walletId, target.playerId, {
            kind: "ROLLBACK",
            money: money("30.00"),
            referenceExternalTransactionId: win.externalTransactionId,
        });
        const envelope = (data: Record<string, unknown>) => ({
            messageId: `msg-${randomUUID()}`,
            data: { ...data, idempotencyKey: `${String(data.providerId)}:${String(data.externalTransactionId)}` },
        });

        await sendWagerMessage(queues.wagerQueueUrl, envelope(rollback));
        await eventually(
            async () =>
                (
                    await sql<{ status: string }>(
                        "select status from wager_transactions where external_transaction_id = ?",
                        [rollback.externalTransactionId],
                    )
                )[0]?.status,
            (status) => status === "PENDING_REFERENCE",
        );
        await sendWagerMessage(queues.wagerQueueUrl, envelope(win));

        await eventually(
            async () =>
                (
                    await sql<{ status: string }>(
                        "select status from wager_transactions where external_transaction_id = ?",
                        [rollback.externalTransactionId],
                    )
                )[0]?.status,
            (status) => status === "PROCESSED",
        );
        expect(await walletBalance(target.walletId)).toBe("100.00");
        const directions = (await ledgerEntries(target.walletId)).map((entry) => entry.direction);
        expect(directions).toEqual(["CREDIT", "CREDIT", "DEBIT"]);
        await assertLedgerInvariant(target.walletId);
    });
});
