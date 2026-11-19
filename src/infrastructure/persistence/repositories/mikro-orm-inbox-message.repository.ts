import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessage } from "../../../domain/messaging/inbox-message.entity";
import type { InboxMessageRepository } from "../../../domain/messaging/inbox-message.repository";
import { InboxMessageMapper } from "../mappers/messaging.mapper";
import { InboxMessageRecord } from "../records/inbox-message.record";

export class MikroOrmInboxMessageRepository implements InboxMessageRepository {
    constructor(private readonly em: EntityManager) {}

    async insertIfAbsent(message: InboxMessage): Promise<boolean> {
        const result = await this.em
            .createQueryBuilder(InboxMessageRecord)
            .insert(InboxMessageMapper.toRecord(message))
            .onConflict(["consumerName", "messageId"])
            .ignore()
            .execute("run");
        return result.affectedRows === 1;
    }

    async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
        const record = await this.em.findOne(
            InboxMessageRecord,
            { consumerName, messageId },
            { disableIdentityMap: true },
        );
        return record ? InboxMessageMapper.toDomain(record) : undefined;
    }

    async update(message: InboxMessage): Promise<void> {
        await this.em.nativeUpdate(
            InboxMessageRecord,
            { consumerName: message.consumerName, messageId: message.messageId },
            { processedAt: message.processedAt ?? null },
        );
    }
}
