import { eventually } from "./app-process.support";
import { sql } from "./database.support";
import { drainQueue, queueDepth, type TestQueues } from "./sqs.support";

async function counts() {
    const [row] = await sql<{ pending_references: string; pending_outbox: string; unprocessed_inbox: string }>(
        `select
            (select count(*) from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')) as pending_references,
            (select count(*) from outbox_messages where published_at is null) as pending_outbox,
            (select count(*) from inbox_messages where processed_at is null) as unprocessed_inbox`,
    );
    return {
        pendingReferences: Number(row?.pending_references ?? 0),
        pendingOutbox: Number(row?.pending_outbox ?? 0),
        unprocessedInbox: Number(row?.unprocessed_inbox ?? 0),
    };
}

export async function waitForQuiescence(queues: TestQueues, timeoutMs = 60_000): Promise<void> {
    await eventually(
        async () => ({ ...(await counts()), queue: await queueDepth(queues.wagerQueueUrl) }),
        (state) =>
            state.pendingReferences === 0 &&
            state.pendingOutbox === 0 &&
            state.unprocessedInbox === 0 &&
            state.queue.visible === 0 &&
            state.queue.inFlight === 0,
        timeoutMs,
        250,
    );
}

export async function assertEventsPublishedOnce(queues: TestQueues): Promise<void> {
    const [row] = await sql<{ total: string }>("select count(*) as total from outbox_messages");
    const total = Number(row?.total ?? 0);
    const received = await drainQueue(queues.eventsQueueUrl, { timeoutMs: 60_000, idleMs: 3_000 });
    const unique = new Set(received.map((message) => String(message.body.eventId)));
    if (unique.size !== total) {
        throw new Error(`Expected ${total} distinct events on the broker, received ${unique.size}`);
    }
}
