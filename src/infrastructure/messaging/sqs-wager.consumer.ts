import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    type Message,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
} from "@aws-sdk/client-sqs";
import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import type { Logger } from "pino";
import {
    type ConsumeDecision,
    type ConsumeWagerMessageInput,
    ConsumeWagerMessageUseCase,
} from "../../application/messaging/consume-wager-message.use-case";
import { FAULT_INJECTOR, type FaultInjector } from "../../application/ports/fault-injector.port";
import { EnvironmentService } from "../config/environment.service";
import { wagerMessageSchema } from "../contracts/wager-message.schema";
import { describeError } from "../observability/error-description.service";
import { AppLogger } from "../observability/logger.service";
import { RequestContext } from "../observability/request-context.service";
import { SqsQueueRegistry } from "./sqs-queue-registry.service";

const DECISION_EVENTS: Record<ConsumeDecision["action"], string> = {
    ack: "message.acked",
    retry: "message.retried",
    "dead-letter": "message.dead_lettered",
};

@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private running = false;
    private loop: Promise<void> | undefined;
    private receiving: AbortController | undefined;
    private readonly log: Logger;

    constructor(
        private readonly client: SQSClient,
        private readonly queues: SqsQueueRegistry,
        private readonly consume: ConsumeWagerMessageUseCase,
        private readonly environment: EnvironmentService,
        @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
        logger: AppLogger,
    ) {
        this.log = logger.child("SqsWagerConsumer");
    }

    onApplicationBootstrap(): void {
        if (!this.environment.get("SQS_CONSUMER_ENABLED")) {
            return;
        }
        this.running = true;
        this.loop = this.run();
        this.log.info({ event: "worker.started", worker: "sqs-wager-consumer" });
    }

    async beforeApplicationShutdown(signal?: string): Promise<void> {
        if (!this.running) {
            return;
        }
        this.running = false;
        this.receiving?.abort();
        this.log.info({ event: "consumer.draining", signal });
        const timeoutMs = this.environment.get("SHUTDOWN_TIMEOUT_MS");
        const drained = await Promise.race([this.loop?.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
        this.log.info({ event: "worker.stopped", worker: "sqs-wager-consumer", drained });
    }

    private async run(): Promise<void> {
        while (this.running) {
            try {
                const queueUrl = await this.queues.urlOf(this.environment.get("SQS_WAGER_QUEUE_NAME"));
                const messages = await this.receive(queueUrl);
                if (messages.length > 0) {
                    await this.processBatch(queueUrl, messages);
                }
            } catch (error) {
                if (!this.running) {
                    break;
                }
                this.log.warn({ event: "consumer.receive_failed", err: describeError(error) });
                await Bun.sleep(1000);
            }
        }
    }

    private async receive(queueUrl: string): Promise<Message[]> {
        this.receiving = new AbortController();
        try {
            const output = await this.client.send(
                new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    MaxNumberOfMessages: 10,
                    WaitTimeSeconds: this.environment.get("SQS_WAIT_TIME_SECONDS"),
                    VisibilityTimeout: this.environment.get("SQS_VISIBILITY_TIMEOUT_SECONDS"),
                    MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
                }),
                { abortSignal: this.receiving.signal },
            );
            return output.Messages ?? [];
        } catch (error) {
            if (!this.running) {
                return [];
            }
            throw error;
        } finally {
            this.receiving = undefined;
        }
    }

    private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
        const groups = new Map<string, Message[]>();
        for (const message of messages) {
            const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "default";
            groups.set(group, [...(groups.get(group) ?? []), message]);
        }
        await Promise.all(
            [...groups.values()].map(async (group) => {
                for (const [index, message] of group.entries()) {
                    if (!this.running) {
                        await this.release(queueUrl, group.slice(index));
                        return;
                    }
                    await this.handle(queueUrl, message);
                }
            }),
        );
    }

    private async handle(queueUrl: string, message: Message): Promise<void> {
        const input = this.parse(message);
        const context = {
            messageId: input.messageId,
            correlationId: input.valid ? input.correlationId : input.messageId,
            walletId: input.valid ? input.data.walletId : undefined,
            providerId: input.valid ? input.data.providerId : undefined,
        };
        await RequestContext.run(context, async () => {
            const startedAt = performance.now();
            try {
                const decision = await this.consume.execute(input);
                if (decision.action === "ack" && decision.result) {
                    RequestContext.assign({ transactionId: decision.result.transactionId });
                }
                await this.apply(queueUrl, message, decision);
                this.log.info({
                    event: DECISION_EVENTS[decision.action],
                    receiveCount: input.receiveCount,
                    outcome: decision.action === "ack" ? decision.outcome : undefined,
                    status: decision.action === "ack" ? decision.result?.status : undefined,
                    replay: decision.action === "ack" ? decision.result?.idempotentReplay : undefined,
                    reason: decision.reason,
                    durationMs: Math.round(performance.now() - startedAt),
                });
            } catch (error) {
                this.log.error({ event: "message.handling_failed", err: describeError(error) });
            }
        });
    }

    private parse(message: Message): ConsumeWagerMessageInput {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
        const fallbackId = message.MessageId ?? "unknown";
        let body: unknown;
        try {
            body = JSON.parse(message.Body ?? "");
        } catch {
            return { valid: false, messageId: fallbackId, receiveCount, reason: "malformed JSON" };
        }
        const parsed = wagerMessageSchema.safeParse(body);
        if (!parsed.success) {
            const messageId = (body as { messageId?: unknown })?.messageId;
            return {
                valid: false,
                messageId: typeof messageId === "string" && messageId.length > 0 ? messageId : fallbackId,
                receiveCount,
                reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
            };
        }
        return {
            valid: true,
            messageId: parsed.data.messageId,
            correlationId: parsed.data.correlationId ?? parsed.data.messageId,
            receiveCount,
            data: parsed.data.data,
        };
    }

    private async apply(queueUrl: string, message: Message, decision: ConsumeDecision): Promise<void> {
        switch (decision.action) {
            case "ack":
                this.faults.reach("after-commit-before-ack");
                await this.delete(queueUrl, message);
                return;
            case "retry":
                await this.client.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: queueUrl,
                        ReceiptHandle: message.ReceiptHandle,
                        VisibilityTimeout: decision.delaySeconds,
                    }),
                );
                return;
            case "dead-letter":
                await this.client.send(
                    new SendMessageCommand({
                        QueueUrl: await this.queues.urlOf(this.environment.get("SQS_WAGER_DLQ_NAME")),
                        MessageBody: message.Body ?? "",
                        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
                        MessageDeduplicationId: message.MessageId,
                        MessageAttributes: {
                            deadLetterReason: { DataType: "String", StringValue: decision.reason },
                            sourceMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
                        },
                    }),
                );
                await this.delete(queueUrl, message);
                return;
        }
    }

    private async delete(queueUrl: string, message: Message): Promise<void> {
        await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }

    private async release(queueUrl: string, messages: Message[]): Promise<void> {
        await Promise.all(
            messages.map((message) =>
                this.client
                    .send(
                        new ChangeMessageVisibilityCommand({
                            QueueUrl: queueUrl,
                            ReceiptHandle: message.ReceiptHandle,
                            VisibilityTimeout: 0,
                        }),
                    )
                    .catch((error: unknown) =>
                        this.log.warn({ event: "consumer.release_failed", err: describeError(error) }),
                    ),
            ),
        );
        this.log.info({ event: "consumer.released", count: messages.length });
    }
}
