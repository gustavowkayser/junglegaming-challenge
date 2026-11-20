import type { Clock } from "../ports/clock.port";
import type { EventPublisher, PublishReport } from "../ports/event-publisher.port";
import type { FaultInjector } from "../ports/fault-injector.port";
import type { Metrics } from "../ports/metrics.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";

export interface PublishOutboxResult {
    claimed: string[];
    published: number;
    failed: number;
}

export class PublishOutboxUseCase {
    constructor(
        private readonly unitOfWork: UnitOfWork,
        private readonly publisher: EventPublisher,
        private readonly clock: Clock,
        private readonly metrics: Metrics,
        private readonly faults: FaultInjector,
        private readonly batchSize: number,
    ) {}

    async execute(): Promise<PublishOutboxResult> {
        return this.unitOfWork.run(async (repositories) => {
            const batch = await repositories.outbox.claimDue(this.clock.now(), this.batchSize);
            if (batch.length === 0) {
                return { claimed: [], published: 0, failed: 0 };
            }
            const report = await this.safePublish(
                batch.map((message) => message.id),
                () => this.publisher.publish(batch),
            );
            this.faults.reach("before-publish-commit");

            const now = this.clock.now();
            const published = new Set(report.published);
            const failures = new Map(report.failed.map((failure) => [failure.id, failure.error]));
            for (const message of batch) {
                if (published.has(message.id)) {
                    message.markPublished(now);
                } else {
                    message.scheduleRetry(now, failures.get(message.id) ?? "not acknowledged by broker");
                    this.metrics.retryScheduled("outbox", "publish_failed");
                }
            }
            await repositories.outbox.updateMany(batch);
            this.metrics.outboxPublished(published.size);
            return { claimed: batch.map((message) => message.id), published: published.size, failed: failures.size };
        });
    }

    private async safePublish(ids: string[], publish: () => Promise<PublishReport>): Promise<PublishReport> {
        try {
            return await publish();
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { published: [], failed: ids.map((id) => ({ id, error: reason })) };
        }
    }
}
