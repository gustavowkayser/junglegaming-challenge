import { describe, expect, test } from "bun:test";
import {
    IdempotencyConflictError,
    InvariantViolationError,
    NotFoundError,
    PermanentMessageError,
    TransientInfrastructureError,
    UniqueConstraintRaceError,
    ValidationError,
} from "../../../src/application/errors/application.error";
import {
    type ConsumeWagerMessageInput,
    ConsumeWagerMessageUseCase,
} from "../../../src/application/messaging/consume-wager-message.use-case";
import type { RetryComponent } from "../../../src/application/ports/metrics.port";
import type { SubmitWagerTransactionCommand } from "../../../src/application/wagering/submit-wager-transaction.command";
import type { SubmitWagerTransactionUseCase } from "../../../src/application/wagering/submit-wager-transaction.use-case";
import { WagerPayloadHasher } from "../../../src/application/wagering/wager-transaction-payload.service";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind.enum";
import { NoopMetrics } from "../../../src/infrastructure/observability/noop-metrics.adapter";
import { Sha256PayloadHasher } from "../../../src/infrastructure/system/sha256-payload-hasher.adapter";

const data = {
    idempotencyKey: "provider-a:tx-1",
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: { amount: "10.00", currency: "BRL" },
} as const;

const valid = (receiveCount = 1): ConsumeWagerMessageInput => ({
    valid: true,
    messageId: "msg-1",
    correlationId: "corr-1",
    receiveCount,
    data,
});

class RecordingMetrics extends NoopMetrics {
    readonly retries: string[] = [];
    readonly deadLetters: string[] = [];

    override retryScheduled(_component: RetryComponent, reason: string): void {
        this.retries.push(reason);
    }

    override deadLettered(reason: string): void {
        this.deadLetters.push(reason);
    }
}

function useCase(outcome: () => Promise<unknown>, metrics = new RecordingMetrics()) {
    const calls: SubmitWagerTransactionCommand[] = [];
    const submit = {
        execute: (command: SubmitWagerTransactionCommand) => {
            calls.push(command);
            return outcome();
        },
    } as unknown as SubmitWagerTransactionUseCase;
    const instance = new ConsumeWagerMessageUseCase(
        submit,
        new WagerPayloadHasher(new Sha256PayloadHasher()),
        metrics,
        { consumerName: "consumer", maxReceiveCount: 5, maxRetryDelaySeconds: 300 },
    );
    return { instance, calls, metrics };
}

describe("ConsumeWagerMessageUseCase", () => {
    test("reuses the submit use case with an inbox receipt and acks the result", async () => {
        const result = { transactionId: "t", status: "PROCESSED", idempotentReplay: false };
        const { instance, calls } = useCase(async () => result);

        expect(await instance.execute(valid())).toEqual({ action: "ack", outcome: "processed", result });
        expect(calls[0]).toMatchObject({
            ...data,
            source: "sqs",
            correlationId: "corr-1",
            causationId: "msg-1",
            inbox: {
                consumerName: "consumer",
                messageId: "msg-1",
                payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
        });
    });

    test("business rejections persisted by the use case are acked like any result", async () => {
        const rejected = {
            transactionId: "t",
            status: "REJECTED",
            failureCode: "INSUFFICIENT_FUNDS",
            idempotentReplay: false,
        };
        const { instance } = useCase(async () => rejected);

        expect((await instance.execute(valid())).action).toBe("ack");
    });

    test.each([
        ["idempotency conflict", new IdempotencyConflictError("conflict")],
        ["unknown wallet", new NotFoundError("WALLET_NOT_FOUND", "missing")],
    ])("%s is a terminal business outcome and is acked", async (_name, error) => {
        const { instance } = useCase(async () => {
            throw error;
        });

        expect(await instance.execute(valid())).toMatchObject({ action: "ack", outcome: "business_rejection" });
    });

    test.each([
        ["invalid envelope", undefined, "INVALID_MESSAGE"],
        ["invalid business payload", new ValidationError("bad"), "INVALID_MESSAGE"],
        ["inbox payload mismatch", new PermanentMessageError("INBOX_PAYLOAD_MISMATCH", "x"), "INBOX_PAYLOAD_MISMATCH"],
        ["invariant violation", new InvariantViolationError("x"), "PROCESSING_ERROR"],
    ])("%s is permanent and goes to the DLQ", async (_name, error, reason) => {
        const { instance, metrics, calls } = useCase(async () => {
            throw error;
        });
        const input: ConsumeWagerMessageInput =
            error === undefined ? { valid: false, messageId: "m", receiveCount: 1, reason: "bad json" } : valid();

        expect(await instance.execute(input)).toEqual({ action: "dead-letter", reason });
        expect(metrics.deadLetters).toEqual([reason]);
        if (error === undefined) {
            expect(calls.length).toBe(0);
        }
    });

    test.each([
        ["lock timeout", new TransientInfrastructureError("lock_timeout", "x"), "lock_timeout"],
        ["database down", new TransientInfrastructureError("connection", "x"), "connection"],
        ["unique race", new UniqueConstraintRaceError("x"), "unexpected_error"],
        ["unexpected error", new Error("boom"), "unexpected_error"],
    ])("%s is transient and retried with exponential backoff", async (_name, error, reason) => {
        const { instance, metrics } = useCase(async () => {
            throw error;
        });

        expect(await instance.execute(valid(1))).toEqual({ action: "retry", delaySeconds: 2, reason });
        expect(await instance.execute(valid(3))).toEqual({ action: "retry", delaySeconds: 8, reason });
        expect(metrics.retries).toEqual([reason, reason]);
    });

    test("retry delay is capped", async () => {
        const { instance } = useCase(async () => {
            throw new TransientInfrastructureError("connection", "x");
        });
        const capped = new ConsumeWagerMessageUseCase(
            (instance as unknown as { submit: SubmitWagerTransactionUseCase }).submit,
            new WagerPayloadHasher(new Sha256PayloadHasher()),
            new NoopMetrics(),
            { consumerName: "c", maxReceiveCount: 100, maxRetryDelaySeconds: 300 },
        );

        expect(await capped.execute(valid(20))).toMatchObject({ action: "retry", delaySeconds: 300 });
    });

    test("transient failures beyond the receive limit go to the DLQ", async () => {
        const { instance } = useCase(async () => {
            throw new TransientInfrastructureError("connection", "x");
        });

        expect(await instance.execute(valid(5))).toEqual({ action: "dead-letter", reason: "RETRIES_EXHAUSTED" });
    });
});
