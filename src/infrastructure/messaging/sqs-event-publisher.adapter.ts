import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishReport } from "../../application/ports/event-publisher.port";
import type { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import type { SqsQueueRegistry } from "./sqs-queue-registry.service";

const SQS_BATCH_LIMIT = 10;

export class SqsEventPublisher implements EventPublisher {
    constructor(
        private readonly client: SQSClient,
        private readonly queues: SqsQueueRegistry,
        private readonly queueName: string,
    ) {}

    async publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
        const queueUrl = await this.queues.urlOf(this.queueName);
        const report: PublishReport = { published: [], failed: [] };
        for (let offset = 0; offset < messages.length; offset += SQS_BATCH_LIMIT) {
            const chunk = messages.slice(offset, offset + SQS_BATCH_LIMIT);
            const output = await this.client.send(
                new SendMessageBatchCommand({
                    QueueUrl: queueUrl,
                    Entries: chunk.map((message) => ({
                        Id: message.id,
                        MessageBody: JSON.stringify(message.payload),
                        MessageGroupId: message.aggregateId,
                        MessageDeduplicationId: message.id,
                        MessageAttributes: {
                            eventType: { DataType: "String", StringValue: message.eventType },
                            correlationId: {
                                DataType: "String",
                                StringValue: String(message.payload.correlationId ?? "unknown"),
                            },
                        },
                    })),
                }),
            );
            for (const success of output.Successful ?? []) {
                if (success.Id) {
                    report.published.push(success.Id);
                }
            }
            for (const failure of output.Failed ?? []) {
                if (failure.Id) {
                    report.failed.push({ id: failure.Id, error: `${failure.Code}: ${failure.Message ?? ""}` });
                }
            }
        }
        return report;
    }
}
