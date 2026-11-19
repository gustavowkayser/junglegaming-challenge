import type { EntityManager, FilterQuery } from "@mikro-orm/postgresql";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction.aggregate";
import type { WagerTransactionRepository } from "../../../domain/wagering/wager-transaction.repository";
import { REVERSAL_KINDS } from "../../../domain/wagering/wager-transaction-kind.enum";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status.enum";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import { WagerTransactionRecord } from "../records/wager-transaction.record";

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) {}

    findById(id: string): Promise<WagerTransaction | undefined> {
        return this.findOne({ id });
    }

    findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
        return this.findOne({ idempotencyKey });
    }

    findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
        return this.findOne({ providerId, externalTransactionId });
    }

    async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
        const count = await this.em.count(WagerTransactionRecord, {
            referenceTransactionId,
            status: WagerTransactionStatus.Processed,
            kind: { $in: [...REVERSAL_KINDS] },
        });
        return count > 0;
    }

    async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
        const records = await this.em.find(
            WagerTransactionRecord,
            { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
            { fields: ["id"], orderBy: { nextReferenceAttemptAt: "asc" }, limit, disableIdentityMap: true },
        );
        return records.map((record) => record.id);
    }

    async insert(transaction: WagerTransaction): Promise<void> {
        await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction));
    }

    async update(transaction: WagerTransaction): Promise<void> {
        const record = WagerTransactionMapper.toRecord(transaction);
        await this.em.nativeUpdate(
            WagerTransactionRecord,
            { id: transaction.id },
            {
                status: record.status,
                referenceTransactionId: record.referenceTransactionId,
                failureCode: record.failureCode,
                resultBalance: record.resultBalance,
                referenceAttempts: record.referenceAttempts,
                nextReferenceAttemptAt: record.nextReferenceAttemptAt,
                updatedAt: record.updatedAt,
                processedAt: record.processedAt,
            },
        );
    }

    private async findOne(where: FilterQuery<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
        const record = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
        return record ? WagerTransactionMapper.toDomain(record) : undefined;
    }
}
