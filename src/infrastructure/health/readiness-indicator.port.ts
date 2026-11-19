import type { HealthIndicatorResult } from "@nestjs/terminus";

export interface ReadinessIndicator {
    check(): Promise<HealthIndicatorResult>;
}

export const READINESS_INDICATORS = Symbol("ReadinessIndicators");
