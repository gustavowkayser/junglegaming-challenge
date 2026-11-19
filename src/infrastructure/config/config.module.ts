import { type DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { parseEnvironment } from "./environment.schema";
import { EnvironmentService } from "./environment.service";

@Module({})
export class AppConfigModule {
    static forRoot(): DynamicModule {
        return {
            module: AppConfigModule,
            global: true,
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    ignoreEnvFile: true,
                    cache: true,
                    validate: parseEnvironment,
                }),
            ],
            providers: [EnvironmentService],
            exports: [EnvironmentService],
        };
    }
}
