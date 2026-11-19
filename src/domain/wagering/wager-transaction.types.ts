import type { Money } from "../money/money.value-object";
import type { FailureCode } from "./failure-code.enum";
import type { SubmittableKind, WagerTransactionKind } from "./wager-transaction-kind.enum";
import type { WagerTransactionStatus } from "./wager-transaction-status.enum";

export interface WagerTransactionState {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId: string | undefined;
    createdAt: Date;
    updatedAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId: string | undefined;
    failureCode: FailureCode | undefined;
    processedAt: Date | undefined;
    resultBalance: Money | undefined;
    referenceAttempts: number;
    nextReferenceAttemptAt: Date | undefined;
}

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: SubmittableKind;
    money: Money;
    referenceExternalTransactionId?: string | undefined;
    now: Date;
}

export interface OpeningTransactionProps {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    now: Date;
}
