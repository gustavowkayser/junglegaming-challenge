import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message.entity";
import type { OutboxMessageRepository, OutboxPendingStats } from "../../../domain/messaging/outbox-message.repository";
import { OutboxMessageMapper } from "../mappers/messaging.mapper";
import { OutboxMessageRecord } from "../records/outbox-message.record";

interface PendingRow {
    pending: string | number;
    oldest: Date | string | null;
}

const BULK_UPDATE_SQL = `
    update outbox_messages as outbox
    set attempts = changes.attempts,
        next_attempt_at = changes.next_attempt_at,
        published_at = changes.published_at,
        last_error = changes.last_error
    from jsonb_to_recordset(?::jsonb)
        as changes (id uuid, attempts integer, next_attempt_at timestamptz, published_at timestamptz, last_error text)
    where outbox.id = changes.id
`;

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

    async updateMany(messages: readonly OutboxMessage[]): Promise<void> {
        if (messages.length === 0) {
            return;
        }
        const records = messages.map((message) => OutboxMessageMapper.toRecord(message));
        const changes = records.map((record) => ({
            id: record.id,
            attempts: record.attempts,
            next_attempt_at: record.nextAttemptAt.toISOString(),
            published_at: record.publishedAt?.toISOString() ?? null,
            last_error: record.lastError,
        }));
        await this.em.execute(BULK_UPDATE_SQL, [JSON.stringify(changes)]);
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
