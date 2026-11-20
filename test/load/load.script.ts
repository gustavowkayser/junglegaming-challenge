import { randomUUID } from "node:crypto";
import os from "node:os";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { Cluster } from "../support/cluster.support";
import { HttpClient } from "../support/http-client.support";
import {
    createTestQueues,
    deleteTestQueues,
    queueDepth,
    sendWagerMessage,
    testSqsClient,
} from "../support/sqs.support";

const settings = {
    durationSeconds: Number(process.env.LOAD_DURATION_S ?? 30),
    concurrency: Number(process.env.LOAD_CONCURRENCY ?? 64),
    wallets: Number(process.env.LOAD_WALLETS ?? 200),
    hotWallets: Number(process.env.LOAD_HOT_WALLETS ?? 5),
    hotShare: Number(process.env.LOAD_HOT_SHARE ?? 0.2),
    sqsShare: Number(process.env.LOAD_SQS_SHARE ?? 0.2),
    replayShare: Number(process.env.LOAD_REPLAY_SHARE ?? 0.05),
    instances: Number(process.env.LOAD_INSTANCES ?? 3),
    targets: process.env.LOAD_TARGETS?.split(",").filter(Boolean) ?? [],
};

type Kind = "BET" | "WIN" | "LOSS" | "REFUND";
interface Target {
    walletId: string;
    playerId: string;
}
interface Payload extends Record<string, unknown> {
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: Kind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
}

const latencies = new Map<string, number[]>();
const statuses = new Map<string, number>();
let httpRequests = 0;
let sqsMessages = 0;

function record(kind: string, ms: number, status: number | string) {
    latencies.set(kind, [...(latencies.get(kind) ?? []), ms]);
    statuses.set(String(status), (statuses.get(String(status)) ?? 0) + 1);
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function cents(min: number, max: number): string {
    const value = Math.floor(min + Math.random() * (max - min));
    return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function chooseKind(): Kind {
    const roll = Math.random();
    if (roll < 0.6) return "BET";
    if (roll < 0.85) return "WIN";
    if (roll < 0.95) return "LOSS";
    return "REFUND";
}

async function scrape(client: HttpClient): Promise<Map<string, number>> {
    const response = await client.get<string>("/metrics");
    const values = new Map<string, number>();
    for (const line of response.body.split("\n")) {
        if (line.startsWith("#") || line.length === 0) continue;
        const separator = line.lastIndexOf(" ");
        values.set(line.slice(0, separator), Number(line.slice(separator + 1)));
    }
    return values;
}

function sumBy(values: Map<string, number>, prefix: string): number {
    let total = 0;
    for (const [key, value] of values) {
        if (key.startsWith(prefix)) total += value;
    }
    return total;
}

async function main() {
    const spawn = settings.targets.length === 0;
    const queues = spawn ? await createTestQueues({ visibilityTimeoutSeconds: 10 }) : undefined;
    const cluster = spawn ? await Cluster.start(settings.instances, { ...queues?.env }) : undefined;
    const clients = spawn
        ? (cluster?.live.map((instance) => instance.http).filter((client): client is HttpClient => !!client) ?? [])
        : settings.targets.map((url) => new HttpClient(url));
    const wagerQueueUrl =
        queues?.wagerQueueUrl ??
        (await testSqsClient().send(new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }))).QueueUrl ??
        "";
    let cursor = 0;
    const nextClient = () => clients[cursor++ % clients.length] as HttpClient;

    console.error(`setting up ${settings.wallets} wallets across ${clients.length} instances`);
    const wallets: Target[] = [];
    for (let index = 0; index < settings.wallets; index += 1) {
        const response = await nextClient().createWallet("1000000.00");
        wallets.push({ walletId: response.body.id, playerId: response.body.playerId });
    }
    const hot = wallets.slice(0, settings.hotWallets);
    const before = await Promise.all(clients.map(scrape));

    const lagSamples: number[] = [];
    const deadline = Date.now() + settings.durationSeconds * 1000;
    const sampler = setInterval(async () => {
        const values = await scrape(nextClient()).catch(() => undefined);
        const lag = values?.get("wagering_outbox_lag_seconds");
        if (lag !== undefined) lagSamples.push(lag);
    }, 1000);

    const startedAt = performance.now();
    await Promise.all(
        Array.from({ length: settings.concurrency }, async () => {
            const processedBets: Payload[] = [];
            const sent: Payload[] = [];
            while (Date.now() < deadline) {
                const target =
                    Math.random() < settings.hotShare
                        ? (hot[Math.floor(Math.random() * hot.length)] as Target)
                        : (wallets[Math.floor(Math.random() * wallets.length)] as Target);
                let kind = chooseKind();
                const refundOf = kind === "REFUND" ? processedBets.shift() : undefined;
                if (kind === "REFUND" && !refundOf) kind = "BET";
                const replay = sent.length > 0 && Math.random() < settings.replayShare;
                const payload: Payload = replay
                    ? (sent[Math.floor(Math.random() * sent.length)] as Payload)
                    : {
                          providerId: "load",
                          externalTransactionId: randomUUID(),
                          walletId: refundOf?.walletId ?? target.walletId,
                          playerId: refundOf?.playerId ?? target.playerId,
                          roundId: refundOf?.roundId ?? randomUUID(),
                          gameId: "load-game",
                          kind,
                          money: refundOf?.money ?? {
                              amount: kind === "LOSS" ? "0.00" : cents(100, 5000),
                              currency: "BRL",
                          },
                          ...(refundOf ? { referenceExternalTransactionId: refundOf.externalTransactionId } : {}),
                      };
                if (!replay) sent.push(payload);
                if (sent.length > 200) sent.shift();

                const viaSqs = !replay && kind !== "REFUND" && Math.random() < settings.sqsShare;
                const started = performance.now();
                if (viaSqs) {
                    await sendWagerMessage(wagerQueueUrl, {
                        messageId: randomUUID(),
                        data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
                    });
                    sqsMessages += 1;
                    record("SQS_SEND", performance.now() - started, "sqs");
                    continue;
                }
                try {
                    const response = await nextClient().submit(payload);
                    httpRequests += 1;
                    record(replay ? "REPLAY" : payload.kind, performance.now() - started, response.status);
                    if (payload.kind === "BET" && response.body.status === "PROCESSED" && !replay) {
                        processedBets.push(payload);
                    }
                } catch {
                    record(payload.kind, performance.now() - started, "network");
                }
            }
        }),
    );
    const elapsedSeconds = (performance.now() - startedAt) / 1000;

    const drainStartedAt = performance.now();
    for (;;) {
        const values = await scrape(nextClient());
        const depth = await queueDepth(wagerQueueUrl);
        if ((values.get("wagering_outbox_pending") ?? 0) === 0 && depth.visible === 0 && depth.inFlight === 0) break;
        const lag = values.get("wagering_outbox_lag_seconds");
        if (lag !== undefined) lagSamples.push(lag);
        await Bun.sleep(500);
    }
    const drainSeconds = (performance.now() - drainStartedAt) / 1000;
    clearInterval(sampler);
    const after = await Promise.all(clients.map(scrape));

    let consistent = 0;
    for (const target of wallets) {
        const report = await nextClient().post<{ consistent: boolean }>(
            `/wallets/${target.walletId}/reconciliation`,
            {},
        );
        if (report.body.consistent) consistent += 1;
    }

    const delta = (prefix: string) =>
        after.reduce((total, values) => total + sumBy(values, prefix), 0) -
        before.reduce((total, values) => total + sumBy(values, prefix), 0);
    const all = [...latencies.entries()].filter(([kind]) => kind !== "SQS_SEND").flatMap(([, values]) => values);
    const errors = [...statuses.entries()].filter(([status]) => !["200", "202", "422", "sqs"].includes(status));
    const result = {
        environment: {
            os: `${os.type()} ${os.release()} (${os.arch()})`,
            cpu: `${os.cpus()[0]?.model ?? "unknown"} x${os.cpus().length}`,
            memoryGb: Math.round(os.totalmem() / 1024 ** 3),
            bun: Bun.version,
            instances: clients.length,
            mode: spawn ? "spawned processes" : "external targets",
        },
        settings,
        throughput: {
            httpRequestsPerSecond: Math.round(httpRequests / elapsedSeconds),
            sqsMessagesPerSecond: Math.round(sqsMessages / elapsedSeconds),
            elapsedSeconds: Math.round(elapsedSeconds),
            httpRequests,
            sqsMessages,
        },
        latencyMs: Object.fromEntries(
            [["ALL", all] as const, ...latencies.entries()].map(([kind, values]) => [
                kind,
                {
                    count: values.length,
                    p50: Math.round(percentile([...values], 50)),
                    p95: Math.round(percentile([...values], 95)),
                    p99: Math.round(percentile([...values], 99)),
                },
            ]),
        ),
        statuses: Object.fromEntries(statuses),
        errorRate: Number(
            (errors.reduce((total, [, count]) => total + count, 0) / Math.max(1, httpRequests)).toFixed(4),
        ),
        concurrency: {
            lockConflicts: delta("wagering_lock_conflicts_total"),
            useCaseRetries: delta('wagering_retries_total{component="use_case"'),
            insufficientFunds: delta('wagering_transactions_total{kind="BET",status="REJECTED"'),
            duplicatesDetected: delta("wagering_duplicates_total"),
        },
        outboxLagSeconds: {
            samples: lagSamples.length,
            max: Number(Math.max(0, ...lagSamples).toFixed(3)),
            avg: Number((lagSamples.reduce((a, b) => a + b, 0) / Math.max(1, lagSamples.length)).toFixed(3)),
            p95: Number(percentile(lagSamples, 95).toFixed(3)),
        },
        drainSecondsAfterLoad: Number(drainSeconds.toFixed(1)),
        invariant: { wallets: wallets.length, consistent },
    };
    console.log(JSON.stringify(result, null, 2));

    await cluster?.stop();
    if (queues) await deleteTestQueues(queues);
    process.exit(consistent === wallets.length ? 0 : 1);
}

await main();
