import { Module } from "@nestjs/common";
import { ConsumeWagerMessageUseCase } from "../../application/messaging/consume-wager-message.use-case";
import { PublishOutboxUseCase } from "../../application/messaging/publish-outbox.use-case";
import { CLOCK, type Clock } from "../../application/ports/clock.port";
import { EVENT_PUBLISHER, type EventPublisher } from "../../application/ports/event-publisher.port";
import { FAULT_INJECTOR, type FaultInjector } from "../../application/ports/fault-injector.port";
import { ID_GENERATOR, type IdGenerator } from "../../application/ports/id-generator.port";
import { METRICS, type Metrics } from "../../application/ports/metrics.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports/unit-of-work.port";
import { EventContextFactory } from "../../application/shared/event-context.factory";
import { ResolvePendingReferencesUseCase } from "../../application/wagering/resolve-pending-references.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/wagering/submit-wager-transaction.use-case";
import { WagerPayloadHasher } from "../../application/wagering/wager-transaction-payload.service";
import { WagerSettlementService } from "../../domain/wagering/wager-settlement.service";
import { EnvironmentService } from "../config/environment.service";
import { SqsWagerConsumer } from "../messaging/sqs-wager.consumer";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";
import { PendingReferenceWorker } from "./pending-reference.worker";

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
        {
            provide: ResolvePendingReferencesUseCase,
            inject: [
                UNIT_OF_WORK,
                WagerSettlementService,
                ID_GENERATOR,
                CLOCK,
                EventContextFactory,
                METRICS,
                EnvironmentService,
            ],
            useFactory: (
                unitOfWork: UnitOfWork,
                settlement: WagerSettlementService,
                ids: IdGenerator,
                clock: Clock,
                events: EventContextFactory,
                metrics: Metrics,
                environment: EnvironmentService,
            ) =>
                new ResolvePendingReferencesUseCase(
                    unitOfWork,
                    settlement,
                    ids,
                    clock,
                    events,
                    metrics,
                    environment.get("PENDING_REFERENCE_BATCH_SIZE"),
                ),
        },
        OutboxPublisherWorker,
        SqsWagerConsumer,
        PendingReferenceWorker,
    ],
    exports: [PublishOutboxUseCase, ResolvePendingReferencesUseCase],
})
export class WorkersModule {}
