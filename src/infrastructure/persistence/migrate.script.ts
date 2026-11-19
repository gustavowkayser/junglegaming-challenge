import { MikroORM } from "@mikro-orm/postgresql";
import { parseEnvironment } from "../config/environment.schema";
import { createMikroOrmConfig } from "./mikro-orm.config";

const direction = process.argv[2] ?? "up";
if (direction !== "up" && direction !== "down") {
    console.error(`Unknown migration direction "${direction}", expected "up" or "down"`);
    process.exit(1);
}

const orm = await MikroORM.init(createMikroOrmConfig(parseEnvironment(process.env)));
try {
    const executed = direction === "up" ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
    console.log(JSON.stringify({ event: `migrations.${direction}`, migrations: executed.map((item) => item.name) }));
} finally {
    await orm.close(true);
}
