import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { ObservabilityModule } from "./observability/observability.module";

@Module({
    imports: [AppConfigModule, ObservabilityModule, HealthModule],
})
export class AppModule {}
