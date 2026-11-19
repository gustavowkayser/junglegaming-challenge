import { Money } from "../../../domain/money/money.value-object";
import type { FailureCode } from "../../../domain/wagering/failure-code.enum";
import { WagerTransaction } from "../../../domain/wagering/wager-transaction.aggregate";
import type { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind.enum";
import type { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status.enum";
import type { WagerTransactionRecord } from "../records/wager-transaction.record";

export const WagerTransactionMapper = {
    toDomain(record: WagerTransactionRecord): WagerTransaction {
        const money = (amount: string) => Money.fromPersistence({ amount, currency: record.currency });
        return WagerTransaction.rehydrate({
            id: record.id,
            providerId: record.providerId,
            externalTransactionId: record.externalTransactionId,
            idempotencyKey: record.idempotencyKey,
            payloadHash: record.payloadHash,
            walletId: record.walletId,
            playerId: record.playerId,
            roundId: record.roundId,
            gameId: record.gameId,
            kind: record.kind as WagerTransactionKind,
            money: money(record.amount),
            referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            status: record.status as WagerTransactionStatus,
            referenceTransactionId: record.referenceTransactionId ?? undefined,
            failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
            processedAt: record.processedAt ?? undefined,
            resultBalance: record.resultBalance === null ? undefined : money(record.resultBalance),
            referenceAttempts: record.referenceAttempts,
            nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
        });
    },

    toRecord(transaction: WagerTransaction): WagerTransactionRecord {
        return {
            id: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            amount: transaction.money.toJSON().amount,
            currency: transaction.money.currency,
            referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
            referenceTransactionId: transaction.referenceTransactionId ?? null,
            status: transaction.status,
            failureCode: transaction.failureCode ?? null,
            resultBalance: transaction.resultBalance?.toJSON().amount ?? null,
            referenceAttempts: transaction.referenceAttempts,
            nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
            createdAt: transaction.createdAt,
            updatedAt: transaction.updatedAt,
            processedAt: transaction.processedAt ?? null,
        };
    },
};
