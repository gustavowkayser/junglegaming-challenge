import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "./health.controller";
import { READINESS_INDICATORS } from "./readiness-indicator.port";

@Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [{ provide: READINESS_INDICATORS, useValue: [] }],
})
export class HealthModule {}
