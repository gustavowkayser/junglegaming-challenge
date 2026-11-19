import { describe, expect, test } from "bun:test";
import { WagerTransactionPendingReference } from "../../../src/domain/events/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../../src/domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../../src/domain/events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed.event";
import { Money } from "../../../src/domain/money/money.value-object";
import { FailureCode } from "../../../src/domain/wagering/failure-code.enum";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction.aggregate";
import { type SubmittableKind, WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { Wallet } from "../../../src/domain/wallet/wallet.aggregate";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-01-01T00:00:00.000Z");
const context = { eventId: "event-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: now };

const transaction = (kind: SubmittableKind, reference?: string) =>
    WagerTransaction.create({
        id: "tx-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "provider-a:ext-1",
        payloadHash: "a".repeat(64),
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: brl("25.00"),
        referenceExternalTransactionId: reference,
        now,
    });

describe("WagerTransactionProcessed", () => {
    test("serializes a stable envelope with money as decimal strings", () => {
        const tx = transaction(WagerTransactionKind.Bet);
        tx.markProcessed(undefined, brl("75.00"), now);
        const event = WagerTransactionProcessed.from(tx, context);

        expect(event.eventType).toBe("WagerTransactionProcessed");
        expect(event.version).toBe(1);
        expect(event.toJSON()).toEqual({
            eventId: "event-1",
            eventType: "WagerTransactionProcessed",
            aggregateId: "wallet-1",
            correlationId: "corr-1",
            causationId: "msg-1",
            occurredAt: "2026-01-01T00:00:00.000Z",
            version: 1,
            data: {
                transactionId: "tx-1",
                providerId: "provider-a",
                externalTransactionId: "ext-1",
                walletId: "wallet-1",
                playerId: "player-1",
                roundId: "round-1",
                gameId: "game-1",
                kind: "BET",
                money: { amount: "25.00", currency: "BRL" },
                balance: { amount: "75.00", currency: "BRL" },
                processedAt: "2026-01-01T00:00:00.000Z",
            },
        });
    });

    test("covers LOSS", () => {
        const tx = transaction(WagerTransactionKind.Loss);
        tx.markProcessed(undefined, brl("100.00"), now);

        expect(WagerTransactionProcessed.from(tx, context).data.kind).toBe("LOSS");
    });

    test("requires a processed transaction", () => {
        expect(() => WagerTransactionProcessed.from(transaction(WagerTransactionKind.Bet), context)).toThrow();
    });

    test("data is immutable", () => {
        const tx = transaction(WagerTransactionKind.Bet);
        tx.markProcessed(undefined, brl("75.00"), now);
        const event = WagerTransactionProcessed.from(tx, context);

        expect(Object.isFrozen(event.data)).toBe(true);
        expect(Object.isFrozen(event.data.money)).toBe(true);
    });

    test("omits causationId when absent", () => {
        const tx = transaction(WagerTransactionKind.Bet);
        tx.markProcessed(undefined, brl("75.00"), now);
        const envelope = WagerTransactionProcessed.from(tx, { ...context, causationId: undefined }).toJSON();

        expect("causationId" in envelope).toBe(false);
    });
});

describe("WagerTransactionRejected", () => {
    test("carries the failure code", () => {
        const tx = transaction(WagerTransactionKind.Bet);
        tx.reject(FailureCode.InsufficientFunds, brl("10.00"), now);
        const event = WagerTransactionRejected.from(tx, context);

        expect(event.eventType).toBe("WagerTransactionRejected");
        expect(event.data.failureCode).toBe("INSUFFICIENT_FUNDS");
        expect(event.data.balance).toEqual({ amount: "10.00", currency: "BRL" });
        expect(event.data.rejectedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    test("requires a rejected transaction", () => {
        expect(() => WagerTransactionRejected.from(transaction(WagerTransactionKind.Bet), context)).toThrow();
    });
});

describe("WagerTransactionPendingReference", () => {
    test("carries the missing reference and the retry schedule", () => {
        const tx = transaction(WagerTransactionKind.Refund, "ext-bet");
        tx.markPendingReference(brl("100.00"), new Date(now.getTime() + 1000), now);
        const event = WagerTransactionPendingReference.from(tx, context);

        expect(event.eventType).toBe("WagerTransactionPendingReference");
        expect(event.data.referenceExternalTransactionId).toBe("ext-bet");
        expect(event.data.attempts).toBe(1);
        expect(event.data.nextAttemptAt).toBe("2026-01-01T00:00:01.000Z");
    });
});

describe("WalletBalanceChanged", () => {
    test("describes the ledger movement", () => {
        const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl("100.00"), now });
        const entry = wallet.debit({ entryId: "entry-1", transactionId: "tx-1", money: brl("25.00"), now });
        const event = WalletBalanceChanged.from(wallet, entry, context);

        expect(event.eventType).toBe("WalletBalanceChanged");
        expect(event.version).toBe(1);
        expect(event.aggregateId).toBe("wallet-1");
        expect(event.data).toEqual({
            walletId: "wallet-1",
            transactionId: "tx-1",
            direction: "DEBIT" as never,
            money: { amount: "25.00", currency: "BRL" },
            balanceBefore: { amount: "100.00", currency: "BRL" },
            balanceAfter: { amount: "75.00", currency: "BRL" },
            walletVersion: 2,
        });
        expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON() as never);
    });
});
