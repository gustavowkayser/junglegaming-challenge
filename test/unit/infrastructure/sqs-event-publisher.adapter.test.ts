import { describe, expect, test } from "bun:test";
import type { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message.entity";
import { SqsEventPublisher } from "../../../src/infrastructure/messaging/sqs-event-publisher.adapter";
import type { SqsQueueRegistry } from "../../../src/infrastructure/messaging/sqs-queue-registry.service";

function message(id: string, aggregateId: string): OutboxMessage {
    return OutboxMessage.rehydrate({
        id,
        aggregateId,
        eventType: "WalletBalanceChanged",
        payload: { eventId: id, correlationId: "c" },
        occurredAt: new Date(),
        attempts: 0,
        nextAttemptAt: new Date(),
        publishedAt: undefined,
        lastError: undefined,
    });
}

function fakeClient(failIds: string[] = [], throwOnCall?: number) {
    const sent: { group: string; id: string }[][] = [];
    let calls = 0;
    const client = {
        send: async (command: SendMessageBatchCommand) => {
            calls += 1;
            if (throwOnCall === calls) {
                throw new Error("broker down");
            }
            const entries = command.input.Entries ?? [];
            sent.push(entries.map((entry) => ({ group: entry.MessageGroupId ?? "", id: entry.Id ?? "" })));
            return {
                Successful: entries
                    .filter((entry) => !failIds.includes(entry.Id ?? ""))
                    .map((entry) => ({ Id: entry.Id })),
                Failed: entries
                    .filter((entry) => failIds.includes(entry.Id ?? ""))
                    .map((entry) => ({ Id: entry.Id, Code: "InternalError", Message: "x", SenderFault: false })),
            };
        },
    } as unknown as SQSClient;
    return { client, sent };
}

const registry = { urlOf: async () => "queue-url" } as unknown as SqsQueueRegistry;

describe("SqsEventPublisher", () => {
    test("publishes every message in batches of at most 10 with the aggregate as FIFO group", async () => {
        const { client, sent } = fakeClient();
        const messages = Array.from({ length: 35 }, (_, index) => message(`m${index}`, `wallet-${index % 7}`));

        const report = await new SqsEventPublisher(client, registry, "events.fifo").publish(messages);

        expect(report.published.sort()).toEqual(messages.map((item) => item.id).sort());
        expect(report.failed).toEqual([]);
        expect(sent.every((batch) => batch.length <= 10)).toBe(true);
    });

    test("keeps the relative order of each aggregate", async () => {
        const { client, sent } = fakeClient();
        const messages = Array.from({ length: 40 }, (_, index) => message(`m${index}`, `wallet-${index % 3}`));

        await new SqsEventPublisher(client, registry, "events.fifo").publish(messages);

        for (const aggregate of ["wallet-0", "wallet-1", "wallet-2"]) {
            const sentOrder = sent
                .flat()
                .filter((entry) => entry.group === aggregate)
                .map((entry) => entry.id);
            const expected = messages.filter((item) => item.aggregateId === aggregate).map((item) => item.id);
            expect(sentOrder).toEqual(expected);
        }
    });

    test("holds back later events of an aggregate whose earlier event failed", async () => {
        const messages = Array.from({ length: 15 }, (_, index) => message(`m${index}`, "wallet-x"));
        const { client } = fakeClient(["m3"]);

        const report = await new SqsEventPublisher(client, registry, "events.fifo", 1).publish(messages);

        expect(report.published).toEqual(
            messages
                .slice(0, 10)
                .filter((item) => item.id !== "m3")
                .map((item) => item.id),
        );
        expect(report.failed.map((failure) => failure.id).sort()).toEqual(
            ["m3", ...messages.slice(10).map((item) => item.id)].sort(),
        );
    });

    test("a broker error fails the remaining messages of that lane only", async () => {
        const messages = Array.from({ length: 20 }, (_, index) => message(`m${index}`, `wallet-${index}`));
        const { client } = fakeClient([], 1);

        const report = await new SqsEventPublisher(client, registry, "events.fifo", 2).publish(messages);

        expect(report.published.length + report.failed.length).toBe(20);
        expect(report.failed.length).toBeGreaterThan(0);
        expect(report.failed.every((failure) => failure.error === "broker down")).toBe(true);
    });
});
