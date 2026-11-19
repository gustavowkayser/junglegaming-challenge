import { InboxMessage } from "../../../domain/messaging/inbox-message.entity";
import { OutboxMessage } from "../../../domain/messaging/outbox-message.entity";
import type { InboxMessageRecord } from "../records/inbox-message.record";
import type { OutboxMessageRecord } from "../records/outbox-message.record";

export const InboxMessageMapper = {
    toDomain(record: InboxMessageRecord): InboxMessage {
        return InboxMessage.rehydrate({
            messageId: record.messageId,
            consumerName: record.consumerName,
            payloadHash: record.payloadHash,
            receivedAt: record.receivedAt,
            processedAt: record.processedAt ?? undefined,
        });
    },

    toRecord(message: InboxMessage): InboxMessageRecord {
        return {
            consumerName: message.consumerName,
            messageId: message.messageId,
            payloadHash: message.payloadHash,
            receivedAt: message.receivedAt,
            processedAt: message.processedAt ?? null,
        };
    },
};

export const OutboxMessageMapper = {
    toDomain(record: OutboxMessageRecord): OutboxMessage {
        return OutboxMessage.rehydrate({
            id: record.id,
            aggregateId: record.aggregateId,
            eventType: record.eventType,
            payload: record.payload,
            occurredAt: record.occurredAt,
            attempts: record.attempts,
            nextAttemptAt: record.nextAttemptAt,
            publishedAt: record.publishedAt ?? undefined,
            lastError: record.lastError ?? undefined,
        });
    },

    toRecord(message: OutboxMessage): OutboxMessageRecord {
        return {
            id: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            payload: { ...message.payload },
            occurredAt: message.occurredAt,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
            publishedAt: message.publishedAt ?? null,
            lastError: message.lastError ?? null,
        };
    },
};
