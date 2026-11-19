import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message.entity";
import type { OutboxMessageRepository, OutboxPendingStats } from "../../../domain/messaging/outbox-message.repository";
import { OutboxMessageMapper } from "../mappers/messaging.mapper";
import { OutboxMessageRecord } from "../records/outbox-message.record";

interface PendingRow {
    pending: string | number;
    oldest: Date | string | null;
}

export class MikroOrmOutboxMessageRepository implements OutboxMessageRepository {
    constructor(private readonly em: EntityManager) {}

    async insert(messages: OutboxMessage[]): Promise<void> {
        if (messages.length === 0) {
            return;
        }
        await this.em.insertMany(
            OutboxMessageRecord,
            messages.map((message) => OutboxMessageMapper.toRecord(message)),
        );
    }

    async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
        const records = await this.em.find(
            OutboxMessageRecord,
            { publishedAt: null, nextAttemptAt: { $lte: now } },
            {
                orderBy: { occurredAt: "asc" },
                limit,
                lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
                disableIdentityMap: true,
            },
        );
        return records.map((record) => OutboxMessageMapper.toDomain(record));
    }

    async update(message: OutboxMessage): Promise<void> {
        const record = OutboxMessageMapper.toRecord(message);
        await this.em.nativeUpdate(
            OutboxMessageRecord,
            { id: message.id },
            {
                attempts: record.attempts,
                nextAttemptAt: record.nextAttemptAt,
                publishedAt: record.publishedAt,
                lastError: record.lastError,
            },
        );
    }

    async pendingStats(): Promise<OutboxPendingStats> {
        const [row] = await this.em.execute<PendingRow[]>(
            "select count(*) as pending, min(occurred_at) as oldest from outbox_messages where published_at is null",
        );
        return {
            count: Number(row?.pending ?? 0),
            oldestOccurredAt: row?.oldest ? new Date(row.oldest) : undefined,
        };
    }
}
