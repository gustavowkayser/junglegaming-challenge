import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Cluster } from "../support/cluster.support";
import { sql, truncateAll } from "../support/database.support";
import { bettingPayload } from "../support/fixtures.support";
import { assertLedgerInvariant, ledgerEntries, walletBalance } from "../support/invariant.support";
import { assertEventsPublishedOnce, waitForQuiescence } from "../support/settlement.support";
import {
    createTestQueues,
    deleteTestQueues,
    drainQueue,
    sendWagerMessage,
    type TestQueues,
} from "../support/sqs.support";

const money = (amount: string) => ({ amount, currency: "BRL" });

let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
    await truncateAll();
    queues = await createTestQueues({ visibilityTimeoutSeconds: 5 });
    cluster = await Cluster.start(3, queues.env);
});

afterAll(async () => {
    await cluster.stop();
    await deleteTestQueues(queues);
});

beforeEach(async () => {
    await waitForQuiescence(queues);
    await drainQueue(queues.eventsQueueUrl, { idleMs: 2_000 });
    await truncateAll();
});

async function wallet(amount: string) {
    const response = await cluster.createWallet(amount);
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId: response.body.playerId };
}

describe("three application instances", () => {
    test("the same BET sent 50 times across instances debits exactly once", async () => {
        const target = await wallet("1000.00");
        const bet = bettingPayload(target.walletId, target.playerId, { money: money("25.00") });

        const responses = await Promise.all(Array.from({ length: 50 }, () => cluster.next().submit(bet)));

        expect(responses.filter((response) => response.status !== 200).map((response) => response.body)).toEqual([]);
        expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
        expect(responses.filter((response) => !response.body.idempotentReplay).length).toBe(1);
        expect(await walletBalance(target.walletId)).toBe("975.00");
        await assertLedgerInvariant(target.walletId);
    });

    test("two 80.00 BETs on different instances: one processed, one rejected", async () => {
        const target = await wallet("100.00");
        const [first, second] = cluster.live;
        const responses = await Promise.all([
            first?.http?.submit(bettingPayload(target.walletId, target.playerId, { money: money("80.00") })),
            second?.http?.submit(bettingPayload(target.walletId, target.playerId, { money: money("80.00") })),
        ]);

        expect(responses.map((response) => response?.body.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
        expect(await walletBalance(target.walletId)).toBe("20.00");
        expect((await ledgerEntries(target.walletId)).filter((entry) => entry.direction === "DEBIT").length).toBe(1);
    });

    test("300 SQS messages with duplicates and out-of-order reversals converge on every instance", async () => {
        const wallets = await Promise.all(Array.from({ length: 10 }, () => wallet("1000.00")));
        const envelope = (data: Record<string, unknown>) => ({
            messageId: `msg-${randomUUID()}`,
            data: {
                ...data,
                idempotencyKey: `${String(data.providerId)}:${String(data.externalTransactionId)}`,
            } as Record<string, unknown>,
        });
        const reversalsFirst: ReturnType<typeof envelope>[] = [];
        const bets: ReturnType<typeof envelope>[] = [];
        for (const target of wallets) {
            const walletBets = Array.from({ length: 25 }, () =>
                envelope(bettingPayload(target.walletId, target.playerId, { money: money("1.00") })),
            );
            for (const refunded of walletBets.slice(0, 2)) {
                reversalsFirst.push(
                    envelope(
                        bettingPayload(target.walletId, target.playerId, {
                            kind: "REFUND",
                            money: money("1.00"),
                            referenceExternalTransactionId: refunded.data.externalTransactionId,
                        }),
                    ),
                );
            }
            bets.push(...walletBets);
        }
        const duplicates = bets.filter((_, index) => index % 8 === 0).slice(0, 30);

        for (const message of [...reversalsFirst, ...bets]) {
            await sendWagerMessage(queues.wagerQueueUrl, message);
        }
        for (const message of duplicates) {
            await sendWagerMessage(queues.wagerQueueUrl, message, { deduplicationId: randomUUID() });
        }
        expect(reversalsFirst.length + bets.length + duplicates.length).toBe(300);

        await waitForQuiescence(queues, 120_000);

        for (const target of wallets) {
            expect(await walletBalance(target.walletId)).toBe("977.00");
        }
        await assertLedgerInvariant();
        const [counts] = await sql<{ inbox: string; processed: string; entries: string }>(
            `select
                (select count(*) from inbox_messages) as inbox,
                (select count(*) from wager_transactions where status = 'PROCESSED' and kind <> 'OPENING') as processed,
                (select count(*) from wallet_ledger_entries) as entries`,
        );
        expect(counts).toEqual({ inbox: "270", processed: "270", entries: "280" });
        const handledBy = new Set(
            cluster.live.filter((instance) => instance.hasLog("message.acked")).map((instance) => instance.pid),
        );
        expect(handledBy.size).toBeGreaterThan(1);
        await assertEventsPublishedOnce(queues);
    });
});
