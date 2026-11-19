import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./infrastructure/app.module";
import { EnvironmentService } from "./infrastructure/config/environment.service";
import { AppLogger } from "./infrastructure/observability/logger.service";

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule.forRoot(), { bufferLogs: true });
    const logger = app.get(AppLogger);
    const environment = app.get(EnvironmentService);
    app.useLogger(logger);
    app.enableShutdownHooks();

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
