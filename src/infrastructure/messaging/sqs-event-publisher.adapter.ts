import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishReport } from "../../application/ports/event-publisher.port";
import type { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import type { SqsQueueRegistry } from "./sqs-queue-registry.service";

const SQS_BATCH_LIMIT = 10;
const DEFAULT_LANES = 4;

function laneOf(aggregateId: string, lanes: number): number {
    let hash = 0;
    for (const character of aggregateId) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return hash % lanes;
}

export class SqsEventPublisher implements EventPublisher {
    constructor(
        private readonly client: SQSClient,
        private readonly queues: SqsQueueRegistry,
        private readonly queueName: string,
        private readonly lanes = DEFAULT_LANES,
    ) {}

    async publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
        const queueUrl = await this.queues.urlOf(this.queueName);
        const lanes = Array.from({ length: this.lanes }, () => [] as OutboxMessage[]);
        for (const message of messages) {
            lanes[laneOf(message.aggregateId, this.lanes)]?.push(message);
        }
        const reports = await Promise.all(lanes.map((lane) => this.publishLane(queueUrl, lane)));
        return {
            published: reports.flatMap((report) => report.published),
            failed: reports.flatMap((report) => report.failed),
        };
    }

    private async publishLane(queueUrl: string, lane: OutboxMessage[]): Promise<PublishReport> {
        const report: PublishReport = { published: [], failed: [] };
        const blocked = new Set<string>();
        let pending = [...lane];
        while (pending.length > 0) {
            const ready = pending.filter((message) => !blocked.has(message.aggregateId));
            for (const message of pending.filter((candidate) => blocked.has(candidate.aggregateId))) {
                report.failed.push({ id: message.id, error: "held back to preserve per-aggregate order" });
            }
            const chunk = ready.slice(0, SQS_BATCH_LIMIT);
            pending = ready.slice(SQS_BATCH_LIMIT);
            if (chunk.length === 0) {
                break;
            }
            try {
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
                const failed = new Map((output.Failed ?? []).map((failure) => [failure.Id, failure]));
                for (const message of chunk) {
                    const failure = failed.get(message.id);
                    if (failure) {
                        blocked.add(message.aggregateId);
                        report.failed.push({ id: message.id, error: `${failure.Code}: ${failure.Message ?? ""}` });
                    } else {
                        report.published.push(message.id);
                    }
                }
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                for (const message of [...chunk, ...pending]) {
                    report.failed.push({ id: message.id, error: reason });
                }
                return report;
            }
        }
        return report;
    }
}
