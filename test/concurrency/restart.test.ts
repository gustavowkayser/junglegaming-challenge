import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Cluster } from "../support/cluster.support";
import { sql, truncateAll } from "../support/database.support";
import { bettingPayload } from "../support/fixtures.support";
import { assertLedgerInvariant, walletBalance } from "../support/invariant.support";
import { assertEventsPublishedOnce, waitForQuiescence } from "../support/settlement.support";
import { createTestQueues, deleteTestQueues, sendWagerMessage, type TestQueues } from "../support/sqs.support";

const money = (amount: string) => ({ amount, currency: "BRL" });
const gracefulSignal = process.platform === "win32" ? "SIGKILL" : "SIGTERM";

let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
    await truncateAll();
    queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
    cluster = await Cluster.start(3, queues.env);
});

afterAll(async () => {
    await cluster.stop();
    await deleteTestQueues(queues);
});

test("instances killed and restarted under load leave every wallet consistent", async () => {
    const wallets = await Promise.all(
        Array.from({ length: 8 }, async () => {
            const response = await cluster.createWallet("1000.00");
            return { walletId: response.body.id, playerId: response.body.playerId };
        }),
    );
    const expectedDebits = new Map(wallets.map((target) => [target.walletId, 0]));
    const debit = (walletId: string, cents: number) =>
        expectedDebits.set(walletId, (expectedDebits.get(walletId) ?? 0) + cents);

    const httpLoad = Promise.all(
        Array.from({ length: 120 }, async (_, index) => {
            const target = wallets[index % wallets.length];
            if (!target) return;
            await Bun.sleep(index * 10);
            const response = await cluster.submitWithFailover(
                bettingPayload(target.walletId, target.playerId, { money: money("1.00") }),
            );
            expect(response.status).toBe(200);
            debit(target.walletId, 100);
        }),
    );

    const sqsLoad = (async () => {
        for (let index = 0; index < 120; index += 1) {
            const target = wallets[index % wallets.length];
            if (!target) continue;
            const bet = bettingPayload(target.walletId, target.playerId, { money: money("2.00") });
            const messages = [bet];
            if (index % 12 === 0) {
                messages.unshift(
                    bettingPayload(target.walletId, target.playerId, {
                        kind: "REFUND",
                        money: money("2.00"),
                        referenceExternalTransactionId: bet.externalTransactionId,
                    }),
                );
            } else {
                debit(target.walletId, 200);
            }
            for (const data of messages) {
                await sendWagerMessage(queues.wagerQueueUrl, {
                    messageId: `msg-${randomUUID()}`,
                    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
                });
            }
        }
    })();

    await Bun.sleep(400);
    await cluster.kill(0, "SIGKILL");
    await Bun.sleep(300);
    const gracefulExit = await cluster.kill(1, gracefulSignal);
    if (gracefulSignal === "SIGTERM") {
        expect(gracefulExit).toBe(0);
    }
    await Bun.sleep(500);
    await Promise.all([cluster.restart(0), cluster.restart(1)]);

    await Promise.all([httpLoad, sqsLoad]);
    await waitForQuiescence(queues, 120_000);

    for (const target of wallets) {
        const expected = (100_000 - (expectedDebits.get(target.walletId) ?? 0)) / 100;
        expect({ wallet: target.walletId, balance: await walletBalance(target.walletId) }).toEqual({
            wallet: target.walletId,
            balance: expected.toFixed(2),
        });
        const report = await cluster
            .next()
            .post<{ consistent: boolean }>(`/wallets/${target.walletId}/reconciliation`, {});
        expect(report.body.consistent).toBe(true);
    }
    await assertLedgerInvariant();
    const [counts] = await sql<{ processed: string; pending: string }>(
        `select
            count(*) filter (where status = 'PROCESSED' and kind <> 'OPENING') as processed,
            count(*) filter (where status not in ('PROCESSED', 'REJECTED', 'FAILED')) as pending
         from wager_transactions`,
    );
    expect(counts).toEqual({ processed: String(120 + 120 + 10), pending: "0" });
    await assertEventsPublishedOnce(queues);
});
