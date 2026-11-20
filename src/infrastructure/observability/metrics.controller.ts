import { Controller, Get, Header, Inject } from "@nestjs/common";
import { METRICS } from "../../application/ports/metrics.port";
import type { PromMetrics } from "./prom-metrics.adapter";

@Controller("metrics")
export class MetricsController {
    constructor(@Inject(METRICS) private readonly metrics: PromMetrics) {}

    @Get()
    @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    scrape(): Promise<string> {
        return this.metrics.registry.metrics();
    }
}
