import { MikroORM } from "@mikro-orm/postgresql";
import { Global, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { UNIT_OF_WORK } from "../../application/ports/unit-of-work.port";
import { EnvironmentService } from "../config/environment.service";
import { createMikroOrmConfig } from "./mikro-orm.config";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work.adapter";
import { PostgresReadinessIndicator } from "./postgres-readiness.indicator";

@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
    constructor(private readonly orm: MikroORM) {}

    async onApplicationShutdown(): Promise<void> {
        await this.orm.close(true);
    }
}

@Global()
@Module({
    imports: [TerminusModule],
    providers: [
        {
            provide: MikroORM,
            inject: [EnvironmentService],
            useFactory: (environment: EnvironmentService) =>
                MikroORM.init(
                    createMikroOrmConfig({
                        DATABASE_URL: environment.get("DATABASE_URL"),
                        DB_POOL_MAX: environment.get("DB_POOL_MAX"),
                    }),
                ),
        },
        {
            provide: UNIT_OF_WORK,
            inject: [MikroORM, EnvironmentService],
            useFactory: (orm: MikroORM, environment: EnvironmentService) =>
                new MikroOrmUnitOfWork(orm, {
                    lockTimeoutMs: environment.get("DB_LOCK_TIMEOUT_MS"),
                    statementTimeoutMs: environment.get("DB_STATEMENT_TIMEOUT_MS"),
                }),
        },
        OrmLifecycle,
        PostgresReadinessIndicator,
    ],
    exports: [MikroORM, UNIT_OF_WORK, PostgresReadinessIndicator],
})
export class PersistenceModule {}
