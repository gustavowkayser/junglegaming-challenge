import "reflect-metadata";
import { TEST_DATABASE_URL } from "./environment.support";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
