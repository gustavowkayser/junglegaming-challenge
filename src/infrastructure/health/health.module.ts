import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { PostgresReadinessIndicator } from "../persistence/postgres-readiness.indicator";
import { HealthController } from "./health.controller";
import { READINESS_INDICATORS, type ReadinessIndicator } from "./readiness-indicator.port";

@Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [
        {
            provide: READINESS_INDICATORS,
            inject: [PostgresReadinessIndicator],
            useFactory: (...indicators: ReadinessIndicator[]) => indicators,
        },
    ],
})
export class HealthModule {}
