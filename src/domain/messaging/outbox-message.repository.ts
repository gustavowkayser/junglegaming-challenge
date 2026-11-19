import type { OutboxMessage } from "./outbox-message.entity";

export interface OutboxPendingStats {
    count: number;
    oldestOccurredAt: Date | undefined;
}

export interface OutboxMessageRepository {
    insert(messages: OutboxMessage[]): Promise<void>;
    claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
    update(message: OutboxMessage): Promise<void>;
    pendingStats(): Promise<OutboxPendingStats>;
}
