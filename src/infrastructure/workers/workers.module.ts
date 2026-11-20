import { Module } from "@nestjs/common";
import { PublishOutboxUseCase } from "../../application/messaging/publish-outbox.use-case";
import { CLOCK, type Clock } from "../../application/ports/clock.port";
import { EVENT_PUBLISHER, type EventPublisher } from "../../application/ports/event-publisher.port";
import { FAULT_INJECTOR, type FaultInjector } from "../../application/ports/fault-injector.port";
import { METRICS, type Metrics } from "../../application/ports/metrics.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports/unit-of-work.port";
import { EnvironmentService } from "../config/environment.service";
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
        OutboxPublisherWorker,
    ],
    exports: [PublishOutboxUseCase],
})
export class WorkersModule {}
