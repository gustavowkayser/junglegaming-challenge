import type { MoneyProps } from "../../domain/money/money.types";
import type { SubmittableKind } from "../../domain/wagering/wager-transaction-kind.enum";
import {
    IdempotencyConflictError,
    InvariantViolationError,
    NotFoundError,
    PermanentMessageError,
    ValidationError,
} from "../errors/application.error";
import type { Metrics } from "../ports/metrics.port";
import type { SubmitWagerTransactionUseCase } from "../wagering/submit-wager-transaction.use-case";
import type { WagerTransactionResult } from "../wagering/wager-transaction.view";
import type { WagerPayloadHasher } from "../wagering/wager-transaction-payload.service";

export interface WagerMessageData {
    idempotencyKey: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: SubmittableKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string | undefined;
}

export type ConsumeWagerMessageInput =
    | {
          valid: true;
          messageId: string;
          correlationId: string;
          receiveCount: number;
          data: WagerMessageData;
      }
    | { valid: false; messageId: string; receiveCount: number; reason: string };

export type ConsumeDecision =
    | { action: "ack"; outcome: "processed" | "business_rejection"; result?: WagerTransactionResult; reason?: string }
    | { action: "retry"; delaySeconds: number; reason: string }
    | { action: "dead-letter"; reason: string };

export interface ConsumeSettings {
    consumerName: string;
    maxReceiveCount: number;
    maxRetryDelaySeconds: number;
}

export class ConsumeWagerMessageUseCase {
    constructor(
        private readonly submit: SubmitWagerTransactionUseCase,
        private readonly payloadHasher: WagerPayloadHasher,
        private readonly metrics: Metrics,
        private readonly settings: ConsumeSettings,
    ) {}

    async execute(input: ConsumeWagerMessageInput): Promise<ConsumeDecision> {
        if (!input.valid) {
            return this.deadLetter("INVALID_MESSAGE");
        }
        try {
            const result = await this.submit.execute({
                ...input.data,
                source: "sqs",
                correlationId: input.correlationId,
                causationId: input.messageId,
                inbox: {
                    consumerName: this.settings.consumerName,
                    messageId: input.messageId,
                    payloadHash: this.payloadHasher.hashValue(input.data),
                },
            });
            return { action: "ack", outcome: "processed", result };
        } catch (error) {
            return this.classify(error, input.receiveCount);
        }
    }

    private classify(error: unknown, receiveCount: number): ConsumeDecision {
        if (error instanceof IdempotencyConflictError) {
            return { action: "ack", outcome: "business_rejection", reason: error.code };
        }
        if (error instanceof NotFoundError) {
            return { action: "ack", outcome: "business_rejection", reason: error.code };
        }
        if (error instanceof ValidationError) {
            return this.deadLetter("INVALID_MESSAGE");
        }
        if (error instanceof PermanentMessageError) {
            return this.deadLetter(error.code);
        }
        if (error instanceof InvariantViolationError) {
            return this.deadLetter("PROCESSING_ERROR");
        }
        if (receiveCount >= this.settings.maxReceiveCount) {
            return this.deadLetter("RETRIES_EXHAUSTED");
        }
        const reason = (error as { reason?: unknown })?.reason;
        const retryReason = typeof reason === "string" ? reason : "unexpected_error";
        this.metrics.retryScheduled("sqs", retryReason);
        return {
            action: "retry",
            delaySeconds: Math.min(this.settings.maxRetryDelaySeconds, 2 ** Math.max(0, receiveCount)),
            reason: retryReason,
        };
    }

    private deadLetter(reason: string): ConsumeDecision {
        this.metrics.deadLettered(reason);
        return { action: "dead-letter", reason };
    }
}
