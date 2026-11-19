import { parseEnvironment } from "../src/infrastructure/config/environment.schema";
import { createSqsClient } from "../src/infrastructure/messaging/sqs-client.factory";
import { ensureQueues } from "../src/infrastructure/messaging/sqs-queue-setup.service";

const environment = parseEnvironment(process.env);
const client = createSqsClient(environment);

const urls = await ensureQueues(client, {
    wagerQueueName: environment.SQS_WAGER_QUEUE_NAME,
    wagerDlqName: environment.SQS_WAGER_DLQ_NAME,
    eventsQueueName: environment.SQS_EVENTS_QUEUE_NAME,
    maxReceiveCount: environment.SQS_MAX_RECEIVE_COUNT,
    visibilityTimeoutSeconds: environment.SQS_VISIBILITY_TIMEOUT_SECONDS,
});

console.log(JSON.stringify(urls, null, 4));
client.destroy();
