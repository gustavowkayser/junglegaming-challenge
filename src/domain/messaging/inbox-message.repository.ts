import type { InboxMessage } from "./inbox-message.entity";

export interface InboxMessageRepository {
    insertIfAbsent(message: InboxMessage): Promise<boolean>;
    find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
    update(message: InboxMessage): Promise<void>;
}
