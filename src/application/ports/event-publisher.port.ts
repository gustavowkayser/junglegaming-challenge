import type { OutboxMessage } from "../../domain/messaging/outbox-message.entity";

export interface PublishFailure {
    id: string;
    error: string;
}

export interface PublishReport {
    published: string[];
    failed: PublishFailure[];
}

export interface EventPublisher {
    publish(messages: readonly OutboxMessage[]): Promise<PublishReport>;
}

export const EVENT_PUBLISHER = Symbol("EventPublisher");
