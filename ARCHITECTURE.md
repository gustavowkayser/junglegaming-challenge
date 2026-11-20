# Architecture

This document explains how the service keeps money correct under duplication, reordering, concurrency and crashes, and why each decision was made. The guiding rule: **the database is the final authority on every invariant**. Application code, the broker and the ORM are optimizations layered on top.

## 1. Layers

```
infrastructure  ──►  application  ──►  domain
(NestJS, HTTP,       (use cases,        (pure TypeScript: Money, Wallet,
 SQS, MikroORM,       ports, errors)     WalletLedgerEntry, WagerTransaction,
 workers, logs)                          settlement rules, events)
```

- **Domain** has no dependency on NestJS, MikroORM, zod, Bun or Node APIs. Aggregates have private constructors, static factories (`create`, `open`, `openingFor`, `enqueue`, `receive`) and a `rehydrate` factory that rebuilds persisted state without re-running transition rules. All state changes go through explicit transition methods.
- **Application** contains the use cases (`CreateWallet`, `SubmitWagerTransaction`, `ConsumeWagerMessage`, `PublishOutbox`, `ResolvePendingReferences`, `ReconcileWallet` and the queries). It talks to the outside world only through ports: `UnitOfWork`, `Clock`, `IdGenerator`, `PayloadHasher`, `EventPublisher`, `Metrics`, `ProviderIdentityPort`, `FaultInjector`. Use cases are plain classes wired by factories, so they can be tested and reused without Nest.
- **Infrastructure** adapts the ports: MikroORM repositories and unit of work, the SQS consumer and publisher, the HTTP controllers, the polling workers, pino logging and Prometheus metrics.

HTTP and SQS reach the **same** use case (`SubmitWagerTransactionUseCase`). The consumer only adds an inbox receipt to the command.

## 2. Money

- `Money` stores an exact `bigint` amount of minor units with a fixed scale of 2, plus an ISO-4217 currency. Every operation returns a new frozen instance.
- Amounts cross every boundary (HTTP, SQS, events, the database driver) as **decimal strings**. `Money.from` accepts `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`.
  - Rejected inputs: `NaN`, `Infinity`, scientific notation, empty strings, padding, leading zeros, more than two decimals, negative input amounts.
  - Values beyond `numeric(20,2)` are rejected too.
  - Nothing is ever rounded: `"1.005"` is an error, not `"1.01"`.
- Operations between currencies throw `CurrencyMismatchError`. The challenge allows a single currency, but the model is multi-currency: there is one wallet per player and currency, the currency is checked against the wallet, and the ledger has a composite foreign key on `(wallet_id, currency)`.
- In PostgreSQL every amount is `numeric(20,2)`, read back as a string and rehydrated with `Money.fromPersistence`, which also accepts signed values for internal use. `number` is never used for money.

## 3. Persistence: MikroORM

MikroORM was chosen as the preferred option. How it is used:

- **`EntitySchema` + plain record classes** (`infrastructure/persistence/records`) with explicit mappers. Domain classes carry no decorators and are never managed entities, so the identity map cannot leak stale state into the domain. Reads use `disableIdentityMap`.
- **One SQL transaction per use case**: `MikroOrmUnitOfWork.run()` runs `em.fork().transactional(...)` and hands the work a set of repositories bound to that transactional `EntityManager`. Inbox, wager transaction, ledger, wallet and outbox writes therefore commit or roll back together.
- **Explicit statements instead of implicit flushes**: repositories use `em.insert`, `em.nativeUpdate`, `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`), `PESSIMISTIC_READ` (`FOR SHARE`), `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) and a few raw statements: `ON CONFLICT DO NOTHING` for the inbox, aggregates for reconciliation, and a `jsonb_to_recordset` bulk update for the outbox. Each SQL statement is deterministic and visible in one place.
- Driver errors are translated in one place (`postgres-error.service.ts`):

  | PostgreSQL error                                                                    | Becomes                   | Handling                |
  | ----------------------------------------------------------------------------------- | ------------------------- | ----------------------- |
  | unique violation (with the constraint name)                                         | race                      | retried by the use case |
  | lock timeout, deadlock, serialization failure, statement timeout, connection errors | transient                 | 503, or an SQS retry    |
  | check, foreign key, trigger violations                                              | `InvariantViolationError` | —                       |

- **Migrations**: one versioned, reversible migration (`Migration20261119000000.migration.ts`, with `up` and `down`) registered explicitly through `migrationsList`. Tests run `down` → `up` to prove reversibility.

## 4. Schema-level guarantees

Every guarantee from the challenge's section 6 holds even if the application code is wrong:

| Guarantee                                                          | Enforcement                                                                                                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One wallet per player + currency                                   | `wallets_player_currency_uk`                                                                                                                                                        |
| Balance never negative                                             | `wallets_balance_non_negative_ck`, `wallet_ledger_entries_balance_*_ck`, `wager_transactions_result_balance_ck`                                                                     |
| Version starts at 1, changes only with the balance, by exactly one | `wallets_version_ck` + trigger `guard_wallet_version` (also freezes `player_id`, `currency`, `created_at`)                                                                          |
| Every balance state has its ledger entry                           | deferred constraint trigger `assert_wallet_matches_ledger`: at commit, a funded or modified wallet must have an entry with `wallet_version = version` and `balance_after = balance` |
| Ledger arithmetic is correct                                       | `wallet_ledger_entries_arithmetic_ck` (`after = before ± amount`), `amount > 0`                                                                                                     |
| Ledger entries are immutable                                       | trigger `forbid_mutation` on `UPDATE` / `DELETE`                                                                                                                                    |
| At most one entry per transaction, no lost update                  | `wallet_ledger_entries_transaction_uk`, `wallet_ledger_entries_wallet_version_uk`                                                                                                   |
| Entry currency equals wallet currency                              | composite FK `(wallet_id, currency) → wallets(id, currency)`                                                                                                                        |
| Idempotency is persistent                                          | `wager_transactions_idempotency_key_uk`, `wager_transactions_provider_external_uk`                                                                                                  |
| A reference is reversed at most once                               | partial unique index `wager_transactions_single_reversal_uk (reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`                                |
| Terminal transactions never change, business fields never change   | trigger `guard_terminal_wager_transaction`; no deletes                                                                                                                              |
| Status/kind/failure code coherence                                 | `*_kind_ck`, `*_status_ck`, `*_failure_code_ck` (REJECTED/FAILED ⇔ code), `*_settled_ck`, `*_pending_schedule_ck`, `*_reference_required_ck`, `*_processed_reversal_reference_ck`   |
| Inbox dedup                                                        | primary key `(consumer_name, message_id)`                                                                                                                                           |

Supporting indexes:

- Partial indexes for the work queues: `outbox_messages_pending_ix` and `wager_transactions_pending_reference_ix`.
- `wager_transactions_pending_dependents_ix` for expediting dependents.
- `wager_transactions_wallet_ix`.
- The `(wallet_id, wallet_version)` unique index doubles as the stable ledger cursor.

## 5. Concurrency

**Strategy: pessimistic row lock per wallet**, `SELECT … FOR UPDATE` on the wallet row inside the use case transaction. The rule is that **every write to a wallet's state** happens while holding that row lock. That covers the wallet itself, its wager transactions and its ledger entries.

Alternatives considered:

| Option                                                     | Why not                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Optimistic `version` with bounded retries                  | A hot wallet with 50 concurrent bets turns into a retry storm: most attempts exhaust the retry budget and the provider sees 503s for operations that could simply have waited. |
| Single conditional `UPDATE … WHERE balance >= x RETURNING` | Fastest, but the business rules (references, reversal direction, rejection codes, ledger arithmetic) would have to live in SQL.                                                |

The pessimistic lock gives a simple serialization point per wallet, while different wallets proceed in parallel. Correctness does not depend on the lock alone:

- the wallet `UPDATE` is version-checked (`WHERE id = ? AND version = persistedVersion`);
- the unique `(wallet_id, wallet_version)` makes a lost update impossible at commit;
- the deferred trigger rejects any balance state the ledger does not explain.

Further details:

- **Lock ordering**: an inbox row (SQS only), then the wallet row, then that wallet's transaction rows. The pending-reference worker reads a candidate without locking it, locks the wallet, then re-reads the transaction. Outbox rows are only locked by the publisher, never under a wallet lock. With this order, deadlocks never occurred in tests or load runs.
- **Idempotency under concurrency**: the idempotency lookup happens _after_ the wallet lock, so concurrent identical requests on one wallet serialize and the later ones replay. Requests sharing a key but naming different wallets don't share a lock; for those, the unique index is the arbiter, and the use case retries once on a unique violation and lands on the replay/conflict path.
- **Timeouts**: `lock_timeout` 5s, `statement_timeout` 15s and `idle_in_transaction_session_timeout` 60s are set **per connection** through `pg` startup parameters. A lock timeout returns 503 (HTTP) or a retry (SQS). Deadlock, serialization and version conflicts get up to three in-process attempts (`withConflictRetry`). Every conflict increments `wagering_lock_conflicts_total{type}`.
- **Multiple instances**: nothing relies on process memory: no in-memory cache, no global lock, no leader election. All coordination is row locks, `SKIP LOCKED` and unique constraints. Three spawned processes are exercised in `test/concurrency/multi-instance.test.ts` and `restart.test.ts`, and Compose runs three replicas.

The mandatory scenario from section 8 (balance 100.00, two concurrent 80.00 BETs) is tested in-process and across instances. The result: exactly one PROCESSED, one REJECTED with `INSUFFICIENT_FUNDS`, a balance of 20.00, one DEBIT entry, and retries that are pure replays.

## 6. Idempotency

- The `Idempotency-Key` header is mandatory and is the source of truth; `{providerId}:{externalTransactionId}` is the recommended value. SQS messages carry it in `data.idempotencyKey`.
- **`payloadHash`** is the SHA-256 hex digest of a **canonical JSON** document of the business fields only:
  - the fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount, currency}`, `referenceExternalTransactionId`;
  - normalization: object keys sorted recursively, no whitespace, `undefined` keys omitted, the amount normalized through `Money` (`"25"` and `"25.00"` hash the same), UUIDs lowercased;
  - headers, correlation ids and other transport metadata are excluded.
- Same key and same hash returns the stored result with `idempotentReplay: true`, including the **balance observed at that time** (`result_balance` column) and the same HTTP status. Same key with a different hash, or the same provider transaction under another key, returns **409 `IDEMPOTENCY_KEY_CONFLICT`**, never a replay.
- Idempotency is persistent (unique constraints plus a stored result). Nothing relies on memory.

## 7. Business rules and interpretations

| Kind       | Balance                  | Ledger   | Notes                                                                                                  |
| ---------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `OPENING`  | credit                   | 1 CREDIT | internal, created with the wallet in the same SQL transaction; rejected (400) on HTTP and DLQ'd on SQS |
| `BET`      | debit                    | 1 DEBIT  | `INSUFFICIENT_FUNDS` when the balance is short                                                         |
| `WIN`      | credit                   | 1 CREDIT | the reference is optional; when given it must be a processed BET of the same round                     |
| `LOSS`     | none                     | none     | amount may be `0.00`; still emits `WagerTransactionProcessed`                                          |
| `REFUND`   | credit                   | 1 CREDIT | reference must be a processed BET, same amount                                                         |
| `ROLLBACK` | inverse of the reference | 1 entry  | reference must be a processed BET, WIN or REFUND, same amount                                          |

Rule evaluation order:

1. the wallet must belong to the player;
2. the currency must match the wallet's;
3. reference checks: same provider, player, wallet, currency and round; allowed kind; equal amount; not already reversed;
4. funds.

Interpretations worth calling out:

- **A reference can be reversed only once, by any reversal kind.** Read literally, "cannot be reversed twice by the same kind" would allow a REFUND and then a ROLLBACK of the same BET, crediting the player twice. A ROLLBACK can still target a REFUND, because that's a different reference.
- **Reference not yet terminal** (missing, or itself `PENDING_REFERENCE`): the transaction waits as `PENDING_REFERENCE`. A reference that ended REJECTED or FAILED means `REFERENCE_NOT_PROCESSED`.
- **Reversal that would overdraw** (e.g. a ROLLBACK of a WIN that was already spent) is rejected with `REVERSAL_INSUFFICIENT_FUNDS`, distinct from a bet's `INSUFFICIENT_FUNDS`, and stays auditable as a REJECTED row with an event.
- **Unknown wallet**: answered with 422 `WALLET_NOT_FOUND` (HTTP) or acked (SQS), and **not persisted**. A wager row needs a real wallet (FK), and a later retry after the wallet exists should succeed.
- `PENDING` exists in the model, but a transaction never commits in it: the use case moves it to its outcome within the same SQL transaction.

### Transaction state machine

```
create ──► PENDING ──► PROCESSED            (terminal)
              │   ├──► REJECTED             (terminal, failureCode)
              │   ├──► FAILED               (terminal, PROCESSING_ERROR)
              └──► PENDING_REFERENCE ──► PENDING_REFERENCE (rescheduled, attempts + 1)
                                      ├► PROCESSED / REJECTED / FAILED
```

Any transition out of a terminal state throws `InvalidTransactionStateError` (a programming error), and the database trigger blocks it too.

### Failure codes

| Code                          | Meaning                                                                 | Provider action                         |
| ----------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `INSUFFICIENT_FUNDS`          | BET larger than the balance                                             | do not retry the same payload           |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK would make the balance negative                                | operational follow-up, do not retry     |
| `CURRENCY_MISMATCH`           | money currency differs from the wallet currency                         | fix the payload (new transaction id)    |
| `WALLET_PLAYER_MISMATCH`      | wallet belongs to another player                                        | fix the payload                         |
| `REFERENCE_NOT_FOUND`         | reference never arrived within the retry budget                         | send the reference, then a new reversal |
| `REFERENCE_NOT_PROCESSED`     | referenced transaction was rejected or failed                           | do not retry                            |
| `REFERENCE_MISMATCH`          | reference has another provider, player, wallet, currency or round       | fix the payload                         |
| `REFERENCE_KIND_NOT_ALLOWED`  | e.g. REFUND of a WIN, ROLLBACK of a LOSS or ROLLBACK                    | fix the payload                         |
| `REFERENCE_AMOUNT_MISMATCH`   | partial reversals are not supported                                     | fix the payload                         |
| `REFERENCE_ALREADY_REVERSED`  | reference already has a processed reversal                              | nothing to do                           |
| `PROCESSING_ERROR`            | permanent failure while resolving a pending reference (status `FAILED`) | contact operations                      |

Request-level codes (not persisted): `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_CONFLICT`, `WALLET_NOT_FOUND`, `WALLET_ALREADY_EXISTS`, `TRANSACTION_NOT_FOUND`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`. The HTTP mapping is one table (`http/error-status.service.ts`, reproduced in the README) and is consistent across endpoints. It distinguishes:

- invalid payload: 400;
- idempotency conflict: 409;
- business rejection: 422;
- accepted but pending: 202;
- transient infrastructure failure: 503 with `Retry-After`.

## 8. Out-of-order references

- A reversal whose reference is missing is persisted as `PENDING_REFERENCE` with `reference_attempts = 1` and a `next_reference_attempt_at`, and publishes `WagerTransactionPendingReference`.
- **Worker** (`ResolvePendingReferencesUseCase`, every instance):
  1. select due ids without locking;
  2. for each one, lock the wallet, re-read the transaction (skip it if it's no longer pending or no longer due), and re-run the settlement rules.
     Concurrent workers on the same row serialize on the wallet lock; the second one sees a terminal status and skips.
- **Policy**: exponential backoff `base × 2^(attempt−1)`, capped:
  - defaults: base 1s, cap 300s, 10 attempts;
  - the reference is looked up at about 0s, 1s, 3s, 7s, 15s, 31s, 63s, 127s, 255s and 511s (10 attempts);
  - at the next scheduled check, about 811s (≈13.5 min) after arrival because the last delay is capped at 300s, the budget is exhausted and the transaction becomes REJECTED `REFERENCE_NOT_FOUND`, with a `WagerTransactionRejected` event.

  Why these numbers: ordinary reordering resolves in milliseconds to seconds. The window also covers a full SQS redrive cycle (5 receives × 30s visibility) plus provider retries, while still giving the provider a definitive, machine-readable answer instead of an open-ended pending state. Everything is configurable.
- **Expediting**: when a transaction reaches a terminal state, the same SQL transaction sets `next_reference_attempt_at = now()` on its pending dependents. A late BET therefore unblocks its REFUND on the next worker tick (about 1s) instead of after the backoff delay.
- An unexpected non-transient error while resolving marks the transaction `FAILED` with `PROCESSING_ERROR`. It stays auditable and emits `WagerTransactionRejected`.

## 9. SQS consumer

- **Inbox**: `inbox_messages (consumer_name, message_id)` is written in the same SQL transaction as the financial change.
  - Already-processed message: replay, then ack.
  - Same `messageId` with a different payload hash: `INBOX_PAYLOAD_MISMATCH`, sent to the DLQ.
  - A new `messageId` carrying a known idempotency key: a normal idempotent replay.
- **Ack only after commit**: `DeleteMessage` runs after the use case returns.
- **Classification** (`ConsumeWagerMessageUseCase`):

  | Outcome            | Examples                                                                                                   | Action                                                                    |
  | ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
  | Business, terminal | any persisted result (including REJECTED), idempotency conflict, unknown wallet                            | ack                                                                       |
  | Transient          | lock, connection or statement timeouts, races, unexpected errors                                           | retry after `min(2^receiveCount, 300)` s via `ChangeMessageVisibility`    |
  | Permanent          | invalid JSON or envelope, `OPENING`, payload rule violations, inbox payload mismatch, invariant violations | explicit send to the DLQ with a `deadLetterReason` attribute, then delete |

  Once `ApproximateReceiveCount` reaches `SQS_MAX_RECEIVE_COUNT`, a transient failure is dead-lettered explicitly as `RETRIES_EXHAUSTED`. The queue's redrive policy (`maxReceiveCount` 5) stays as a safety net, for example for a process that keeps crashing before it can decide.
- **Ordering**: queues are FIFO with `MessageGroupId = walletId`. Messages of one group are processed sequentially inside a batch, while groups run in parallel. FIFO is only an optimization: correctness comes from the wallet lock and the inbox.
- **Shutdown**: `SIGTERM` and `SIGINT` close the Nest application.
  1. The consumer stops polling and aborts the long poll.
  2. It finishes in-flight messages.
  3. It returns received but unstarted messages with `ChangeMessageVisibility(0)`.
  4. The process exits 0.

  Draining waits at most `SHUTDOWN_TIMEOUT_MS`. A message still unfinished after that becomes visible again when its visibility timeout expires and is safely redelivered (inbox). A guard forces exit 1 only if closing the application itself hangs.

  Workers stop before the ORM closes. This is verified by a real `SIGTERM` test (Linux) and by `docker compose stop`.

## 10. Transactional outbox

- Events are created by the use case and stored in `outbox_messages` **in the same SQL transaction** as the change. Nothing is published before commit.
- **Publisher** (every instance):
  1. claim a batch with `FOR UPDATE SKIP LOCKED` (oldest first);
  2. send it to `wagering-events.fifo` with `MessageGroupId = aggregateId` (wallet) and `MessageDeduplicationId = eventId`;
  3. mark published rows and reschedule failures with backoff (1s doubling to 60s), in **one** bulk `UPDATE`;
  4. commit.

  Batches go out over 4 parallel lanes partitioned by aggregate, so each wallet's events keep their order. When one event of an aggregate fails, its later events in the batch are held back.
- **Delivery is at-least-once, by design.** If the process dies after SQS accepted the batch but before the commit, the rows are still unpublished. Another instance republishes them with the same `eventId`. The FIFO deduplication window (5 min) usually absorbs the duplicate; beyond that, consumers must dedupe by `eventId`, as the envelope contract states.
  This scenario is tested deterministically with `FAULT_INJECTION=crash-before-publish-commit`. A publisher killed before publishing is covered by a test where another instance takes over.
- Trade-off: the SQS call happens while the batch rows are locked. That keeps claiming and marking atomic, at the cost of holding about 50 row locks for one broker round trip. `SKIP LOCKED` lets other publishers take other rows meanwhile.

Event envelope: abstract `IntegrationEvent<T>` with `eventId`, `eventType`, `version` (defined by each subclass), `aggregateId`, `correlationId`, `causationId`, `occurredAt` (ISO) and `data`. `data` uses `MoneyProps` strings only and is deep-frozen. Event types:

- `WagerTransactionProcessed`: any applied transaction, including LOSS and OPENING;
- `WagerTransactionRejected`: REJECTED, and FAILED with its status;
- `WalletBalanceChanged`: only when the balance changes, with `walletVersion`;
- `WagerTransactionPendingReference`.

## 11. Reconciliation

`POST /wallets/:walletId/reconciliation` takes a `FOR SHARE` lock on the wallet (a consistent snapshot against concurrent writers) and runs three checks:

- the stored balance against the sum of CREDIT minus DEBIT in the ledger;
- the latest `balance_after` against the stored balance;
- the latest `wallet_version` against the wallet version.

It returns `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries` and the individual checks. **It never corrects anything.** A divergence is logged at `error` (`reconciliation.divergence_detected`), counted in `wagering_reconciliations_total{consistent="false"}` and reported in the response. A test tampers with a balance by disabling triggers and asserts all three effects.

## 12. Observability

- **Logs**: pino JSON on stdout.
  - `AsyncLocalStorage` adds `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId` to every line across HTTP requests, SQS messages and workers.
  - Events: `http.request.completed`, `wager.transaction_submitted`, `message.acked|retried|dead_lettered`, `outbox.batch_published`, `pending_reference.resolved`, `reconciliation.*`, `worker.*` and `application.*`.
  - Amounts, balances and payloads are never logged on purpose, and pino `redact` acts as a safety net (`money`, `balance`, `initialBalance`, `payload`, `body`).
- **Metrics** (`GET /metrics`, Prometheus):
  - `wagering_transactions_total{kind,status,source}`
  - `wagering_duplicates_total{source,layer}`
  - `wagering_retries_total{component,reason}`
  - `wagering_dlq_messages_total{reason}`
  - `wagering_lock_conflicts_total{type}`
  - `wagering_processing_duration_seconds{source}` (histogram)
  - `wagering_outbox_pending` and `wagering_outbox_lag_seconds` (computed at scrape time)
  - `wagering_outbox_published_total`
  - `wagering_reconciliations_total{consistent}`
  - default process metrics
- **Health**: `/health/live` is always up. `/health/ready` checks PostgreSQL (`SELECT 1`) and SQS (`GetQueueAttributes`) with timeouts. Both are open, without authentication.

## 13. Authentication (not implemented, extension point in place)

Authentication earns no points in the scoring table, so it was left out on purpose. The extension point is explicit:

- `ProviderIdentityPort` has `authenticate(headers)` and `assertCanActAs(identity, providerId)`;
- `ProviderAuthGuard` is applied to the wagering and provider endpoints;
- the current adapter, `PassThroughProviderIdentity`, accepts everything.

Planned design with an external IdP (Keycloak, or Zitadel):

1. Each provider is a confidential OIDC client and obtains tokens with the **client-credentials** grant.
2. A `JwtProviderIdentity` adapter validates the bearer token against the realm's JWKS (signature, `iss`, `aud`, `exp`) with a small JOSE library. It maps a claim (`azp` or a `provider_id` mapper) to `ProviderIdentity`.
3. `assertCanActAs` rejects (403) any body whose `providerId` differs from the token's. Health and metrics stay open.
4. SQS remains a trusted internal channel, as the challenge allows. The provider identity inside the message is still subject to the same domain validation: a reference must belong to the same provider, and so on.
5. Keycloak would be added to Compose with an exported realm containing one client per test provider.

## 14. Testing

| Suite                          | What it proves                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit`                    | Money (scale, no rounding, invalid input, currency conflicts), Wallet invariants, every BET/WIN/LOSS/REFUND/ROLLBACK rule, state transitions, events, canonical JSON and payload hash divergence, SQS classification, publisher lanes, logger redaction |
| `test/integration/persistence` | migrations down/up, every constraint and trigger, repositories, `SKIP LOCKED` claiming                                                                                                                                                                  |
| `test/integration/http`        | all endpoints, status mapping, replay/conflict, pagination, metrics, reconciliation                                                                                                                                                                     |
| `test/integration/outbox`      | atomicity (a failing outbox insert rolls everything back), concurrent publishers never claim the same row, broker outage backoff, a process killed before publishing, a publisher crashing between send and commit                                      |
| `test/integration/messaging`   | inbox redelivery, HTTP/SQS shared idempotency, DLQ reasons, transient retry then success, retry exhaustion to DLQ, a worker killed **after commit and before ack**, `SIGTERM` draining                                                                  |
| `test/integration/wagering`    | REFUND/ROLLBACK before the reference (direct and through SQS with the worker), expediting, retry exhaustion, concurrent resolvers                                                                                                                       |
| `test/concurrency`             | 50 parallel identical BETs, the two-80.00-BETs race, hot wallet, parallel wallets, **3 real processes** (HTTP races, 300 SQS messages with duplicates and early reversals), kill/restart under mixed load                                               |

- Tests use **real PostgreSQL and LocalStack**. Concurrency uses real parallel connections and real processes (`Bun.spawn`).
- Crash points are deterministic through `FAULT_INJECTION`. The flag is read only by the env adapter, and production code calls `FaultInjector.reach(point)`.
- Every financial test ends with `assertLedgerInvariant`: balance equals the ledger sum, the latest `balance_after` equals the balance, and the latest version equals the wallet version.
- The suites pass on Windows (the SIGTERM test is skipped there) and inside Linux through `docker compose --profile test run --rm tests`.

## 15. Load test

`bun run test:load` starts 3 instances (or targets `LOAD_TARGETS`), creates 200 wallets and runs 64 concurrent workers for 30 s. It ends by reconciling every wallet through the API.

Traffic mix:

- 60% BET, 25% WIN, 10% LOSS, 5% REFUND of an earlier processed BET;
- 5% replays;
- 20% of non-replay traffic sent through SQS;
- 20% of traffic concentrated on 5 hot wallets.

Environment:

- Windows 11 desktop, Intel i7-9700F (8 cores), 24 GB RAM, Bun 1.3.11;
- PostgreSQL 17 and LocalStack 4.14 in Docker Desktop (WSL2);
- the 3 service instances run on the host with a pool of 20 connections each;
- everything shares one machine, including the load generator.

| Run                               | HTTP req/s | SQS msg/s | p50 / p95 / p99 (ms) | Errors | Outbox lag avg / max (s) | Wallets consistent |
| --------------------------------- | ---------- | --------- | -------------------- | ------ | ------------------------ | ------------------ |
| Before the publisher optimization | 239        | 51        | 160 / 791 / 2094     | 0%     | 10.4 / 15.3              | 200 / 200          |
| After, run 1                      | 151        | 33        | 262 / 1394 / 2398    | 0%     | 1.6 / 6.2                | 200 / 200          |
| After, run 2                      | 183        | 41        | 197 / 1002 / 2699    | 0%     | 1.7 / 4.2                | 200 / 200          |
| After, run 3                      | 242        | 50        | 140 / 818 / 1806     | 0%     | 1.8 / 4.9                | 200 / 200          |

Analysis:

- **Correctness held in every run**: every response was 200, every wallet reconciled, and every replay was recognized (`wagering_duplicates_total` matched the replays sent).
- **Outbox lag was the real bottleneck**, found by measurement:
  - Published and produced rates were both about 315 events/s, with a constant ~10s backlog, so the publishers were saturated.
  - LocalStack alone accepts 2,000–3,000 msg/s, so the broker wasn't the limit.
  - The cost was one `UPDATE` round trip per published event. Replacing those with one bulk `UPDATE` per batch (plus lanes) cut the average lag about 6× (to ~1.7s), and the mean publish delay measured in the database to 0.46s.
- **Throughput variance (151–242 req/s) is environmental**: identical runs on a shared desktop with Docker in a VM. The numbers are a sanity check, not a capacity figure. No RPS target was set.
- **Tail latency (p99 ~2s) comes from hot wallets**: 20% of traffic serializes on 5 row locks by design. `lock_conflicts` stayed 0, because pessimistic locking queues waiters instead of failing them. Lock wait time is not metered separately; it shows up as latency. A lock-wait histogram would be the next metric to add.

## 16. Limitations and future work

- **Correlation for worker-produced events**: when a pending reference is resolved asynchronously, the original request's correlation id isn't stored, so the events use `transaction:<id>` as correlation and the transaction id as causation. Storing `correlation_id` on the transaction would fix that.
- **Idempotency keys are unique across all providers**, not scoped per provider. The recommended `{providerId}:{externalTransactionId}` format makes collisions impossible in practice.
- **Single-entry ledger**: double-entry bookkeeping (house and player accounts) is not implemented.
- **No partial reversals**, as the challenge allows.
- **No outbox retention**: there is no archival or partitioning of published rows yet. A periodic delete or partition drop of old published rows would be needed in production.
- **Lock contention on hot wallets** is inherent to per-wallet serialization. Sharding a wallet into sub-balances would be the next step if a single wallet needed more than a few hundred operations per second.
- **Environment note**: during development a Docker VM whose clock was 3 hours off made PostgreSQL fire `statement_timeout`/`lock_timeout` early under contention. This was reproduced with plain `pgbench`. Keep host and VM clocks in sync when running the suites.
