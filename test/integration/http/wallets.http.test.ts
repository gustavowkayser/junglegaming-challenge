import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "../../support/app.support";
import { sql, truncateAll } from "../../support/database.support";
import { bettingPayload } from "../../support/fixtures.support";
import { assertLedgerInvariant } from "../../support/invariant.support";

let testApp: TestApp;

beforeAll(async () => {
    testApp = await startTestApp();
});

afterAll(async () => {
    await testApp.close();
});

beforeEach(truncateAll);

describe("POST /wallets", () => {
    test("creates a wallet with an OPENING credit in the same transaction", async () => {
        const playerId = randomUUID();
        const response = await testApp.http.createWallet("1000.00", playerId);

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            id: expect.any(String),
            playerId,
            balance: { amount: "1000.00", currency: "BRL" },
            version: 1,
        });
        const transactions = await sql<{ kind: string; status: string }>(
            "select kind, status from wager_transactions where wallet_id = ?",
            [response.body.id],
        );
        expect(transactions).toEqual([{ kind: "OPENING", status: "PROCESSED" }]);
        const outbox = await sql<{ event_type: string }>(
            "select event_type from outbox_messages where aggregate_id = ? order by event_type",
            [response.body.id],
        );
        expect(outbox.map((row) => row.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
        await assertLedgerInvariant(response.body.id);
    });

    test("a zero initial balance creates no ledger entry nor events", async () => {
        const response = await testApp.http.createWallet("0");

        expect(response.status).toBe(201);
        expect(response.body.balance).toEqual({ amount: "0.00", currency: "BRL" });
        const [counts] = await sql<{ entries: string; outbox: string }>(
            "select (select count(*) from wallet_ledger_entries) as entries, (select count(*) from outbox_messages) as outbox",
        );
        expect(counts).toEqual({ entries: "0", outbox: "0" });
        await assertLedgerInvariant(response.body.id);
    });

    test("a second wallet for the same player and currency is a conflict", async () => {
        const playerId = randomUUID();
        await testApp.http.createWallet("10.00", playerId);
        const duplicate = await testApp.http.post<{ error: { code: string } }>("/wallets", {
            playerId,
            initialBalance: { amount: "20.00", currency: "BRL" },
        });

        expect(duplicate.status).toBe(409);
        expect(duplicate.body.error.code).toBe("WALLET_ALREADY_EXISTS");
        expect((await testApp.http.createWallet("20.00", playerId, "USD")).status).toBe(201);
    });

    test.each([
        [{ playerId: "not-a-uuid", initialBalance: { amount: "1.00", currency: "BRL" } }],
        [{ playerId: randomUUID(), initialBalance: { amount: 1, currency: "BRL" } }],
        [{ playerId: randomUUID(), initialBalance: { amount: "1.001", currency: "BRL" } }],
        [{ playerId: randomUUID(), initialBalance: { amount: "-1.00", currency: "BRL" } }],
        [{ playerId: randomUUID(), initialBalance: { amount: "1e3", currency: "BRL" } }],
        [{ playerId: randomUUID(), initialBalance: { amount: "1.00", currency: "brl" } }],
        [{ playerId: randomUUID() }],
    ])("rejects invalid payload %#", async (body) => {
        const response = await testApp.http.post<{ error: { code: string } }>("/wallets", body);

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_FAILED");
    });

    test("rejects malformed JSON", async () => {
        const response = await testApp.http.post<{ error: { code: string } }>("/wallets", "{not json");

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_FAILED");
    });
});

describe("GET /wallets/:walletId", () => {
    test("returns the wallet", async () => {
        const created = await testApp.http.createWallet("50.00");
        const response = await testApp.http.get(`/wallets/${created.body.id}`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual(created.body);
    });

    test("returns 404 for unknown or malformed ids", async () => {
        expect((await testApp.http.get(`/wallets/${randomUUID()}`)).status).toBe(404);
        const malformed = await testApp.http.get<{ error: { code: string } }>("/wallets/nope");
        expect(malformed.status).toBe(404);
        expect(malformed.body.error.code).toBe("WALLET_NOT_FOUND");
    });
});

describe("GET /wallets/:walletId/ledger", () => {
    test("paginates with a stable opaque cursor", async () => {
        const wallet = await testApp.http.createWallet("100.00");
        for (let index = 0; index < 4; index += 1) {
            const response = await testApp.http.submit(
                bettingPayload(wallet.body.id, wallet.body.playerId, { money: { amount: "5.00", currency: "BRL" } }),
            );
            expect(response.status).toBe(200);
        }

        type Page = { items: { walletVersion: number; direction: string }[]; nextCursor: string | null };
        const first = await testApp.http.get<Page>(`/wallets/${wallet.body.id}/ledger?limit=2`);
        expect(first.status).toBe(200);
        expect(first.body.items.map((item) => item.walletVersion)).toEqual([1, 2]);
        expect(first.body.nextCursor).toEqual(expect.any(String));

        const second = await testApp.http.get<Page>(
            `/wallets/${wallet.body.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
        );
        expect(second.body.items.map((item) => item.walletVersion)).toEqual([3, 4]);

        const third = await testApp.http.get<Page>(
            `/wallets/${wallet.body.id}/ledger?limit=2&cursor=${second.body.nextCursor}`,
        );
        expect(third.body.items.map((item) => item.walletVersion)).toEqual([5]);
        expect(third.body.nextCursor).toBeNull();

        const replayed = await testApp.http.get<Page>(
            `/wallets/${wallet.body.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
        );
        expect(replayed.body).toEqual(second.body);
    });

    test("rejects invalid cursors and limits", async () => {
        const wallet = await testApp.http.createWallet("1.00");

        expect((await testApp.http.get(`/wallets/${wallet.body.id}/ledger?cursor=garbage`)).status).toBe(400);
        expect((await testApp.http.get(`/wallets/${wallet.body.id}/ledger?limit=0`)).status).toBe(400);
        expect((await testApp.http.get(`/wallets/${wallet.body.id}/ledger?limit=201`)).status).toBe(400);
        expect((await testApp.http.get(`/wallets/${randomUUID()}/ledger`)).status).toBe(404);
    });
});

describe("observability", () => {
    test("echoes or generates a correlation id", async () => {
        const echoed = await testApp.http.get("/health/live", { "x-correlation-id": "corr-123" });
        expect(echoed.headers.get("x-correlation-id")).toBe("corr-123");

        const generated = await testApp.http.get("/health/live");
        expect(generated.headers.get("x-correlation-id")).toEqual(expect.any(String));
    });

    test("readiness reports PostgreSQL", async () => {
        const response = await testApp.http.get<{ status: string; info: Record<string, unknown> }>("/health/ready");

        expect(response.status).toBe(200);
        expect(response.body.info.postgres).toBeDefined();
    });
});
