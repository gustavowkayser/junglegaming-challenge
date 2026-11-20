import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./infrastructure/app.module";
import { EnvironmentService } from "./infrastructure/config/environment.service";
import { AppLogger } from "./infrastructure/observability/logger.service";

const SHUTDOWN_GRACE_MS = 5_000;

function handleShutdownSignals(app: INestApplication, logger: AppLogger, timeoutMs: number): void {
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.log({ event: "application.shutdown_requested", signal });
        const forced = setTimeout(() => {
            logger.error({ event: "application.shutdown_forced", signal });
            process.exit(1);
        }, timeoutMs + SHUTDOWN_GRACE_MS);
        try {
            await app.close();
            logger.log({ event: "application.stopped", signal });
            clearTimeout(forced);
            process.exit(0);
        } catch (error) {
            logger.error(error instanceof Error ? error : new Error(String(error)));
            process.exit(1);
        }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
}

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule.forRoot(), { bufferLogs: true });
    const logger = app.get(AppLogger);
    const environment = app.get(EnvironmentService);
    app.useLogger(logger);
    handleShutdownSignals(app, logger, environment.get("SHUTDOWN_TIMEOUT_MS"));

    if (environment.get("HTTP_ENABLED")) {
        await app.listen(environment.get("PORT"));
        logger.log({ event: "http.listening", port: environment.get("PORT") });
        return;
    }
    await app.init();
    logger.log({ event: "application.started", http: false });
}

bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
