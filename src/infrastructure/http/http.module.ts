import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MetricsController } from "../observability/metrics.controller";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { HttpExceptionFilter } from "./http-exception.filter";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { ProvidersController } from "./providers.controller";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

@Module({
    controllers: [WalletsController, WageringController, ProvidersController, MetricsController],
    providers: [ProviderAuthGuard, { provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class HttpModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(CorrelationIdMiddleware).forRoutes("*");
    }
}
