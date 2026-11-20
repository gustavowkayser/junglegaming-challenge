import { Module } from "@nestjs/common";
import { ConsumeWagerMessageUseCase } from "../../application/messaging/consume-wager-message.use-case";
import { PublishOutboxUseCase } from "../../application/messaging/publish-outbox.use-case";
import { CLOCK, type Clock } from "../../application/ports/clock.port";
import { EVENT_PUBLISHER, type EventPublisher } from "../../application/ports/event-publisher.port";
import { FAULT_INJECTOR, type FaultInjector } from "../../application/ports/fault-injector.port";
import { METRICS, type Metrics } from "../../application/ports/metrics.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports/unit-of-work.port";
import { SubmitWagerTransactionUseCase } from "../../application/wagering/submit-wager-transaction.use-case";
import { WagerPayloadHasher } from "../../application/wagering/wager-transaction-payload.service";
import { EnvironmentService } from "../config/environment.service";
import { SqsWagerConsumer } from "../messaging/sqs-wager.consumer";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";

@Module({
    providers: [
        {
            provide: PublishOutboxUseCase,
            inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, METRICS, FAULT_INJECTOR, EnvironmentService],
            useFactory: (
                unitOfWork: UnitOfWork,
                publisher: EventPublisher,
                clock: Clock,
                metrics: Metrics,
                faults: FaultInjector,
                environment: EnvironmentService,
            ) =>
                new PublishOutboxUseCase(
                    unitOfWork,
                    publisher,
                    clock,
                    metrics,
                    faults,
                    environment.get("OUTBOX_BATCH_SIZE"),
                ),
        },
        {
            provide: ConsumeWagerMessageUseCase,
            inject: [SubmitWagerTransactionUseCase, WagerPayloadHasher, METRICS, EnvironmentService],
            useFactory: (
                submit: SubmitWagerTransactionUseCase,
                hasher: WagerPayloadHasher,
                metrics: Metrics,
                environment: EnvironmentService,
            ) =>
                new ConsumeWagerMessageUseCase(submit, hasher, metrics, {
                    consumerName: environment.get("SQS_CONSUMER_NAME"),
                    maxReceiveCount: environment.get("SQS_MAX_RECEIVE_COUNT"),
                    maxRetryDelaySeconds: 300,
                }),
        },
        OutboxPublisherWorker,
        SqsWagerConsumer,
    ],
    exports: [PublishOutboxUseCase],
})
export class WorkersModule {}
