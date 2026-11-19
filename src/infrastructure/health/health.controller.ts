import { Controller, Get, Inject } from "@nestjs/common";
import { HealthCheck, HealthCheckService } from "@nestjs/terminus";
import { READINESS_INDICATORS, type ReadinessIndicator } from "./readiness-indicator.port";

@Controller("health")
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        @Inject(READINESS_INDICATORS) private readonly indicators: ReadinessIndicator[],
    ) {}

    @Get("live")
    live(): { status: "ok" } {
        return { status: "ok" };
    }

    @Get("ready")
    @HealthCheck()
    ready() {
        return this.health.check(this.indicators.map((indicator) => () => indicator.check()));
    }
}
