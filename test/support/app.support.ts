import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/infrastructure/app.module";
import { AppLogger } from "../../src/infrastructure/observability/logger.service";
import { testOrm } from "./database.support";
import { HttpClient } from "./http-client.support";

export interface TestApp {
    app: INestApplication;
    http: HttpClient;
    close(): Promise<void>;
}

const DEFAULT_OVERRIDES: Record<string, string> = {
    SQS_CONSUMER_ENABLED: "false",
    OUTBOX_PUBLISHER_ENABLED: "false",
    PENDING_REFERENCE_WORKER_ENABLED: "false",
    DB_POOL_MAX: "60",
};

export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
    await testOrm();
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries({ ...DEFAULT_OVERRIDES, ...overrides })) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
    }
    try {
        const app = await NestFactory.create(AppModule.forRoot(), { logger: false });
        app.useLogger(app.get(AppLogger));
        await app.listen(0, "127.0.0.1");
        const url = await app.getUrl();
        return {
            app,
            http: new HttpClient(url.replace("[::1]", "127.0.0.1")),
            close: () => app.close(),
        };
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}
