import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { PublishOutboxUseCase } from "../../application/messaging/publish-outbox.use-case";
import { EnvironmentService } from "../config/environment.service";
import { AppLogger } from "../observability/logger.service";
import { PollingLoop } from "./polling-loop.service";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly loop: PollingLoop;

    constructor(
        private readonly publishOutbox: PublishOutboxUseCase,
        private readonly environment: EnvironmentService,
        logger: AppLogger,
    ) {
        const log = logger.child("OutboxPublisherWorker");
        this.loop = new PollingLoop(
            "outbox-publisher",
            environment.get("OUTBOX_POLL_INTERVAL_MS"),
            async () => {
                const result = await this.publishOutbox.execute();
                if (result.claimed.length > 0) {
                    log.info({
                        event: "outbox.batch_published",
                        claimed: result.claimed.length,
                        published: result.published,
                        failed: result.failed,
                    });
                }
                return result.claimed.length;
            },
            log,
        );
    }

    onApplicationBootstrap(): void {
        if (this.environment.get("OUTBOX_PUBLISHER_ENABLED")) {
            this.loop.start();
        }
    }

    async beforeApplicationShutdown(): Promise<void> {
        await this.loop.stop();
    }
}
