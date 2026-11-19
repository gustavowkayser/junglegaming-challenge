import { beforeEach, describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money.value-object";
import { FailureCode } from "../../../src/domain/wagering/failure-code.enum";
import { ReferenceRetryPolicy } from "../../../src/domain/wagering/reference-retry-policy.service";
import { WagerSettlementService } from "../../../src/domain/wagering/wager-settlement.service";
import type { SettlementOutcome } from "../../../src/domain/wagering/wager-settlement.types";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction.aggregate";
import { type SubmittableKind, WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status.enum";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction.enum";
import { Wallet } from "../../../src/domain/wallet/wallet.aggregate";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-01-01T00:00:00.000Z");
const policy = new ReferenceRetryPolicy({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60_000 });
const service = new WagerSettlementService(policy);

let sequence = 0;

const transaction = (
    kind: SubmittableKind,
    amount: string,
    overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) => {
    sequence += 1;
    return WagerTransaction.create({
        id: `tx-${sequence}`,
        providerId: "provider-a",
        externalTransactionId: `ext-${sequence}`,
        idempotencyKey: `provider-a:ext-${sequence}`,
        payloadHash: "a".repeat(64),
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: brl(amount),
        now,
        ...overrides,
    });
};

let wallet: Wallet;

const settle = (tx: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) =>
    service.settle({ wallet, transaction: tx, reference, referenceAlreadyReversed, entryId: `entry-${tx.id}`, now });

const processed = (tx: WagerTransaction) => {
    const outcome = settle(tx);
    expect(outcome.type).toBe("processed");
    return tx;
};

const expectRejected = (outcome: SettlementOutcome, tx: WagerTransaction, code: FailureCode) => {
    expect(outcome).toEqual({ type: "rejected", code } as SettlementOutcome);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(code);
};

const expectUnchanged = (balance: string, version: number) => {
    expect(wallet.balance.toJSON().amount).toBe(balance);
    expect(wallet.version).toBe(version);
};

beforeEach(() => {
    wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl("100.00"), now });
});

describe("BET", () => {
    test("debits the wallet and produces one DEBIT entry", () => {
        const bet = transaction(WagerTransactionKind.Bet, "25.00");
        const outcome = settle(bet);

        expect(outcome.type).toBe("processed");
        if (outcome.type !== "processed") throw new Error("unreachable");
        expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
        expect(outcome.entry?.transactionId).toBe(bet.id);
        expect(bet.status).toBe(WagerTransactionStatus.Processed);
        expect(bet.resultBalance?.toJSON().amount).toBe("75.00");
        expectUnchanged("75.00", 2);
    });

    test("can consume the exact balance", () => {
        processed(transaction(WagerTransactionKind.Bet, "100.00"));

        expectUnchanged("0.00", 2);
    });

    test("is rejected with INSUFFICIENT_FUNDS and leaves the wallet untouched", () => {
        const bet = transaction(WagerTransactionKind.Bet, "100.01");
        const outcome = settle(bet);

        expectRejected(outcome, bet, FailureCode.InsufficientFunds);
        expect(bet.resultBalance?.toJSON().amount).toBe("100.00");
        expectUnchanged("100.00", 1);
    });

    test("two 80.00 bets against 100.00: one processed, one rejected", () => {
        const first = transaction(WagerTransactionKind.Bet, "80.00");
        const second = transaction(WagerTransactionKind.Bet, "80.00");

        expect(settle(first).type).toBe("processed");
        expectRejected(settle(second), second, FailureCode.InsufficientFunds);
        expectUnchanged("20.00", 2);
    });
});

describe("WIN", () => {
    test("credits the wallet without a reference", () => {
        const win = transaction(WagerTransactionKind.Win, "50.00");
        const outcome = settle(win);

        expect(outcome.type).toBe("processed");
        if (outcome.type !== "processed") throw new Error("unreachable");
        expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
        expectUnchanged("150.00", 2);
    });

    test("credits the wallet when referencing a processed BET of the same round", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "10.00"));
        const win = transaction(WagerTransactionKind.Win, "30.00", {
            referenceExternalTransactionId: bet.externalTransactionId,
        });

        expect(settle(win, bet).type).toBe("processed");
        expect(win.referenceTransactionId).toBe(bet.id);
        expectUnchanged("120.00", 3);
    });

    test("waits for a missing referenced BET", () => {
        const win = transaction(WagerTransactionKind.Win, "30.00", { referenceExternalTransactionId: "missing" });

        expect(settle(win).type).toBe("pending-reference");
        expectUnchanged("100.00", 1);
    });

    test("rejects a reference that is not a BET", () => {
        const otherWin = processed(transaction(WagerTransactionKind.Win, "5.00"));
        const win = transaction(WagerTransactionKind.Win, "30.00", {
            referenceExternalTransactionId: otherWin.externalTransactionId,
        });

        expectRejected(settle(win, otherWin), win, FailureCode.ReferenceKindNotAllowed);
    });
});

describe("LOSS", () => {
    test("is processed without moving balance or producing an entry", () => {
        const loss = transaction(WagerTransactionKind.Loss, "10.00");
        const outcome = settle(loss);

        expect(outcome).toEqual({ type: "processed", entry: undefined });
        expect(loss.status).toBe(WagerTransactionStatus.Processed);
        expect(loss.resultBalance?.toJSON().amount).toBe("100.00");
        expectUnchanged("100.00", 1);
    });

    test("accepts a zero amount", () => {
        expect(settle(transaction(WagerTransactionKind.Loss, "0")).type).toBe("processed");
    });
});

describe("REFUND", () => {
    const refundOf = (bet: WagerTransaction, amount = bet.money.toJSON().amount, overrides = {}) =>
        transaction(WagerTransactionKind.Refund, amount, {
            referenceExternalTransactionId: bet.externalTransactionId,
            ...overrides,
        });

    test("credits back a processed BET", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "40.00"));
        const refund = refundOf(bet);
        const outcome = settle(refund, bet);

        expect(outcome.type).toBe("processed");
        if (outcome.type !== "processed") throw new Error("unreachable");
        expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
        expect(refund.referenceTransactionId).toBe(bet.id);
        expectUnchanged("100.00", 3);
    });

    test("is pending when the BET has not arrived", () => {
        const bet = transaction(WagerTransactionKind.Bet, "40.00");
        const refund = refundOf(bet);
        const outcome = settle(refund);

        expect(outcome).toEqual({ type: "pending-reference" });
        expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
        expect(refund.referenceAttempts).toBe(1);
        expect(refund.nextReferenceAttemptAt?.getTime()).toBe(now.getTime() + 1000);
        expectUnchanged("100.00", 1);
    });

    test("is pending while the referenced transaction is itself non-terminal", () => {
        const bet = transaction(WagerTransactionKind.Bet, "40.00");

        expect(settle(refundOf(bet), bet).type).toBe("pending-reference");
    });

    test("is rejected with REFERENCE_NOT_FOUND once retries are exhausted", () => {
        const bet = transaction(WagerTransactionKind.Bet, "40.00");
        const refund = refundOf(bet);

        expect(settle(refund).type).toBe("pending-reference");
        expect(settle(refund).type).toBe("pending-reference");
        expect(settle(refund).type).toBe("pending-reference");
        expectRejected(settle(refund), refund, FailureCode.ReferenceNotFound);
        expect(refund.referenceAttempts).toBe(3);
    });

    test("rejects referencing a WIN", () => {
        const win = processed(transaction(WagerTransactionKind.Win, "40.00"));
        const refund = transaction(WagerTransactionKind.Refund, "40.00", {
            referenceExternalTransactionId: win.externalTransactionId,
        });

        expectRejected(settle(refund, win), refund, FailureCode.ReferenceKindNotAllowed);
        expectUnchanged("140.00", 2);
    });

    test("rejects a partial amount", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "40.00"));
        const refund = refundOf(bet, "39.99");

        expectRejected(settle(refund, bet), refund, FailureCode.ReferenceAmountMismatch);
    });

    test("rejects a second reversal of the same BET", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "40.00"));
        const refund = refundOf(bet);

        expectRejected(settle(refund, bet, true), refund, FailureCode.ReferenceAlreadyReversed);
        expectUnchanged("60.00", 2);
    });

    test("rejects a reference that was itself rejected", () => {
        const bet = transaction(WagerTransactionKind.Bet, "400.00");
        expect(settle(bet).type).toBe("rejected");
        const refund = refundOf(bet);

        expectRejected(settle(refund, bet), refund, FailureCode.ReferenceNotProcessed);
        expectUnchanged("100.00", 1);
    });

    test.each([
        ["roundId", { roundId: "round-2" }],
        ["providerId", { providerId: "provider-b" }],
    ])("rejects a reference from a different %s", (_field, overrides) => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "40.00"));
        const refund = refundOf(bet, "40.00", overrides);

        expectRejected(settle(refund, bet), refund, FailureCode.ReferenceMismatch);
    });

    test("rejects a reference that belongs to another player", () => {
        const bet = WagerTransaction.rehydrate({
            ...processed(transaction(WagerTransactionKind.Bet, "40.00")).toState(),
            playerId: "player-2",
        });
        const refund = refundOf(bet);

        expectRejected(settle(refund, bet), refund, FailureCode.ReferenceMismatch);
    });
});

describe("ROLLBACK", () => {
    const rollbackOf = (reference: WagerTransaction) =>
        transaction(WagerTransactionKind.Rollback, reference.money.toJSON().amount, {
            referenceExternalTransactionId: reference.externalTransactionId,
        });

    test("reverses a BET with a CREDIT", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "30.00"));
        const rollback = rollbackOf(bet);
        const outcome = settle(rollback, bet);

        if (outcome.type !== "processed") throw new Error("expected processed");
        expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
        expectUnchanged("100.00", 3);
    });

    test("reverses a WIN with a DEBIT", () => {
        const win = processed(transaction(WagerTransactionKind.Win, "30.00"));
        const rollback = rollbackOf(win);
        const outcome = settle(rollback, win);

        if (outcome.type !== "processed") throw new Error("expected processed");
        expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
        expectUnchanged("100.00", 3);
    });

    test("reverses a REFUND with a DEBIT", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "30.00"));
        const refund = transaction(WagerTransactionKind.Refund, "30.00", {
            referenceExternalTransactionId: bet.externalTransactionId,
        });
        expect(settle(refund, bet).type).toBe("processed");
        const rollback = rollbackOf(refund);
        const outcome = settle(rollback, refund);

        if (outcome.type !== "processed") throw new Error("expected processed");
        expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
        expectUnchanged("70.00", 4);
    });

    test("is rejected with REVERSAL_INSUFFICIENT_FUNDS when the reversal would go negative", () => {
        const win = processed(transaction(WagerTransactionKind.Win, "50.00"));
        processed(transaction(WagerTransactionKind.Bet, "140.00"));
        const rollback = rollbackOf(win);

        expectRejected(settle(rollback, win), rollback, FailureCode.ReversalInsufficientFunds);
        expectUnchanged("10.00", 3);
    });

    test("cannot roll back a LOSS", () => {
        const loss = processed(transaction(WagerTransactionKind.Loss, "10.00"));
        const rollback = rollbackOf(loss);

        expectRejected(settle(rollback, loss), rollback, FailureCode.ReferenceKindNotAllowed);
    });

    test("cannot roll back a ROLLBACK", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "10.00"));
        const first = rollbackOf(bet);
        expect(settle(first, bet).type).toBe("processed");
        const second = rollbackOf(first);

        expectRejected(settle(second, first), second, FailureCode.ReferenceKindNotAllowed);
    });

    test("rejects a second reversal", () => {
        const bet = processed(transaction(WagerTransactionKind.Bet, "10.00"));
        const rollback = rollbackOf(bet);

        expectRejected(settle(rollback, bet, true), rollback, FailureCode.ReferenceAlreadyReversed);
    });

    test("waits for the referenced transaction", () => {
        const win = transaction(WagerTransactionKind.Win, "10.00");

        expect(settle(rollbackOf(win)).type).toBe("pending-reference");
    });
});

describe("cross-cutting rules", () => {
    test("currency conflict is rejected with CURRENCY_MISMATCH", () => {
        const bet = transaction(WagerTransactionKind.Bet, "10.00", {
            money: Money.from({ amount: "10.00", currency: "USD" }),
        });

        expectRejected(settle(bet), bet, FailureCode.CurrencyMismatch);
        expectUnchanged("100.00", 1);
    });

    test("a transaction for another player is rejected with WALLET_PLAYER_MISMATCH", () => {
        const bet = transaction(WagerTransactionKind.Bet, "10.00", { playerId: "player-2" });

        expectRejected(settle(bet), bet, FailureCode.WalletPlayerMismatch);
        expectUnchanged("100.00", 1);
    });

    test("rejections never produce entries", () => {
        const outcome = settle(transaction(WagerTransactionKind.Bet, "1000.00"));

        expect(outcome.type).toBe("rejected");
        expect("entry" in outcome).toBe(false);
    });
});
