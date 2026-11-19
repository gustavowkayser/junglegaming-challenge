# Distributed Wagering Processor

Financial service that processes wagering transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) from multiple game providers over HTTP and AWS SQS, built with NestJS on Bun, PostgreSQL and LocalStack.

## Requirements

- Bun 1.3+
- Docker with Docker Compose

## Setup

```bash
bun install
docker compose up -d postgres localstack
bun run queues:setup
bun run start
```

Host ports can be overridden through `POSTGRES_HOST_PORT`, `LOCALSTACK_HOST_PORT` and `APP_HOST_PORTS` (Compose reads them from `.env`).

## Commands

| Command                | Description                    |
| ---------------------- | ------------------------------ |
| `bun run start`        | Start the service              |
| `bun run start:dev`    | Start with watch mode          |
| `bun run check`        | Lint and format check (Biome)  |
| `bun run typecheck`    | TypeScript type check          |
| `bun test`             | Unit tests                     |
| `bun run queues:setup` | Create SQS queues idempotently |
