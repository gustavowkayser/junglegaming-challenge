import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { parseEnvironment } from "./environment.schema";
import { EnvironmentService } from "./environment.service";

@Global()
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            validate: parseEnvironment,
        }),
    ],
    providers: [EnvironmentService],
    exports: [EnvironmentService],
})
export class AppConfigModule {}
