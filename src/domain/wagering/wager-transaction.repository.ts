import type { WagerTransaction } from "./wager-transaction.aggregate";

export interface WagerTransactionRepository {
    findById(id: string): Promise<WagerTransaction | undefined>;
    findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
    findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
    hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
    findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
    expeditePendingDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
    insert(transaction: WagerTransaction): Promise<void>;
    update(transaction: WagerTransaction): Promise<void>;
}
