import { type Environment, parseEnvironment } from "../../src/infrastructure/config/environment.schema";

function deriveTestDatabaseUrl(): string {
    if (process.env.TEST_DATABASE_URL) {
        return process.env.TEST_DATABASE_URL;
    }
    const base = new URL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering");
    base.pathname = "/wagering_test";
    return base.toString();
}

export const TEST_DATABASE_URL = deriveTestDatabaseUrl();

export function testEnvironment(overrides: Record<string, string> = {}): Environment {
    return parseEnvironment({ ...process.env, DATABASE_URL: TEST_DATABASE_URL, ...overrides });
}
