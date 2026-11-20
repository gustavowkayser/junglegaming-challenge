import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "../../support/app.support";
import { testOrm, truncateAll } from "../../support/database.support";
import { bettingPayload } from "../../support/fixtures.support";

let testApp: TestApp;

beforeAll(async () => {
    testApp = await startTestApp();
});

afterAll(async () => {
    await testApp.close();
});

beforeEach(truncateAll);

const money = (amount: string) => ({ amount, currency: "BRL" });

interface Report {
    walletId: string;
    storedBalance: { amount: string };
    calculatedBalance: { amount: string };
    difference: { amount: string };
    consistent: boolean;
    checkedEntries: number;
    checks: Record<string, boolean>;
}

async function metricValue(name: string, labels: Record<string, string> = {}): Promise<number> {
    const response = await testApp.http.get<string>("/metrics");
    const selector = Object.entries(labels)
        .map(([key, value]) => `${key}="${value}"`)
        .sort();
    const line = response.body.split("\n").find((candidate) => {
        if (!candidate.startsWith(`${name}{`) && !candidate.startsWith(`${name} `)) {
            return false;
        }
        const labelPart = candidate.slice(name.length).split(" ")[0] ?? "";
        return selector.every((pair) => labelPart.includes(pair));
    });
    return line ? Number(line.split(" ").at(-1)) : 0;
}

async function tamper(walletId: string) {
    const orm = await testOrm();
    await orm.em.fork().transactional(async (em) => {
        await em.execute("set local session_replication_role = replica");
        await em.execute("update wallets set balance = balance + 1 where id = ?", [walletId]);
    });
}

describe("POST /wallets/:walletId/reconciliation", () => {
    test("reports a consistent wallet", async () => {
        const wallet = await testApp.http.createWallet("1000.00");
        for (const amount of ["25.00", "10.00"]) {
            await testApp.http.submit(bettingPayload(wallet.body.id, wallet.body.playerId, { money: money(amount) }));
        }

        const response = await testApp.http.post<Report>(`/wallets/${wallet.body.id}/reconciliation`, {});

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            walletId: wallet.body.id,
            storedBalance: money("965.00"),
            calculatedBalance: money("965.00"),
            difference: money("0.00"),
            consistent: true,
            checkedEntries: 3,
        });
    });

    test("flags a divergence without correcting it and counts it in metrics", async () => {
        const wallet = await testApp.http.createWallet("100.00");
        const before = await metricValue("wagering_reconciliations_total", { consistent: "false" });
        await tamper(wallet.body.id);

        const response = await testApp.http.post<Report>(`/wallets/${wallet.body.id}/reconciliation`, {});

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            storedBalance: money("101.00"),
            calculatedBalance: money("100.00"),
            difference: money("1.00"),
            consistent: false,
            checks: { ledgerSumMatchesBalance: false, lastEntryMatchesBalance: false, lastEntryMatchesVersion: true },
        });
        expect(
            (await testApp.http.get<{ balance: { amount: string } }>(`/wallets/${wallet.body.id}`)).body.balance,
        ).toEqual(money("101.00"));
        expect(await metricValue("wagering_reconciliations_total", { consistent: "false" })).toBe(before + 1);
    });

    test("unknown wallets return 404", async () => {
        expect((await testApp.http.post(`/wallets/${randomUUID()}/reconciliation`, {})).status).toBe(404);
    });
});

describe("GET /metrics", () => {
    test("exposes transaction, duplicate, latency and outbox metrics", async () => {
        const wallet = await testApp.http.createWallet("100.00");
        const bet = bettingPayload(wallet.body.id, wallet.body.playerId, { money: money("10.00") });
        const processedBefore = await metricValue("wagering_transactions_total", {
            kind: "BET",
            status: "PROCESSED",
            source: "http",
        });
        const duplicatesBefore = await metricValue("wagering_duplicates_total", {
            source: "http",
            layer: "idempotency",
        });

        await testApp.http.submit(bet);
        await testApp.http.submit(bet);

        expect(
            await metricValue("wagering_transactions_total", { kind: "BET", status: "PROCESSED", source: "http" }),
        ).toBe(processedBefore + 1);
        expect(await metricValue("wagering_duplicates_total", { source: "http", layer: "idempotency" })).toBe(
            duplicatesBefore + 1,
        );
        expect(await metricValue("wagering_processing_duration_seconds_count", { source: "http" })).toBeGreaterThan(0);
        expect(await metricValue("wagering_outbox_pending")).toBe(4);
        expect(await metricValue("wagering_outbox_lag_seconds")).toBeGreaterThanOrEqual(0);

        const scrape = await testApp.http.get<string>("/metrics");
        expect(scrape.headers.get("content-type")).toContain("text/plain");
        for (const name of [
            "wagering_retries_total",
            "wagering_dlq_messages_total",
            "wagering_lock_conflicts_total",
            "wagering_outbox_published_total",
            "process_cpu_seconds_total",
        ]) {
            expect(scrape.body).toContain(`# TYPE ${name}`);
        }
    });
});
