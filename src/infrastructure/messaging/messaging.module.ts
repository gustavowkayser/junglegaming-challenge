import { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { EVENT_PUBLISHER } from "../../application/ports/event-publisher.port";
import { EnvironmentService } from "../config/environment.service";
import { createSqsClient } from "./sqs-client.factory";
import { SqsEventPublisher } from "./sqs-event-publisher.adapter";
import { SqsQueueRegistry } from "./sqs-queue-registry.service";
import { SqsReadinessIndicator } from "./sqs-readiness.indicator";

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
    constructor(private readonly client: SQSClient) {}

    onApplicationShutdown(): void {
        this.client.destroy();
    }
}

@Global()
@Module({
    imports: [TerminusModule],
    providers: [
        {
            provide: SQSClient,
            inject: [EnvironmentService],
            useFactory: (environment: EnvironmentService) =>
                createSqsClient({
                    AWS_REGION: environment.get("AWS_REGION"),
                    AWS_ENDPOINT_URL: environment.get("AWS_ENDPOINT_URL"),
                    AWS_ACCESS_KEY_ID: environment.get("AWS_ACCESS_KEY_ID"),
                    AWS_SECRET_ACCESS_KEY: environment.get("AWS_SECRET_ACCESS_KEY"),
                }),
        },
        {
            provide: SqsQueueRegistry,
            inject: [SQSClient],
            useFactory: (client: SQSClient) => new SqsQueueRegistry(client),
        },
        {
            provide: EVENT_PUBLISHER,
            inject: [SQSClient, SqsQueueRegistry, EnvironmentService],
            useFactory: (client: SQSClient, queues: SqsQueueRegistry, environment: EnvironmentService) =>
                new SqsEventPublisher(client, queues, environment.get("SQS_EVENTS_QUEUE_NAME")),
        },
        SqsClientLifecycle,
        SqsReadinessIndicator,
    ],
    exports: [SQSClient, SqsQueueRegistry, EVENT_PUBLISHER, SqsReadinessIndicator],
})
export class MessagingModule {}
