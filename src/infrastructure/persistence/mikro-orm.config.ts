import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import type { Environment } from "../config/environment.schema";
import { Migration20261119000000 } from "./migrations/Migration20261119000000.migration";
import { PERSISTENCE_SCHEMAS } from "./records/persistence.schema";

export type PersistenceEnvironment = Pick<
    Environment,
    "DATABASE_URL" | "DB_POOL_MAX" | "DB_LOCK_TIMEOUT_MS" | "DB_STATEMENT_TIMEOUT_MS"
>;

const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function createMikroOrmConfig(environment: PersistenceEnvironment): Options {
    return defineConfig({
        clientUrl: environment.DATABASE_URL,
        entities: PERSISTENCE_SCHEMAS,
        pool: { min: 0, max: environment.DB_POOL_MAX },
        driverOptions: {
            lock_timeout: environment.DB_LOCK_TIMEOUT_MS,
            statement_timeout: environment.DB_STATEMENT_TIMEOUT_MS,
            idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
        },
        extensions: [Migrator],
        allowGlobalContext: false,
        debug: false,
        migrations: {
            tableName: "schema_migrations",
            transactional: true,
            allOrNothing: true,
            snapshot: false,
            silent: true,
            migrationsList: [{ name: "Migration20261119000000", class: Migration20261119000000 }],
        },
    });
}
