import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "../support/app.support";
import { sql, truncateAll } from "../support/database.support";
import { bettingPayload } from "../support/fixtures.support";
import { assertLedgerInvariant, ledgerEntries, walletBalance } from "../support/invariant.support";

let testApp: TestApp;

beforeAll(async () => {
    testApp = await startTestApp({ DB_POOL_MAX: "70" });
});

afterAll(async () => {
    await testApp.close();
});

beforeEach(truncateAll);

const money = (amount: string) => ({ amount, currency: "BRL" });

async function wallet(amount: string) {
    const response = await testApp.http.createWallet(amount);
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId: response.body.playerId };
}

describe("concurrency on a single wallet", () => {
    test("the same BET sent 50 times in parallel debits exactly once", async () => {
        const target = await wallet("1000.00");
        const bet = bettingPayload(target.walletId, target.playerId, { money: money("25.00") });

        const responses = await Promise.all(Array.from({ length: 50 }, () => testApp.http.submit(bet)));

        expect(responses.filter((response) => response.status !== 200).map((response) => response.body)).toEqual([]);
        expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
        expect(responses.filter((response) => !response.body.idempotentReplay).length).toBe(1);
        expect(responses.every((response) => response.body.balance?.amount === "975.00")).toBe(true);
        const entries = await ledgerEntries(target.walletId);
        expect(entries.filter((entry) => entry.direction === "DEBIT").length).toBe(1);
        expect(await walletBalance(target.walletId)).toBe("975.00");
        await assertLedgerInvariant(target.walletId);
    });

    test("two 80.00 BETs against 100.00: one processed, one rejected, retries change nothing", async () => {
        const target = await wallet("100.00");
        const first = bettingPayload(target.walletId, target.playerId, { money: money("80.00") });
        const second = bettingPayload(target.walletId, target.playerId, { money: money("80.00") });

        const responses = await Promise.all([testApp.http.submit(first), testApp.http.submit(second)]);
        const statuses = responses.map((response) => response.body.status).sort();

        expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
        const rejected = responses.find((response) => response.body.status === "REJECTED");
        expect(rejected?.status).toBe(422);
        expect(rejected?.body.failureCode).toBe("INSUFFICIENT_FUNDS");
        expect(await walletBalance(target.walletId)).toBe("20.00");

        const retries = await Promise.all(
            Array.from({ length: 10 }, (_, index) => testApp.http.submit(index % 2 === 0 ? first : second)),
        );
        expect(retries.every((response) => response.body.idempotentReplay)).toBe(true);
        const debits = (await ledgerEntries(target.walletId)).filter((entry) => entry.direction === "DEBIT");
        expect(debits.length).toBe(1);
        expect(await walletBalance(target.walletId)).toBe("20.00");
        await assertLedgerInvariant(target.walletId);
    });

    test("a hot wallet under mixed parallel load never loses an update", async () => {
        const target = await wallet("500.00");
        const operations = Array.from({ length: 100 }, (_, index) =>
            bettingPayload(target.walletId, target.playerId, {
                kind: index % 3 === 0 ? "WIN" : "BET",
                money: money(index % 3 === 0 ? "7.50" : "5.25"),
            }),
        );

        const responses = await Promise.all(operations.map((operation) => testApp.http.submit(operation)));

        expect(responses.filter((response) => response.status !== 200).map((response) => response.body)).toEqual([]);
        const wins = operations.filter((operation) => operation.kind === "WIN").length;
        const bets = operations.length - wins;
        const expected = (50_000 + wins * 750 - bets * 525) / 100;
        expect(await walletBalance(target.walletId)).toBe(expected.toFixed(2));
        const [row] = await sql<{ version: number }>("select version from wallets where id = ?", [target.walletId]);
        expect(row?.version).toBe(1 + operations.length);
        await assertLedgerInvariant(target.walletId);
    });

    test("parallel overdraft attempts never make the balance negative", async () => {
        const target = await wallet("50.00");
        const responses = await Promise.all(
            Array.from({ length: 30 }, () =>
                testApp.http.submit(bettingPayload(target.walletId, target.playerId, { money: money("7.00") })),
            ),
        );

        const processed = responses.filter((response) => response.body.status === "PROCESSED").length;
        const rejected = responses.filter((response) => response.body.failureCode === "INSUFFICIENT_FUNDS").length;
        expect(processed).toBe(7);
        expect(rejected).toBe(23);
        expect(await walletBalance(target.walletId)).toBe("1.00");
        await assertLedgerInvariant(target.walletId);
    });
});

describe("concurrency across wallets", () => {
    test("distinct wallets are processed in parallel without interference", async () => {
        const wallets = await Promise.all(Array.from({ length: 20 }, () => wallet("100.00")));
        const operations = wallets.flatMap((target) =>
            Array.from({ length: 10 }, (_, index) =>
                bettingPayload(target.walletId, target.playerId, { money: money(`${index + 1}.00`) }),
            ),
        );

        const responses = await Promise.all(operations.map((operation) => testApp.http.submit(operation)));

        expect(responses.filter((response) => response.status !== 200).map((response) => response.body)).toEqual([]);
        for (const target of wallets) {
            expect(await walletBalance(target.walletId)).toBe("45.00");
        }
        await assertLedgerInvariant();
    });
});
