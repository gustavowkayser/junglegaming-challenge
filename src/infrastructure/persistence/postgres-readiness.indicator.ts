import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { HealthIndicatorService } from "@nestjs/terminus";
import type { ReadinessIndicator } from "../health/readiness-indicator.port";

@Injectable()
export class PostgresReadinessIndicator implements ReadinessIndicator {
    constructor(
        private readonly orm: MikroORM,
        private readonly health: HealthIndicatorService,
    ) {}

    async check() {
        return this.health
            .check("postgres")
            .attempt(() => this.orm.em.fork().execute("select 1"))
            .withTimeout(1000)
            .withSuccessData({});
    }
}
