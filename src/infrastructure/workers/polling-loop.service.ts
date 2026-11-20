import type { Logger } from "pino";

const MAX_ERROR_BACKOFF_MS = 30_000;

export class PollingLoop {
    private running = false;
    private loop: Promise<void> | undefined;
    private wake: (() => void) | undefined;

    constructor(
        private readonly name: string,
        private readonly intervalMs: number,
        private readonly tick: () => Promise<number>,
        private readonly logger: Logger,
    ) {}

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.loop = this.run();
        this.logger.info({ event: "worker.started", worker: this.name });
    }

    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        this.running = false;
        this.wake?.();
        await this.loop;
        this.logger.info({ event: "worker.stopped", worker: this.name });
    }

    private async run(): Promise<void> {
        let consecutiveFailures = 0;
        while (this.running) {
            try {
                const processed = await this.tick();
                consecutiveFailures = 0;
                if (processed === 0) {
                    await this.sleep(this.intervalMs);
                }
            } catch (error) {
                consecutiveFailures += 1;
                const delay = Math.min(MAX_ERROR_BACKOFF_MS, this.intervalMs * 2 ** consecutiveFailures);
                this.logger.warn({
                    event: "worker.tick_failed",
                    worker: this.name,
                    consecutiveFailures,
                    retryInMs: delay,
                    err: error instanceof Error ? { name: error.name, message: error.message } : error,
                });
                await this.sleep(delay);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.wake = undefined;
                resolve();
            }, ms);
            this.wake = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
        });
    }
}
