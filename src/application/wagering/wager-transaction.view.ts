import type { MoneyProps } from "../../domain/money/money.types";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction.aggregate";

export interface WagerTransactionResult {
    transactionId: string;
    status: string;
    failureCode?: string;
    balance?: MoneyProps;
    idempotentReplay: boolean;
}

export interface WagerTransactionView {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: MoneyProps;
    status: string;
    failureCode?: string;
    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;
    balance?: MoneyProps;
    referenceAttempts: number;
    nextReferenceAttemptAt?: string;
    createdAt: string;
    processedAt?: string;
}

export function toWagerTransactionResult(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
): WagerTransactionResult {
    return {
        transactionId: transaction.id,
        status: transaction.status,
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
        ...(transaction.resultBalance ? { balance: transaction.resultBalance.toJSON() } : {}),
        idempotentReplay,
    };
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
    return {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        status: transaction.status,
        ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
        ...(transaction.referenceExternalTransactionId
            ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
            : {}),
        ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
        ...(transaction.resultBalance ? { balance: transaction.resultBalance.toJSON() } : {}),
        referenceAttempts: transaction.referenceAttempts,
        ...(transaction.nextReferenceAttemptAt
            ? { nextReferenceAttemptAt: transaction.nextReferenceAttemptAt.toISOString() }
            : {}),
        createdAt: transaction.createdAt.toISOString(),
        ...(transaction.processedAt ? { processedAt: transaction.processedAt.toISOString() } : {}),
    };
}
