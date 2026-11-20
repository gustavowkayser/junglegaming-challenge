import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";

export class SqsQueueRegistry {
    private readonly urls = new Map<string, Promise<string>>();

    constructor(private readonly client: SQSClient) {}

    urlOf(queueName: string): Promise<string> {
        let url = this.urls.get(queueName);
        if (!url) {
            url = this.client.send(new GetQueueUrlCommand({ QueueName: queueName })).then((output) => {
                if (!output.QueueUrl) {
                    throw new Error(`Queue ${queueName} does not exist`);
                }
                return output.QueueUrl;
            });
            url.catch(() => this.urls.delete(queueName));
            this.urls.set(queueName, url);
        }
        return url;
    }
}
