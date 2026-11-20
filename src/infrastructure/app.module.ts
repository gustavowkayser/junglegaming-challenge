import { type DynamicModule, Module } from "@nestjs/common";
import { ApplicationModule } from "./application.module";
import { AppConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { HttpModule } from "./http/http.module";
import { MessagingModule } from "./messaging/messaging.module";
import { ObservabilityModule } from "./observability/observability.module";
import { PersistenceModule } from "./persistence/persistence.module";
import { WorkersModule } from "./workers/workers.module";

@Module({})
export class AppModule {
    static forRoot(): DynamicModule {
        return {
            module: AppModule,
            imports: [
                AppConfigModule.forRoot(),
                ObservabilityModule,
                PersistenceModule,
                MessagingModule,
                ApplicationModule,
                HealthModule,
                HttpModule,
                WorkersModule,
            ],
        };
    }
}
