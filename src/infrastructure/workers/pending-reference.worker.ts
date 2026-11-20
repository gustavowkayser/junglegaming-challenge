import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import type { Logger } from "pino";
import {
    type ResolutionObserver,
    ResolvePendingReferencesUseCase,
} from "../../application/wagering/resolve-pending-references.use-case";
import { EnvironmentService } from "../config/environment.service";
import { describeError } from "../observability/error-description.service";
import { AppLogger } from "../observability/logger.service";
import { RequestContext } from "../observability/request-context.service";
import { PollingLoop } from "./polling-loop.service";

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly loop: PollingLoop;
    private readonly log: Logger;

    constructor(
        private readonly resolvePendingReferences: ResolvePendingReferencesUseCase,
        private readonly environment: EnvironmentService,
        logger: AppLogger,
    ) {
        this.log = logger.child("PendingReferenceWorker");
        const observer: ResolutionObserver = {
            resolved: (report) => {
                if (report.outcome !== "skipped") {
                    RequestContext.run({ transactionId: report.transactionId }, () =>
                        this.log.info({
                            event: "pending_reference.resolved",
                            outcome: report.outcome,
                            failureCode: report.failureCode,
                        }),
                    );
                }
            },
            failed: (transactionId, error) =>
                RequestContext.run({ transactionId }, () =>
                    this.log.error({ event: "pending_reference.failed", err: describeError(error) }),
                ),
        };
        this.loop = new PollingLoop(
            "pending-reference",
            environment.get("PENDING_REFERENCE_POLL_INTERVAL_MS"),
            async () => {
                const reports = await this.resolvePendingReferences.execute(observer);
                return reports.filter((report) => report.outcome !== "skipped" && report.outcome !== "deferred").length;
            },
            this.log,
        );
    }

    onApplicationBootstrap(): void {
        if (this.environment.get("PENDING_REFERENCE_WORKER_ENABLED")) {
            this.loop.start();
        }
    }

    async beforeApplicationShutdown(): Promise<void> {
        await this.loop.stop();
    }
}
