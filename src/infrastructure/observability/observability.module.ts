import { Global, Module } from "@nestjs/common";
import { EnvironmentService } from "../config/environment.service";
import { AppLogger, createRootLogger } from "./logger.service";

@Global()
@Module({
    providers: [
        {
            provide: AppLogger,
            inject: [EnvironmentService],
            useFactory: (environment: EnvironmentService) =>
                new AppLogger(createRootLogger(environment.get("LOG_LEVEL"))),
        },
    ],
    exports: [AppLogger],
})
export class ObservabilityModule {}
