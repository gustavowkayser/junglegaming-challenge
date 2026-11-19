import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import type { Environment } from "../config/environment.schema";
import { Migration20261119000000 } from "./migrations/Migration20261119000000.migration";
import { PERSISTENCE_SCHEMAS } from "./records/persistence.schema";

export type PersistenceEnvironment = Pick<Environment, "DATABASE_URL" | "DB_POOL_MAX">;

export function createMikroOrmConfig(environment: PersistenceEnvironment): Options {
    return defineConfig({
        clientUrl: environment.DATABASE_URL,
        entities: PERSISTENCE_SCHEMAS,
        pool: { min: 0, max: environment.DB_POOL_MAX },
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
