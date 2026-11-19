import { z } from "zod";

const booleanFlag = (defaultValue: boolean) =>
    z
        .enum(["true", "false"])
        .default(defaultValue ? "true" : "false")
        .transform((value) => value === "true");

const integer = (defaultValue: number, min = 0) => z.coerce.number().int().min(min).default(defaultValue);

export const environmentSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: integer(3000, 0),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/wagering"),
    DB_POOL_MAX: integer(10, 1),
    DB_LOCK_TIMEOUT_MS: integer(5000, 1),
    DB_STATEMENT_TIMEOUT_MS: integer(15000, 1),
    AWS_REGION: z.string().min(1).default("us-east-1"),
    AWS_ENDPOINT_URL: z.string().min(1).default("http://localhost:4566"),
    AWS_ACCESS_KEY_ID: z.string().min(1).default("test"),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default("test"),
    SQS_WAGER_QUEUE_NAME: z.string().min(1).default("wager-transactions.fifo"),
    SQS_WAGER_DLQ_NAME: z.string().min(1).default("wager-transactions-dlq.fifo"),
    SQS_EVENTS_QUEUE_NAME: z.string().min(1).default("wagering-events.fifo"),
    SQS_CONSUMER_NAME: z.string().min(1).default("wager-transactions-consumer"),
    SQS_MAX_RECEIVE_COUNT: integer(5, 1),
    SQS_VISIBILITY_TIMEOUT_SECONDS: integer(30, 1),
    SQS_WAIT_TIME_SECONDS: integer(10, 0),
    HTTP_ENABLED: booleanFlag(true),
    SQS_CONSUMER_ENABLED: booleanFlag(true),
    OUTBOX_PUBLISHER_ENABLED: booleanFlag(true),
    PENDING_REFERENCE_WORKER_ENABLED: booleanFlag(true),
    OUTBOX_POLL_INTERVAL_MS: integer(500, 1),
    OUTBOX_BATCH_SIZE: integer(50, 1),
    PENDING_REFERENCE_POLL_INTERVAL_MS: integer(1000, 1),
    PENDING_REFERENCE_BATCH_SIZE: integer(50, 1),
    PENDING_REFERENCE_MAX_ATTEMPTS: integer(10, 1),
    PENDING_REFERENCE_BASE_DELAY_MS: integer(1000, 1),
    PENDING_REFERENCE_MAX_DELAY_MS: integer(300000, 1),
    SHUTDOWN_TIMEOUT_MS: integer(20000, 1),
    FAULT_INJECTION: z.enum(["none", "crash-after-commit", "crash-before-publish-commit"]).default("none"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: Record<string, unknown>): Environment {
    return environmentSchema.parse(source);
}
