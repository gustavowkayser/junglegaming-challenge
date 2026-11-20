import { randomUUID } from "node:crypto";
import {
    DeleteMessageBatchCommand,
    DeleteQueueCommand,
    GetQueueAttributesCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client.factory";
import { ensureQueues, type QueueUrls } from "../../src/infrastructure/messaging/sqs-queue-setup.service";
import { testEnvironment } from "./environment.support";

let client: SQSClient | undefined;

export function testSqsClient(): SQSClient {
    client ??= createSqsClient(testEnvironment());
    return client;
}

export interface TestQueues extends QueueUrls {
    names: { wager: string; dlq: string; events: string };
    env: Record<string, string>;
}

export async function createTestQueues(
    options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
    const suffix = randomUUID().slice(0, 8);
    const names = {
        wager: `test-wager-${suffix}.fifo`,
        dlq: `test-wager-dlq-${suffix}.fifo`,
        events: `test-events-${suffix}.fifo`,
    };
    const maxReceiveCount = options.maxReceiveCount ?? 5;
    const visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 30;
    const urls = await ensureQueues(testSqsClient(), {
        wagerQueueName: names.wager,
        wagerDlqName: names.dlq,
        eventsQueueName: names.events,
        maxReceiveCount,
        visibilityTimeoutSeconds,
    });
    return {
        ...urls,
        names,
        env: {
            SQS_WAGER_QUEUE_NAME: names.wager,
            SQS_WAGER_DLQ_NAME: names.dlq,
            SQS_EVENTS_QUEUE_NAME: names.events,
            SQS_MAX_RECEIVE_COUNT: String(maxReceiveCount),
            SQS_VISIBILITY_TIMEOUT_SECONDS: String(visibilityTimeoutSeconds),
        },
    };
}

export async function deleteTestQueues(queues: TestQueues): Promise<void> {
    for (const url of [queues.wagerQueueUrl, queues.wagerDlqUrl, queues.eventsQueueUrl]) {
        await testSqsClient()
            .send(new DeleteQueueCommand({ QueueUrl: url }))
            .catch(() => undefined);
    }
}

export interface ReceivedMessage {
    body: Record<string, unknown>;
    attributes: Record<string, string>;
    messageAttributes: Record<string, string>;
}

export async function drainQueue(
    queueUrl: string,
    options: { expected?: number; timeoutMs?: number; idleMs?: number } = {},
): Promise<ReceivedMessage[]> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const idleMs = options.idleMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;
    const received: ReceivedMessage[] = [];
    let lastReceiveAt = Date.now();
    const seen = new Set<string>();
    while (Date.now() < deadline) {
        if (options.expected !== undefined && received.length >= options.expected) {
            break;
        }
        if (options.expected === undefined && Date.now() - lastReceiveAt > idleMs) {
            break;
        }
        const output = await testSqsClient().send(
            new ReceiveMessageCommand({
                QueueUrl: queueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 1,
                MessageSystemAttributeNames: ["All"],
                MessageAttributeNames: ["All"],
            }),
        );
        for (const message of output.Messages ?? []) {
            lastReceiveAt = Date.now();
            if (message.MessageId && seen.has(message.MessageId)) {
                continue;
            }
            if (message.MessageId) {
                seen.add(message.MessageId);
            }
            received.push({
                body: JSON.parse(message.Body ?? "{}"),
                attributes: (message.Attributes ?? {}) as Record<string, string>,
                messageAttributes: Object.fromEntries(
                    Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [
                        key,
                        value.StringValue ?? "",
                    ]),
                ),
            });
        }
        const entries = (output.Messages ?? []).map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
        }));
        if (entries.length > 0) {
            await testSqsClient()
                .send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }))
                .catch(() => undefined);
        }
    }
    return received;
}

export async function queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
    const output = await testSqsClient().send(
        new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
    );
    return {
        visible: Number(output.Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(output.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
}

export async function sendWagerMessage(
    queueUrl: string,
    envelope: { messageId: string; data: Record<string, unknown> } & Record<string, unknown>,
    options: { deduplicationId?: string; rawBody?: string } = {},
): Promise<void> {
    const body =
        options.rawBody ??
        JSON.stringify({
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            ...envelope,
        });
    await testSqsClient().send(
        new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: body,
            MessageGroupId: String(envelope.data.walletId ?? "default"),
            MessageDeduplicationId: options.deduplicationId ?? envelope.messageId,
        }),
    );
}
