import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work.adapter";
import { testEnvironment } from "./environment.support";

let ormPromise: Promise<MikroORM> | undefined;

export function testOrm(): Promise<MikroORM> {
    ormPromise ??= (async () => {
        const environment = testEnvironment({ DB_POOL_MAX: "80" });
        const orm = await MikroORM.init(createMikroOrmConfig(environment));
        await orm.migrator.up();
        return orm;
    })();
    return ormPromise;
}

export async function testUnitOfWork(settings = { lockTimeoutMs: 5000, statementTimeoutMs: 15000 }) {
    return new MikroOrmUnitOfWork(await testOrm(), settings);
}

export async function sqlEm(): Promise<EntityManager> {
    return (await testOrm()).em.fork();
}

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    return (await sqlEm()).execute<T[]>(query, params);
}

export async function truncateAll(): Promise<void> {
    await sql(
        "truncate table wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages cascade",
    );
}
