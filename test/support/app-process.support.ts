import { HttpClient } from "./http-client.support";

export async function freePort(): Promise<number> {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    return port;
}

async function collect(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        sink.push(...lines.filter((line) => line.length > 0));
    }
    if (pending.length > 0) {
        sink.push(pending);
    }
}

export interface AppProcessOptions {
    env?: Record<string, string>;
    http?: boolean;
    startupTimeoutMs?: number;
    waitForStartup?: boolean;
}

export class AppProcess {
    readonly logs: string[] = [];
    readonly exited: Promise<number>;

    private constructor(
        private readonly process: ReturnType<typeof Bun.spawn>,
        readonly http: HttpClient | undefined,
    ) {
        if (process.stdout instanceof ReadableStream) {
            void collect(process.stdout, this.logs);
        }
        if (process.stderr instanceof ReadableStream) {
            void collect(process.stderr, this.logs);
        }
        this.exited = process.exited;
    }

    static async start(options: AppProcessOptions = {}): Promise<AppProcess> {
        const httpEnabled = options.http ?? true;
        const port = httpEnabled ? await freePort() : 0;
        const child = Bun.spawn(["bun", "src/main.ts"], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                LOG_LEVEL: "info",
                PORT: String(port),
                HTTP_ENABLED: String(httpEnabled),
                ...options.env,
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const instance = new AppProcess(child, httpEnabled ? new HttpClient(`http://127.0.0.1:${port}`) : undefined);
        if (options.waitForStartup ?? true) {
            await instance.waitUntilStarted(options.startupTimeoutMs ?? 20_000);
        }
        return instance;
    }

    get pid(): number {
        return this.process.pid;
    }

    kill(signal: "SIGKILL" | "SIGTERM" = "SIGKILL"): void {
        this.process.kill(signal);
    }

    async stop(signal: "SIGKILL" | "SIGTERM" = "SIGKILL"): Promise<number> {
        if (this.process.exitCode === null && !this.process.killed) {
            this.kill(signal);
        }
        return this.exited;
    }

    hasLog(fragment: string): boolean {
        return this.logs.some((line) => line.includes(fragment));
    }

    async waitForLog(fragment: string, timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.hasLog(fragment)) {
            if (Date.now() > deadline) {
                throw new Error(
                    `Timed out waiting for log "${fragment}". Last logs:\n${this.logs.slice(-20).join("\n")}`,
                );
            }
            if (this.process.exitCode !== null) {
                throw new Error(
                    `Process exited with ${this.process.exitCode}. Logs:\n${this.logs.slice(-40).join("\n")}`,
                );
            }
            await Bun.sleep(50);
        }
    }

    private async waitUntilStarted(timeoutMs: number): Promise<void> {
        await this.waitForLog(this.http ? "http.listening" : "application.started", timeoutMs);
    }
}

export async function eventually<T>(
    probe: () => Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs = 15_000,
    intervalMs = 100,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await probe();
    while (!accept(last)) {
        if (Date.now() > deadline) {
            throw new Error(`Condition not met within ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
        }
        await Bun.sleep(intervalMs);
        last = await probe();
    }
    return last;
}
