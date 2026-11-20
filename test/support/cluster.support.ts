import { AppProcess } from "./app-process.support";
import type { HttpClient, HttpResult } from "./http-client.support";

export const CLUSTER_ENV: Record<string, string> = {
    DB_POOL_MAX: "20",
    SQS_WAIT_TIME_SECONDS: "1",
    OUTBOX_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_BASE_DELAY_MS: "100",
    PENDING_REFERENCE_MAX_DELAY_MS: "1000",
    SHUTDOWN_TIMEOUT_MS: "10000",
};

type SubmitResult = Awaited<ReturnType<HttpClient["submit"]>>;

export class Cluster {
    private cursor = 0;

    private constructor(
        readonly instances: (AppProcess | undefined)[],
        private readonly env: Record<string, string>,
    ) {}

    static async start(size: number, env: Record<string, string>): Promise<Cluster> {
        const merged = { ...CLUSTER_ENV, ...env };
        const instances = await Promise.all(Array.from({ length: size }, () => AppProcess.start({ env: merged })));
        return new Cluster(instances, merged);
    }

    get live(): AppProcess[] {
        return this.instances.filter((instance): instance is AppProcess => instance !== undefined);
    }

    next(): HttpClient {
        const live = this.live;
        const instance = live[this.cursor++ % live.length];
        if (!instance?.http) {
            throw new Error("No live HTTP instance");
        }
        return instance.http;
    }

    async submitWithFailover(payload: Record<string, unknown>, attempts = 8): Promise<SubmitResult> {
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await this.next().submit(payload);
                if (response.status !== 503) {
                    return response;
                }
                lastError = new Error("503");
            } catch (error) {
                lastError = error;
            }
            await Bun.sleep(100 * (attempt + 1));
        }
        throw lastError;
    }

    async createWallet(amount: string): Promise<HttpResult<{ id: string; playerId: string }>> {
        return this.next().createWallet(amount);
    }

    async kill(index: number, signal: "SIGKILL" | "SIGTERM"): Promise<number> {
        const instance = this.instances[index];
        if (!instance) {
            return -1;
        }
        this.instances[index] = undefined;
        return instance.stop(signal);
    }

    async restart(index: number): Promise<void> {
        this.instances[index] = await AppProcess.start({ env: this.env });
    }

    async stop(): Promise<void> {
        await Promise.all(this.live.map((instance) => instance.stop("SIGKILL")));
        this.instances.fill(undefined);
    }
}
