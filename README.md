# Distributed Wagering Processor

A financial service that processes wagering transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) sent by game providers over HTTP and AWS SQS. It stays correct when messages are duplicated, delivered out of order, processed concurrently by several instances, or interrupted by crashes.

Built with **Bun**, **NestJS**, **MikroORM**, **PostgreSQL** and **SQS on LocalStack**. Design decisions, trade-offs and limitations are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Requirements

- Bun 1.3+
- Docker with Docker Compose

## Quick start (local process)

```bash
bun install
docker compose up -d postgres localstack   # LocalStack creates the queues on startup
bun run db:migrate
bun run start                              # http://localhost:3000
```

`bun run queues:setup` (re)creates the queues idempotently if needed.

## Full stack with three replicas

```bash
docker compose up --build -d
curl localhost:3000/health/ready
curl localhost:3001/health/ready
curl localhost:3002/health/ready
```

Compose runs `migrate` once and then three `app` replicas sharing PostgreSQL and SQS. Every replica serves HTTP, consumes SQS, publishes the outbox and runs the pending-reference worker. `docker compose stop app` shuts them down gracefully (`SIGTERM`).

Host ports are configurable through a `.env` file read by Compose: `POSTGRES_HOST_PORT` (5432), `LOCALSTACK_HOST_PORT` (4566), `APP_HOST_PORTS` (`3000-3002`). When you change them, point `DATABASE_URL` and `AWS_ENDPOINT_URL` at the new ports for processes running on the host.

## Commands

| Command                                        | Description                                                     |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `bun run start` / `bun run start:dev`          | Start the service (watch mode for `start:dev`)                  |
| `bun run check`                                | Biome lint and format check (`bun run lint:fix` to apply fixes) |
| `bun run typecheck`                            | TypeScript type check (strict)                                  |
| `bun run test` / `bun run test:unit`           | Unit tests (no infrastructure required)                         |
| `bun run test:integration`                     | Integration tests against PostgreSQL and LocalStack             |
| `bun run test:concurrency`                     | Race, multi-instance (3 processes) and restart tests            |
| `bun run test:all`                             | Every test suite                                                |
| `bun run test:load`                            | Load test (see ARCHITECTURE.md, "Load test")                    |
| `bun run db:migrate` / `bun run db:rollback`   | Apply or revert the migrations                                  |
| `bun run queues:setup`                         | Create the SQS queues idempotently                              |
| `docker compose --profile test run --rm tests` | Run every suite inside a Linux container                        |

Integration and concurrency tests need `docker compose up -d postgres localstack`. They use a separate `wagering_test` database, created automatically, and create their own uniquely named queues. Tests that need a real `SIGTERM` are skipped on Windows; run them through the `tests` container.

## Configuration

All variables are validated at startup (`src/infrastructure/config/environment.schema.ts`); see `.env.example`.

| Variable                                                                                               | Default                                                   | Purpose                                                                     |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PORT`                                                                                                 | `3000`                                                    | HTTP port                                                                   |
| `DATABASE_URL`                                                                                         | `postgres://postgres:postgres@localhost:5432/wagering`    | PostgreSQL connection                                                       |
| `DB_POOL_MAX`                                                                                          | `10`                                                      | Connection pool size per instance                                           |
| `DB_LOCK_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS`                                                       | `5000` / `15000`                                          | Per-connection lock and statement timeouts                                  |
| `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                         | LocalStack defaults                                       | SQS client                                                                  |
| `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME`                                                          | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` | Inbound queue and its DLQ                                                   |
| `SQS_EVENTS_QUEUE_NAME`                                                                                | `wagering-events.fifo`                                    | Destination of the integration events                                       |
| `SQS_MAX_RECEIVE_COUNT`                                                                                | `5`                                                       | Receives before a transiently failing message is dead-lettered              |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` / `SQS_WAIT_TIME_SECONDS`                                             | `30` / `10`                                               | Consumer visibility timeout and long-poll duration                          |
| `HTTP_ENABLED`, `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true`                                                    | Process roles                                                               |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE`                                                        | `500` / `50`                                              | Outbox publisher cadence                                                    |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS`                                  | `10` / `1000` / `300000`                                  | Out-of-order reference retry policy                                         |
| `SHUTDOWN_TIMEOUT_MS`                                                                                  | `20000`                                                   | Time allowed to drain in-flight messages on shutdown                        |
| `LOG_LEVEL`                                                                                            | `info`                                                    | pino log level                                                              |
| `FAULT_INJECTION`                                                                                      | `none`                                                    | Test-only crash points: `crash-after-commit`, `crash-before-publish-commit` |

## API

Health and metrics endpoints are open. Wagering endpoints go through the provider authentication extension point (see ARCHITECTURE.md, "Authentication").

```bash
# Create a wallet (the opening balance becomes an OPENING transaction and a CREDIT ledger entry)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Submit a transaction (Idempotency-Key is required)
curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<wallet id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# Queries
curl localhost:3000/wallets/<wallet id>
curl 'localhost:3000/wallets/<wallet id>/ledger?limit=50'           # follow nextCursor for the next page
curl localhost:3000/wagering/transactions/<transaction id>
curl localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# Reconciliation: compares the stored balance with the ledger and never corrects anything
curl -X POST localhost:3000/wallets/<wallet id>/reconciliation

# Operations
curl localhost:3000/health/live
curl localhost:3000/health/ready     # PostgreSQL and SQS reachable
curl localhost:3000/metrics          # Prometheus text format
```

Every response carries `X-Correlation-Id` (echoed when sent, generated otherwise). Error bodies have the shape `{"error":{"code":"...","message":"...","details":...}}`.

| Situation                                                   | HTTP                | Body                                                   |
| ----------------------------------------------------------- | ------------------- | ------------------------------------------------------ |
| Processed (also on identical replay)                        | 200                 | result, `idempotentReplay` true on replays             |
| Waiting for the referenced transaction                      | 202                 | result with `PENDING_REFERENCE`                        |
| Business rejection                                          | 422                 | result with `REJECTED` and `failureCode`               |
| Wallet referenced by the payload does not exist             | 422                 | `WALLET_NOT_FOUND`                                     |
| Invalid payload or missing header                           | 400                 | `VALIDATION_FAILED` / `IDEMPOTENCY_KEY_REQUIRED`       |
| Same idempotency key with another payload, duplicate wallet | 409                 | `IDEMPOTENCY_KEY_CONFLICT` / `WALLET_ALREADY_EXISTS`   |
| Resource in the URL does not exist                          | 404                 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND`           |
| Temporary infrastructure failure                            | 503 + `Retry-After` | `SERVICE_UNAVAILABLE`, safe to retry with the same key |

## Sending a message through SQS

```bash
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <wallet id> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"<player id>","walletId":"<wallet id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Integration events are published to `wagering-events.fifo` (`MessageGroupId` = wallet id, `MessageDeduplicationId` = `eventId`).

## Project structure

```
src/
├── domain/            Pure TypeScript: Money, Wallet, WalletLedgerEntry, WagerTransaction,
│                      settlement rules, inbox/outbox entities, integration events, repository ports
├── application/       Use cases, ports (unit of work, clock, ids, metrics, publisher, identity) and errors
└── infrastructure/    NestJS wiring, HTTP, SQS consumer and publisher, MikroORM persistence and migration,
                       workers, observability, configuration
test/
├── unit/              Domain and application rules
├── integration/       Schema, repositories, HTTP, outbox, SQS consumer, pending references
├── concurrency/       Parallel races, 3 instances, kill/restart under load
├── load/              Load test script
└── support/           Test database, queues, spawned processes, invariant checks
```
