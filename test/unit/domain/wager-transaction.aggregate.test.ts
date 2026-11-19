import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money.value-object";
import { FailureCode } from "../../../src/domain/wagering/failure-code.enum";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction.aggregate";
import {
    InvalidTransactionStateError,
    InvalidWagerTransactionError,
    MissingReferenceError,
} from "../../../src/domain/wagering/wager-transaction.error";
import { type SubmittableKind, WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status.enum";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction.enum";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-01-01T00:00:00.000Z");
const later = new Date("2026-01-01T00:01:00.000Z");

const create = (kind: SubmittableKind, overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
    WagerTransaction.create({
        id: `id-${kind}`,
        providerId: "provider-a",
        externalTransactionId: `external-${kind}`,
        idempotencyKey: `provider-a:external-${kind}`,
        payloadHash: "a".repeat(64),
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: brl("10.00"),
        referenceExternalTransactionId:
            kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback ? "external-ref" : undefined,
        now,
        ...overrides,
    });

describe("WagerTransaction.create", () => {
    test("starts as PENDING with no outcome", () => {
        const transaction = create(WagerTransactionKind.Bet);

        expect(transaction.status).toBe(WagerTransactionStatus.Pending);
        expect(transaction.isTerminal()).toBe(false);
        expect(transaction.processedAt).toBeUndefined();
        expect(transaction.failureCode).toBeUndefined();
        expect(transaction.referenceAttempts).toBe(0);
    });

    test("rejects the internal OPENING kind", () => {
        expect(() => create(WagerTransactionKind.Opening as unknown as SubmittableKind)).toThrow(
            InvalidWagerTransactionError,
        );
    });

    test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])("%s requires a reference", (kind) => {
        expect(() => create(kind, { referenceExternalTransactionId: undefined })).toThrow(InvalidWagerTransactionError);
        expect(() => create(kind, { referenceExternalTransactionId: "" })).toThrow(InvalidWagerTransactionError);
    });

    test("WIN accepts an optional reference", () => {
        expect(create(WagerTransactionKind.Win).hasReference()).toBe(false);
        expect(create(WagerTransactionKind.Win, { referenceExternalTransactionId: "bet" }).hasReference()).toBe(true);
    });

    test("BET and LOSS do not accept references", () => {
        expect(() => create(WagerTransactionKind.Bet, { referenceExternalTransactionId: "x" })).toThrow(
            InvalidWagerTransactionError,
        );
        expect(() => create(WagerTransactionKind.Loss, { referenceExternalTransactionId: "x" })).toThrow(
            InvalidWagerTransactionError,
        );
    });

    test.each([
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
    ] as const)("%s requires a positive amount", (kind) => {
        expect(() => create(kind, { money: brl("0") })).toThrow(InvalidWagerTransactionError);
    });

    test("LOSS accepts a zero amount", () => {
        expect(create(WagerTransactionKind.Loss, { money: brl("0") }).money.isZero()).toBe(true);
    });

    test("rejects blank identifiers", () => {
        expect(() => create(WagerTransactionKind.Bet, { roundId: "" })).toThrow(InvalidWagerTransactionError);
        expect(() => create(WagerTransactionKind.Bet, { idempotencyKey: "" })).toThrow(InvalidWagerTransactionError);
    });
});

describe("WagerTransaction.openingFor", () => {
    test("builds an internal processed-ready OPENING credit", () => {
        const opening = WagerTransaction.openingFor({
            id: "opening-1",
            walletId: "wallet-1",
            playerId: "player-1",
            money: brl("1000.00"),
            payloadHash: "b".repeat(64),
            now,
        });

        expect(opening.kind).toBe(WagerTransactionKind.Opening);
        expect(opening.providerId).toBe("internal");
        expect(opening.idempotencyKey).toBe("internal:opening:wallet-1");
        expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
});

describe("WagerTransaction transitions", () => {
    test("PENDING -> PROCESSED records the outcome", () => {
        const transaction = create(WagerTransactionKind.Bet);
        transaction.markProcessed(undefined, brl("90.00"), later);

        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
        expect(transaction.processedAt).toEqual(later);
        expect(transaction.resultBalance?.toJSON().amount).toBe("90.00");
        expect(transaction.isTerminal()).toBe(true);
    });

    test("PENDING -> REJECTED keeps the failure code and balance", () => {
        const transaction = create(WagerTransactionKind.Bet);
        transaction.reject(FailureCode.InsufficientFunds, brl("5.00"), later);

        expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
        expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
        expect(transaction.resultBalance?.toJSON().amount).toBe("5.00");
        expect(transaction.processedAt).toEqual(later);
    });

    test("PENDING -> FAILED", () => {
        const transaction = create(WagerTransactionKind.Bet);
        transaction.fail(FailureCode.ProcessingError, later);

        expect(transaction.status).toBe(WagerTransactionStatus.Failed);
        expect(transaction.failureCode).toBe(FailureCode.ProcessingError);
    });

    test("PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> PROCESSED", () => {
        const transaction = create(WagerTransactionKind.Refund);
        const firstRetry = new Date(now.getTime() + 1000);
        const secondRetry = new Date(now.getTime() + 3000);
        transaction.markPendingReference(brl("10.00"), firstRetry, now);

        expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
        expect(transaction.referenceAttempts).toBe(1);
        expect(transaction.nextReferenceAttemptAt).toEqual(firstRetry);

        transaction.markPendingReference(brl("10.00"), secondRetry, firstRetry);
        expect(transaction.referenceAttempts).toBe(2);

        transaction.markProcessed("reference-id", brl("20.00"), later);
        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
        expect(transaction.referenceTransactionId).toBe("reference-id");
        expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    });

    test("PENDING_REFERENCE -> REJECTED", () => {
        const transaction = create(WagerTransactionKind.Refund);
        transaction.markPendingReference(brl("10.00"), later, now);
        transaction.reject(FailureCode.ReferenceNotFound, brl("10.00"), later);

        expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
        expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    });

    const terminalTransactions = () => {
        const processed = create(WagerTransactionKind.Bet);
        processed.markProcessed(undefined, brl("1.00"), later);
        const rejected = create(WagerTransactionKind.Bet);
        rejected.reject(FailureCode.InsufficientFunds, brl("1.00"), later);
        const failed = create(WagerTransactionKind.Bet);
        failed.fail(FailureCode.ProcessingError, later);
        return [processed, rejected, failed];
    };

    test("terminal states reject every transition", () => {
        for (const transaction of terminalTransactions()) {
            expect(() => transaction.markProcessed(undefined, brl("1.00"), later)).toThrow(
                InvalidTransactionStateError,
            );
            expect(() => transaction.markPendingReference(brl("1.00"), later, later)).toThrow(
                InvalidTransactionStateError,
            );
            expect(() => transaction.reject(FailureCode.InsufficientFunds, brl("1.00"), later)).toThrow(
                InvalidTransactionStateError,
            );
            expect(() => transaction.fail(FailureCode.ProcessingError, later)).toThrow(InvalidTransactionStateError);
        }
    });

    test("only reversible-by-reference kinds can become PENDING_REFERENCE", () => {
        expect(() => create(WagerTransactionKind.Bet).markPendingReference(brl("1.00"), later, now)).toThrow(
            InvalidTransactionStateError,
        );
    });
});

describe("WagerTransaction queries", () => {
    test("affectsBalance is false only for LOSS", () => {
        expect(create(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
        expect(create(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
        expect(create(WagerTransactionKind.Win).affectsBalance()).toBe(true);
        expect(create(WagerTransactionKind.Refund).affectsBalance()).toBe(true);
        expect(create(WagerTransactionKind.Rollback).affectsBalance()).toBe(true);
    });

    test("requiresReference is true for REFUND and ROLLBACK", () => {
        expect(create(WagerTransactionKind.Refund).requiresReference()).toBe(true);
        expect(create(WagerTransactionKind.Rollback).requiresReference()).toBe(true);
        expect(create(WagerTransactionKind.Win).requiresReference()).toBe(false);
        expect(create(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    });

    test("matchesPayload compares the stored hash", () => {
        const transaction = create(WagerTransactionKind.Bet);

        expect(transaction.matchesPayload("a".repeat(64))).toBe(true);
        expect(transaction.matchesPayload("b".repeat(64))).toBe(false);
    });

    test("ledgerDirectionFor", () => {
        const bet = create(WagerTransactionKind.Bet);
        const win = create(WagerTransactionKind.Win);
        const refund = create(WagerTransactionKind.Refund);
        const rollback = create(WagerTransactionKind.Rollback);

        expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
        expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
        expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
        expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
        expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
        expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    });

    test("ROLLBACK without a resolved reference has no direction", () => {
        expect(() => create(WagerTransactionKind.Rollback).ledgerDirectionFor()).toThrow(MissingReferenceError);
    });

    test("LOSS has no ledger direction", () => {
        expect(() => create(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });
});

describe("WagerTransaction.rehydrate", () => {
    test("restores terminal state without revalidating transitions", () => {
        const transaction = WagerTransaction.rehydrate({
            ...create(WagerTransactionKind.Bet).toState(),
            status: WagerTransactionStatus.Processed,
            processedAt: later,
            resultBalance: brl("1.00"),
        });

        expect(transaction.status).toBe(WagerTransactionStatus.Processed);
        expect(transaction.isTerminal()).toBe(true);
    });
});
