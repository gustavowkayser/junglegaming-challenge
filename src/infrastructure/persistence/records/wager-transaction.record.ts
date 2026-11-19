export class WagerTransactionRecord {
    id!: string;
    providerId!: string;
    externalTransactionId!: string;
    idempotencyKey!: string;
    payloadHash!: string;
    walletId!: string;
    playerId!: string;
    roundId!: string;
    gameId!: string;
    kind!: string;
    amount!: string;
    currency!: string;
    referenceExternalTransactionId!: string | null;
    referenceTransactionId!: string | null;
    status!: string;
    failureCode!: string | null;
    resultBalance!: string | null;
    referenceAttempts!: number;
    nextReferenceAttemptAt!: Date | null;
    createdAt!: Date;
    updatedAt!: Date;
    processedAt!: Date | null;
}
