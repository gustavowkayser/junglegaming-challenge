import { SQSClient } from "@aws-sdk/client-sqs";
import type { Environment } from "../config/environment.schema";

export type SqsEnvironment = Pick<
    Environment,
    "AWS_REGION" | "AWS_ENDPOINT_URL" | "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY"
>;

export function createSqsClient(environment: SqsEnvironment): SQSClient {
    return new SQSClient({
        region: environment.AWS_REGION,
        endpoint: environment.AWS_ENDPOINT_URL,
        credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID,
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
        },
        maxAttempts: 3,
        useQueueUrlAsEndpoint: false,
    });
}
