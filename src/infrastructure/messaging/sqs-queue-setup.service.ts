import {
    CreateQueueCommand,
    GetQueueAttributesCommand,
    SetQueueAttributesCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";

export interface QueueTopology {
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    maxReceiveCount: number;
    visibilityTimeoutSeconds: number;
}

export interface QueueUrls {
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    eventsQueueUrl: string;
}

async function createFifoQueue(client: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
    const created = await client.send(
        new CreateQueueCommand({
            QueueName: name,
            Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", ...attributes },
        }),
    );
    if (!created.QueueUrl) {
        throw new Error(`Queue ${name} was not created`);
    }
    return created.QueueUrl;
}

export async function ensureQueues(client: SQSClient, topology: QueueTopology): Promise<QueueUrls> {
    const wagerDlqUrl = await createFifoQueue(client, topology.wagerDlqName, { MessageRetentionPeriod: "1209600" });
    const dlqAttributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: wagerDlqUrl, AttributeNames: ["QueueArn"] }),
    );
    const deadLetterTargetArn = dlqAttributes.Attributes?.QueueArn;
    if (!deadLetterTargetArn) {
        throw new Error(`Queue ${topology.wagerDlqName} has no ARN`);
    }
    const wagerAttributes = {
        VisibilityTimeout: String(topology.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: String(topology.maxReceiveCount) }),
    };
    const wagerQueueUrl = await createFifoQueue(client, topology.wagerQueueName, {});
    await client.send(new SetQueueAttributesCommand({ QueueUrl: wagerQueueUrl, Attributes: wagerAttributes }));
    const eventsQueueUrl = await createFifoQueue(client, topology.eventsQueueName, {});
    return { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl };
}
