import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
    InvariantViolationError,
    TransientInfrastructureError,
    UniqueConstraintRaceError,
} from "../../../src/application/errors/application.error";
import { WagerTransactionProcessed } from "../../../src/domain/events/wager-transaction-processed.event";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message.entity";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message.entity";
import { FailureCode } from "../../../src/domain/wagering/failure-code.enum";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction.aggregate";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status.enum";
import type { Wallet } from "../../../src/domain/wallet/wallet.aggregate";
import { rejectionOf } from "../../support/assertions.support";
import { testUnitOfWork, truncateAll } from "../../support/database.support";
import { brl, newTransaction, openWallet } from "../../support/fixtures.support";
import { assertLedgerInvariant } from "../../support/invariant.support";

beforeEach(truncateAll);

async function persistOpenedWallet(amount = "100.00"): Promise<Wallet> {
    const uow = await testUnitOfWork();
    const wallet = openWallet(amount);
    await uow.run(async (repositories) => {
        await repositories.wallets.insert(wallet);
        if (wallet.balance.isPositive()) {
            const opening = WagerTransaction.openingFor({
                id: randomUUID(),
                walletId: wallet.id,
                playerId: wallet.playerId,
                money: wallet.balance,
                payloadHash: "b".repeat(64),
                now: new Date(),
            });
            opening.markProcessed(undefined, wallet.balance, new Date());
            await repositories.transactions.insert(opening);
            const entry = wallet.openingCredit({ entryId: randomUUID(), transactionId: opening.id, now: new Date() });
            if (entry) {
                await repositories.ledger.insert(entry);
            }
        }
    });
    return wallet;
}

describe("wallet and ledger repositories", () => {
    test("round trip a wallet with its opening credit", async () => {
        const wallet = await persistOpenedWallet("1000.00");
        const uow = await testUnitOfWork();

        const loaded = await uow.run((repositories) => repositories.wallets.findById(wallet.id));
        expect(loaded?.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
        expect(loaded?.version).toBe(1);
        expect(loaded?.playerId).toBe(wallet.playerId);
        await assertLedgerInvariant(wallet.id);
    });

    test("version-checked update applies a debit and its entry atomically", async () => {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();

        await uow.run(async (repositories) => {
            const locked = await repositories.wallets.findByIdForUpdate(wallet.id);
            if (!locked) throw new Error("missing wallet");
            const bet = newTransaction(locked, WagerTransactionKind.Bet, "30.00");
            const entry = locked.debit({
                entryId: randomUUID(),
                transactionId: bet.id,
                money: bet.money,
                now: new Date(),
            });
            bet.markProcessed(undefined, locked.balance, new Date());
            await repositories.transactions.insert(bet);
            await repositories.ledger.insert(entry);
            await repositories.wallets.update(locked);
        });

        const summary = await uow.run((repositories) => repositories.ledger.summarize(wallet.id, "BRL"));
        expect(summary.credits.toJSON().amount).toBe("100.00");
        expect(summary.debits.toJSON().amount).toBe("30.00");
        expect(summary.count).toBe(2);
        expect(summary.lastBalanceAfter?.toJSON().amount).toBe("70.00");
        expect(summary.lastWalletVersion).toBe(2);
        const entries = await uow.run((repositories) => repositories.ledger.listByWallet(wallet.id, 0, 10));
        expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
        expect(entries.every((entry) => entry.isBalanced())).toBe(true);
        await assertLedgerInvariant(wallet.id);
    });

    test("a stale wallet version is reported as a transient conflict", async () => {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();
        const stale = await uow.run((repositories) => repositories.wallets.findById(wallet.id));
        if (!stale) throw new Error("missing wallet");

        await uow.run(async (repositories) => {
            const current = await repositories.wallets.findByIdForUpdate(wallet.id);
            if (!current) throw new Error("missing wallet");
            const win = newTransaction(current, WagerTransactionKind.Win, "1.00");
            const entry = current.credit({
                entryId: randomUUID(),
                transactionId: win.id,
                money: win.money,
                now: new Date(),
            });
            win.markProcessed(undefined, current.balance, new Date());
            await repositories.transactions.insert(win);
            await repositories.ledger.insert(entry);
            await repositories.wallets.update(current);
        });

        const attempt = uow.run(async (repositories) => {
            const win = newTransaction(stale, WagerTransactionKind.Win, "2.00");
            const entry = stale.credit({
                entryId: randomUUID(),
                transactionId: win.id,
                money: win.money,
                now: new Date(),
            });
            win.markProcessed(undefined, stale.balance, new Date());
            await repositories.transactions.insert(win);
            await repositories.wallets.update(stale);
            await repositories.ledger.insert(entry);
        });
        expect(await rejectionOf(attempt)).toBeInstanceOf(TransientInfrastructureError);
        await assertLedgerInvariant(wallet.id);
    });

    test("a commit that breaks the wallet/ledger invariant is rolled back", async () => {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();

        const attempt = uow.run(async (repositories) => {
            const locked = await repositories.wallets.findByIdForUpdate(wallet.id);
            if (!locked) throw new Error("missing wallet");
            locked.credit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl("5.00"), now: new Date() });
            await repositories.wallets.update(locked);
        });

        expect(await rejectionOf(attempt)).toBeInstanceOf(InvariantViolationError);
        await assertLedgerInvariant(wallet.id);
    });
});

describe("wager transaction repository", () => {
    test("round trips state and transitions", async () => {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();
        const refund = newTransaction(wallet, WagerTransactionKind.Refund, "10.00");
        refund.markPendingReference(wallet.balance, new Date(Date.now() - 1000), new Date());
        await uow.run((repositories) => repositories.transactions.insert(refund));

        const due = await uow.run((repositories) =>
            repositories.transactions.findDuePendingReferenceIds(new Date(), 10),
        );
        expect(due).toEqual([refund.id]);

        const byKey = await uow.run((repositories) =>
            repositories.transactions.findByIdempotencyKey(refund.idempotencyKey),
        );
        expect(byKey?.status).toBe(WagerTransactionStatus.PendingReference);
        expect(byKey?.referenceAttempts).toBe(1);
        expect(byKey?.referenceExternalTransactionId).toBe("ext-reference");

        await uow.run(async (repositories) => {
            const loaded = await repositories.transactions.findById(refund.id);
            if (!loaded) throw new Error("missing transaction");
            loaded.reject(FailureCode.ReferenceNotFound, wallet.balance, new Date());
            await repositories.transactions.update(loaded);
        });
        const byProvider = await uow.run((repositories) =>
            repositories.transactions.findByProviderExternalId("provider-a", refund.externalTransactionId),
        );
        expect(byProvider?.status).toBe(WagerTransactionStatus.Rejected);
        expect(byProvider?.failureCode).toBe(FailureCode.ReferenceNotFound);
        expect(byProvider?.resultBalance?.toJSON().amount).toBe("100.00");
        expect(byProvider?.nextReferenceAttemptAt).toBeUndefined();
    });

    test("duplicate idempotency keys surface as a unique race", async () => {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();
        const loss = newTransaction(wallet, WagerTransactionKind.Loss, "0.00");
        loss.markProcessed(undefined, wallet.balance, new Date());
        await uow.run((repositories) => repositories.transactions.insert(loss));

        const duplicate = newTransaction(wallet, WagerTransactionKind.Loss, "0.00", {
            externalTransactionId: "another",
            idempotencyKey: loss.idempotencyKey,
        });
        duplicate.markProcessed(undefined, wallet.balance, new Date());
        const error = await uow
            .run((repositories) => repositories.transactions.insert(duplicate))
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(UniqueConstraintRaceError);
        expect((error as UniqueConstraintRaceError).constraint).toBe("wager_transactions_idempotency_key_uk");
    });

    test("hasProcessedReversal detects any processed reversal", async () => {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();
        const bet = newTransaction(wallet, WagerTransactionKind.Bet, "10.00");
        bet.markProcessed(undefined, wallet.balance, new Date());
        const refund = newTransaction(wallet, WagerTransactionKind.Refund, "10.00", {
            referenceExternalTransactionId: bet.externalTransactionId,
        });
        refund.markProcessed(bet.id, wallet.balance, new Date());

        await uow.run(async (repositories) => {
            await repositories.transactions.insert(bet);
            expect(await repositories.transactions.hasProcessedReversal(bet.id)).toBe(false);
            await repositories.transactions.insert(refund);
            expect(await repositories.transactions.hasProcessedReversal(bet.id)).toBe(true);
        });
    });
});

describe("inbox repository", () => {
    test("insertIfAbsent deduplicates by consumer and message id", async () => {
        const uow = await testUnitOfWork();
        const message = () =>
            InboxMessage.receive({
                messageId: "msg-1",
                consumerName: "consumer",
                payloadHash: "c".repeat(64),
                now: new Date(),
            });

        expect(await uow.run((repositories) => repositories.inbox.insertIfAbsent(message()))).toBe(true);
        expect(await uow.run((repositories) => repositories.inbox.insertIfAbsent(message()))).toBe(false);

        await uow.run(async (repositories) => {
            const stored = await repositories.inbox.find("consumer", "msg-1");
            if (!stored) throw new Error("missing inbox message");
            stored.markProcessed(new Date());
            await repositories.inbox.update(stored);
        });
        const processed = await uow.run((repositories) => repositories.inbox.find("consumer", "msg-1"));
        expect(processed?.isProcessed()).toBe(true);
    });
});

describe("outbox repository", () => {
    async function enqueue(count: number) {
        const wallet = await persistOpenedWallet();
        const uow = await testUnitOfWork();
        const messages = Array.from({ length: count }, () => {
            const loss = newTransaction(wallet, WagerTransactionKind.Loss, "0.00");
            loss.markProcessed(undefined, wallet.balance, new Date());
            return OutboxMessage.enqueue(
                WagerTransactionProcessed.from(loss, {
                    eventId: randomUUID(),
                    correlationId: "corr",
                    occurredAt: new Date(Date.now() - 1000),
                }),
            );
        });
        await uow.run((repositories) => repositories.outbox.insert(messages));
        return messages;
    }

    test("claimDue skips rows locked by another publisher", async () => {
        await enqueue(6);
        const uow = await testUnitOfWork();
        let releaseFirst: () => void = () => undefined;
        const firstHolding = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstClaimed: string[] = [];
        let signalClaimed: () => void = () => undefined;
        const claimedSignal = new Promise<void>((resolve) => {
            signalClaimed = resolve;
        });

        const first = uow.run(async (repositories) => {
            firstClaimed = (await repositories.outbox.claimDue(new Date(), 4)).map((message) => message.id);
            signalClaimed();
            await firstHolding;
        });
        await claimedSignal;
        const secondClaimed = await uow.run(async (repositories) =>
            (await repositories.outbox.claimDue(new Date(), 10)).map((message) => message.id),
        );
        releaseFirst();
        await first;

        expect(firstClaimed.length).toBe(4);
        expect(secondClaimed.length).toBe(2);
        expect(firstClaimed.filter((id) => secondClaimed.includes(id))).toEqual([]);
    });

    test("published and rescheduled messages are no longer due", async () => {
        const [published, retried, untouched] = await enqueue(3);
        const uow = await testUnitOfWork();
        const now = new Date();

        await uow.run(async (repositories) => {
            const claimed = await repositories.outbox.claimDue(now, 10);
            for (const message of claimed) {
                if (message.id === published?.id) {
                    message.markPublished(now);
                    await repositories.outbox.update(message);
                }
                if (message.id === retried?.id) {
                    message.scheduleRetry(now, "broker down");
                    await repositories.outbox.update(message);
                }
            }
        });

        const due = await uow.run((repositories) => repositories.outbox.claimDue(new Date(), 10));
        expect(due.map((message) => message.id)).toEqual([untouched?.id ?? ""]);
        const stats = await uow.run((repositories) => repositories.outbox.pendingStats());
        expect(stats.count).toBe(2);
        expect(stats.oldestOccurredAt).toBeInstanceOf(Date);
    });
});
