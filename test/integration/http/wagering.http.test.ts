import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "../../support/app.support";
import { sql, truncateAll } from "../../support/database.support";
import { bettingPayload } from "../../support/fixtures.support";
import { assertLedgerInvariant, ledgerEntries, walletBalance } from "../../support/invariant.support";

let testApp: TestApp;

beforeAll(async () => {
    testApp = await startTestApp();
});

afterAll(async () => {
    await testApp.close();
});

beforeEach(truncateAll);

async function wallet(amount = "100.00") {
    const response = await testApp.http.createWallet(amount);
    return { walletId: response.body.id, playerId: response.body.playerId };
}

function payload(target: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    return bettingPayload(target.walletId, target.playerId, overrides);
}

const money = (amount: string) => ({ amount, currency: "BRL" });

describe("POST /wagering/transactions", () => {
    test("processes a BET", async () => {
        const target = await wallet("1000.00");
        const response = await testApp.http.submit(payload(target, { money: money("25.00") }));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            transactionId: expect.any(String),
            status: "PROCESSED",
            balance: money("975.00"),
            idempotentReplay: false,
        });
        await assertLedgerInvariant(target.walletId);
    });

    test("replays an identical request with the original result", async () => {
        const target = await wallet();
        const bet = payload(target, { money: money("30.00") });
        const first = await testApp.http.submit(bet);
        await testApp.http.submit(payload(target, { money: money("10.00") }));
        const replay = await testApp.http.submit({ ...bet, money: { currency: "BRL", amount: "30" } });

        expect(replay.status).toBe(200);
        expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
        expect(replay.body.balance).toEqual(money("70.00"));
        expect(await walletBalance(target.walletId)).toBe("60.00");
        expect((await ledgerEntries(target.walletId)).length).toBe(3);
    });

    test("the same idempotency key with a different payload is a conflict", async () => {
        const target = await wallet();
        const bet = payload(target, { money: money("30.00") });
        await testApp.http.submit(bet);
        const conflict = await testApp.http.submit({ ...bet, money: money("31.00") });

        expect(conflict.status).toBe(409);
        expect(conflict.body).toEqual({
            error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: expect.any(String) },
        } as never);
        expect(await walletBalance(target.walletId)).toBe("70.00");
    });

    test("reusing a provider transaction id under another key is a conflict", async () => {
        const target = await wallet();
        const bet = payload(target);
        await testApp.http.submit(bet);

        expect((await testApp.http.submit(bet, "another-key")).status).toBe(409);
    });

    test("requires the Idempotency-Key header", async () => {
        const target = await wallet();
        const response = await testApp.http.post<{ error: { code: string } }>(
            "/wagering/transactions",
            payload(target),
        );

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    test.each([
        ["OPENING kind", { kind: "OPENING" }],
        ["unknown kind", { kind: "JACKPOT" }],
        ["numeric amount", { money: { amount: 10, currency: "BRL" } }],
        ["three decimals", { money: money("10.001") }],
        ["negative amount", { money: money("-10.00") }],
        ["scientific notation", { money: money("1e2") }],
        ["unknown field", { extra: true }],
        ["invalid wallet id", { walletId: "wallet-1" }],
        ["BET with reference", { referenceExternalTransactionId: "x" }],
        ["REFUND without reference", { kind: "REFUND" }],
    ])("rejects %s with 400", async (_name, overrides) => {
        const target = await wallet();
        const response = await testApp.http.submit(payload(target, overrides));

        expect(response.status).toBe(400);
        expect((response.body as unknown as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
        expect(await walletBalance(target.walletId)).toBe("100.00");
    });

    test("an unknown wallet is a business rejection that is not persisted", async () => {
        const response = await testApp.http.submit(payload({ walletId: randomUUID(), playerId: randomUUID() }));

        expect(response.status).toBe(422);
        expect((response.body as unknown as { error: { code: string } }).error.code).toBe("WALLET_NOT_FOUND");
    });

    test("insufficient funds is rejected with 422 and replayed identically", async () => {
        const target = await wallet("10.00");
        const bet = payload(target, { money: money("10.01") });
        const rejected = await testApp.http.submit(bet);

        expect(rejected.status).toBe(422);
        expect(rejected.body).toEqual({
            transactionId: expect.any(String),
            status: "REJECTED",
            failureCode: "INSUFFICIENT_FUNDS",
            balance: money("10.00"),
            idempotentReplay: false,
        });
        const replay = await testApp.http.submit(bet);
        expect(replay.status).toBe(422);
        expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
        expect((await ledgerEntries(target.walletId)).length).toBe(1);
        const events = await sql<{ event_type: string }>(
            "select event_type from outbox_messages where payload->'data'->>'transactionId' = ?",
            [rejected.body.transactionId],
        );
        expect(events.map((row) => row.event_type)).toEqual(["WagerTransactionRejected"]);
    });

    test("currency conflicts are rejected", async () => {
        const target = await wallet();
        const response = await testApp.http.submit(payload(target, { money: { amount: "1.00", currency: "USD" } }));

        expect(response.status).toBe(422);
        expect(response.body.failureCode).toBe("CURRENCY_MISMATCH");
        await assertLedgerInvariant(target.walletId);
    });

    test("a player that does not own the wallet is rejected", async () => {
        const target = await wallet();
        const response = await testApp.http.submit(payload({ walletId: target.walletId, playerId: randomUUID() }));

        expect(response.status).toBe(422);
        expect(response.body.failureCode).toBe("WALLET_PLAYER_MISMATCH");
    });

    test("WIN credits, LOSS keeps the balance", async () => {
        const target = await wallet();
        const bet = payload(target, { money: money("20.00") });
        await testApp.http.submit(bet);
        const win = await testApp.http.submit(
            payload(target, {
                kind: "WIN",
                money: money("50.00"),
                referenceExternalTransactionId: bet.externalTransactionId,
            }),
        );
        const loss = await testApp.http.submit(payload(target, { kind: "LOSS", money: money("0.00") }));

        expect(win.status).toBe(200);
        expect(win.body.balance).toEqual(money("130.00"));
        expect(loss.status).toBe(200);
        expect(loss.body.status).toBe("PROCESSED");
        expect(loss.body.balance).toEqual(money("130.00"));
        expect((await ledgerEntries(target.walletId)).length).toBe(3);
        await assertLedgerInvariant(target.walletId);
    });

    test("REFUND reverses a BET once", async () => {
        const target = await wallet();
        const bet = payload(target, { money: money("40.00") });
        await testApp.http.submit(bet);
        const refund = payload(target, {
            kind: "REFUND",
            money: money("40.00"),
            referenceExternalTransactionId: bet.externalTransactionId,
        });
        const first = await testApp.http.submit(refund);
        const second = await testApp.http.submit(
            payload(target, {
                kind: "ROLLBACK",
                money: money("40.00"),
                referenceExternalTransactionId: bet.externalTransactionId,
            }),
        );

        expect(first.status).toBe(200);
        expect(first.body.balance).toEqual(money("100.00"));
        expect(second.status).toBe(422);
        expect(second.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
        expect(await walletBalance(target.walletId)).toBe("100.00");
        await assertLedgerInvariant(target.walletId);
    });

    test("ROLLBACK of a WIN that would overdraw is rejected with a distinct code", async () => {
        const target = await wallet("0");
        const win = payload(target, { kind: "WIN", money: money("50.00") });
        await testApp.http.submit(win);
        await testApp.http.submit(payload(target, { money: money("45.00") }));
        const rollback = await testApp.http.submit(
            payload(target, {
                kind: "ROLLBACK",
                money: money("50.00"),
                referenceExternalTransactionId: win.externalTransactionId,
            }),
        );

        expect(rollback.status).toBe(422);
        expect(rollback.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
        expect(await walletBalance(target.walletId)).toBe("5.00");
    });

    test("REFUND before its BET is accepted as PENDING_REFERENCE", async () => {
        const target = await wallet();
        const refund = await testApp.http.submit(
            payload(target, {
                kind: "REFUND",
                money: money("10.00"),
                referenceExternalTransactionId: "bet-not-yet-delivered",
            }),
        );

        expect(refund.status).toBe(202);
        expect(refund.body.status).toBe("PENDING_REFERENCE");
        expect(await walletBalance(target.walletId)).toBe("100.00");
        const events = await sql<{ event_type: string }>(
            "select event_type from outbox_messages where payload->'data'->>'transactionId' = ?",
            [refund.body.transactionId],
        );
        expect(events.map((row) => row.event_type)).toEqual(["WagerTransactionPendingReference"]);
    });
});

describe("transaction queries", () => {
    test("by internal id and by provider id", async () => {
        const target = await wallet();
        const bet = payload(target, { money: money("15.00") });
        const submitted = await testApp.http.submit(bet);

        const byId = await testApp.http.get(`/wagering/transactions/${submitted.body.transactionId}`);
        expect(byId.status).toBe(200);
        expect(byId.body).toMatchObject({
            transactionId: submitted.body.transactionId,
            providerId: "provider-a",
            externalTransactionId: bet.externalTransactionId,
            kind: "BET",
            status: "PROCESSED",
            money: money("15.00"),
            balance: money("85.00"),
        });

        const byProvider = await testApp.http.get(
            `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
        );
        expect(byProvider.status).toBe(200);
        expect(byProvider.body).toEqual(byId.body);
    });

    test("unknown transactions return 404", async () => {
        expect((await testApp.http.get(`/wagering/transactions/${randomUUID()}`)).status).toBe(404);
        expect((await testApp.http.get("/wagering/transactions/abc")).status).toBe(404);
        expect((await testApp.http.get("/providers/provider-a/wagering/transactions/missing")).status).toBe(404);
    });
});
