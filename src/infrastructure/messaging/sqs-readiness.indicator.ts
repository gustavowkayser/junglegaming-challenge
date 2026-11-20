import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import { HealthIndicatorService } from "@nestjs/terminus";
import { EnvironmentService } from "../config/environment.service";
import type { ReadinessIndicator } from "../health/readiness-indicator.port";
import { SqsQueueRegistry } from "./sqs-queue-registry.service";

@Injectable()
export class SqsReadinessIndicator implements ReadinessIndicator {
    constructor(
        private readonly client: SQSClient,
        private readonly queues: SqsQueueRegistry,
        private readonly environment: EnvironmentService,
        private readonly health: HealthIndicatorService,
    ) {}

    async check() {
        return this.health
            .check("sqs")
            .attempt(async ({ signal }) => {
                const queueUrl = await this.queues.urlOf(this.environment.get("SQS_WAGER_QUEUE_NAME"));
                await this.client.send(
                    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
                    { abortSignal: signal },
                );
            })
            .withTimeout(1500)
            .withSuccessData({});
    }
}
