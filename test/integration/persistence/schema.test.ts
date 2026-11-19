import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql, testOrm, truncateAll } from "../../support/database.support";

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);

async function expectSqlError(promise: Promise<unknown>, code: string, constraint?: string) {
    const error = (await promise.then(
        () => undefined,
        (caught: unknown) => caught,
    )) as { code?: string; constraint?: string; message?: string } | undefined;
    expect(error).toBeDefined();
    expect(error?.code).toBe(code);
    if (constraint) {
        expect(`${error?.constraint ?? ""} ${error?.message ?? ""}`).toContain(constraint);
    }
}

async function insertWallet(balance = "0.00", version = 1, playerId = randomUUID(), currency = "BRL") {
    const id = randomUUID();
    await sql(
        "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        [id, playerId, currency, balance, version, NOW, NOW],
    );
    return { id, playerId };
}

interface TransactionOverrides {
    kind?: string;
    status?: string;
    reference?: string | null;
    referenceId?: string | null;
    failureCode?: string | null;
    processedAt?: string | null;
    nextAttemptAt?: string | null;
}

async function insertTransaction(walletId: string, playerId: string, overrides: TransactionOverrides = {}) {
    const id = randomUUID();
    const status = overrides.status ?? "PROCESSED";
    await sql(
        `insert into wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
            game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
            failure_code, result_balance, reference_attempts, next_reference_attempt_at, created_at, updated_at,
            processed_at
        ) values (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, '10.00', 'BRL', ?, ?, ?, ?, '0.00', 0, ?, ?, ?, ?)`,
        [
            id,
            `ext-${id}`,
            `provider-a:ext-${id}`,
            HASH,
            walletId,
            playerId,
            overrides.kind ?? "BET",
            overrides.reference ?? null,
            overrides.referenceId ?? null,
            status,
            overrides.failureCode ?? null,
            overrides.nextAttemptAt ?? null,
            NOW,
            NOW,
            overrides.processedAt === undefined ? (status === "PENDING" ? null : NOW) : overrides.processedAt,
        ],
    );
    return id;
}

async function insertEntry(
    walletId: string,
    transactionId: string,
    walletVersion: number,
    direction: string,
    before: string,
    amount: string,
    after: string,
    currency = "BRL",
) {
    await sql(
        `insert into wallet_ledger_entries (
            id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), walletId, transactionId, walletVersion, direction, amount, currency, before, after, NOW],
    );
}

async function transactionally(statements: (run: typeof sql) => Promise<void>) {
    const orm = await testOrm();
    await orm.em.fork().transactional(async (em) => {
        await statements((query, params = []) => em.execute(query, params));
    });
}

beforeEach(truncateAll);

afterAll(async () => {
    const orm = await testOrm();
    await orm.migrator.up();
});

describe("migrations", () => {
    test("are reversible", async () => {
        const orm = await testOrm();
        await orm.migrator.down({ to: 0 });
        const [afterDown] = await sql<{ count: string }>(
            "select count(*) as count from information_schema.tables where table_schema = 'public' and table_name = 'wallets'",
        );
        expect(Number(afterDown?.count)).toBe(0);

        await orm.migrator.up();
        const [afterUp] = await sql<{ count: string }>(
            "select count(*) as count from information_schema.tables where table_schema = 'public' and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')",
        );
        expect(Number(afterUp?.count)).toBe(5);
    });
});

describe("wallets", () => {
    test("one wallet per player and currency", async () => {
        const { playerId } = await insertWallet();

        await expectSqlError(insertWallet("0.00", 1, playerId), "23505", "wallets_player_currency_uk");
        await insertWallet("0.00", 1, playerId, "USD");
    });

    test("balance cannot be negative", async () => {
        await expectSqlError(insertWallet("-0.01"), "23514", "wallets_balance_non_negative_ck");
    });

    test("currency must be ISO-4217 shaped", async () => {
        await expectSqlError(insertWallet("0.00", 1, randomUUID(), "br1"), "23514", "wallets_currency_ck");
    });

    test("a funded wallet must be backed by a ledger entry at its version", async () => {
        await expectSqlError(insertWallet("10.00"), "P0001", "has no matching ledger entry");
    });

    test("balance changes must increment the version by one", async () => {
        const { id } = await insertWallet();

        await expectSqlError(sql("update wallets set balance = 10 where id = ?", [id]), "P0001");
        await expectSqlError(sql("update wallets set version = 2 where id = ?", [id]), "P0001");
    });

    test("balance changes require a matching ledger entry", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId, { kind: "WIN" });

        await expectSqlError(sql("update wallets set balance = 10, version = 2 where id = ?", [id]), "P0001");

        await transactionally(async (run) => {
            await run(
                `insert into wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
                 values (?, ?, ?, 2, 'CREDIT', '10.00', 'BRL', '0.00', '10.00', ?)`,
                [randomUUID(), id, transactionId, NOW],
            );
            await run("update wallets set balance = 10, version = 2 where id = ?", [id]);
        });
        const [row] = await sql<{ balance: string }>("select balance::text as balance from wallets where id = ?", [id]);
        expect(row?.balance).toBe("10.00");
    });

    test("wallets cannot be deleted", async () => {
        const { id } = await insertWallet();

        await expectSqlError(sql("delete from wallets where id = ?", [id]), "P0001");
    });
});

describe("wallet_ledger_entries", () => {
    test("arithmetic must balance", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId, { kind: "WIN" });

        await expectSqlError(
            insertEntry(id, transactionId, 2, "CREDIT", "0.00", "10.00", "9.00"),
            "23514",
            "wallet_ledger_entries_arithmetic_ck",
        );
    });

    test("amount must be positive and balances non-negative", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId);

        await expectSqlError(insertEntry(id, transactionId, 2, "DEBIT", "0.00", "0.00", "0.00"), "23514");
        await expectSqlError(insertEntry(id, transactionId, 2, "DEBIT", "5.00", "10.00", "-5.00"), "23514");
    });

    test("at most one entry per transaction and per wallet version", async () => {
        const { id, playerId } = await insertWallet();
        const first = await insertTransaction(id, playerId, { kind: "WIN" });
        const second = await insertTransaction(id, playerId, { kind: "WIN" });
        await insertEntry(id, first, 2, "CREDIT", "0.00", "10.00", "10.00");

        await expectSqlError(
            insertEntry(id, first, 3, "CREDIT", "10.00", "10.00", "20.00"),
            "23505",
            "wallet_ledger_entries_transaction_uk",
        );
        await expectSqlError(
            insertEntry(id, second, 2, "CREDIT", "0.00", "10.00", "10.00"),
            "23505",
            "wallet_ledger_entries_wallet_version_uk",
        );
    });

    test("entry currency must match the wallet currency", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId, { kind: "WIN" });

        await expectSqlError(
            insertEntry(id, transactionId, 2, "CREDIT", "0.00", "10.00", "10.00", "USD"),
            "23503",
            "wallet_ledger_entries_wallet_currency_fk",
        );
    });

    test("entries are immutable", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId, { kind: "WIN" });
        await insertEntry(id, transactionId, 2, "CREDIT", "0.00", "10.00", "10.00");

        await expectSqlError(sql("update wallet_ledger_entries set amount = 1 where wallet_id = ?", [id]), "P0001");
        await expectSqlError(sql("delete from wallet_ledger_entries where wallet_id = ?", [id]), "P0001");
    });
});

describe("wager_transactions", () => {
    test("idempotency key and provider external id are unique", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId);

        await expectSqlError(
            sql(
                `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, processed_at)
                 select ?, provider_id, 'other', idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, processed_at
                 from wager_transactions where id = ?`,
                [randomUUID(), transactionId],
            ),
            "23505",
            "wager_transactions_idempotency_key_uk",
        );
        await expectSqlError(
            sql(
                `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, processed_at)
                 select ?, provider_id, external_transaction_id, 'other', payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, processed_at
                 from wager_transactions where id = ?`,
                [randomUUID(), transactionId],
            ),
            "23505",
            "wager_transactions_provider_external_uk",
        );
    });

    test("REFUND and ROLLBACK require a reference", async () => {
        const { id, playerId } = await insertWallet();

        await expectSqlError(
            insertTransaction(id, playerId, { kind: "REFUND", status: "PENDING", reference: null }),
            "23514",
            "wager_transactions_reference_required_ck",
        );
    });

    test("rejections require a failure code", async () => {
        const { id, playerId } = await insertWallet();

        await expectSqlError(
            insertTransaction(id, playerId, { status: "REJECTED", failureCode: null }),
            "23514",
            "wager_transactions_failure_code_ck",
        );
        await expectSqlError(
            insertTransaction(id, playerId, { status: "PROCESSED", failureCode: "INSUFFICIENT_FUNDS" }),
            "23514",
            "wager_transactions_failure_code_ck",
        );
    });

    test("unknown kinds and statuses are rejected", async () => {
        const { id, playerId } = await insertWallet();

        await expectSqlError(
            insertTransaction(id, playerId, { kind: "JACKPOT" }),
            "23514",
            "wager_transactions_kind_ck",
        );
        await expectSqlError(
            insertTransaction(id, playerId, { status: "DONE" }),
            "23514",
            "wager_transactions_status_ck",
        );
    });

    test("pending references require a schedule", async () => {
        const { id, playerId } = await insertWallet();

        await expectSqlError(
            insertTransaction(id, playerId, {
                kind: "REFUND",
                status: "PENDING_REFERENCE",
                reference: "ext",
                processedAt: null,
            }),
            "23514",
            "wager_transactions_pending_schedule_ck",
        );
    });

    test("a reference can be reversed only once", async () => {
        const { id, playerId } = await insertWallet();
        const bet = await insertTransaction(id, playerId);
        await insertTransaction(id, playerId, { kind: "REFUND", reference: "ext", referenceId: bet });

        await expectSqlError(
            insertTransaction(id, playerId, { kind: "ROLLBACK", reference: "ext", referenceId: bet }),
            "23505",
            "wager_transactions_single_reversal_uk",
        );
        await insertTransaction(id, playerId, {
            kind: "ROLLBACK",
            reference: "ext",
            referenceId: bet,
            status: "REJECTED",
            failureCode: "REFERENCE_ALREADY_REVERSED",
        });
    });

    test("terminal transactions cannot change", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId);

        await expectSqlError(
            sql("update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?", [transactionId]),
            "P0001",
        );
        await expectSqlError(sql("delete from wager_transactions where id = ?", [transactionId]), "P0001");
    });

    test("pending transactions may settle but keep their business fields", async () => {
        const { id, playerId } = await insertWallet();
        const transactionId = await insertTransaction(id, playerId, {
            kind: "REFUND",
            status: "PENDING_REFERENCE",
            reference: "ext",
            processedAt: null,
            nextAttemptAt: NOW,
        });

        await expectSqlError(sql("update wager_transactions set amount = 99 where id = ?", [transactionId]), "P0001");
        await sql(
            "update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', processed_at = ?, next_reference_attempt_at = null where id = ?",
            [NOW, transactionId],
        );
    });
});

describe("inbox_messages", () => {
    test("message id is unique per consumer", async () => {
        const insert = (consumer: string) =>
            sql(
                "insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, 'msg-1', ?, ?)",
                [consumer, HASH, NOW],
            );
        await insert("consumer-a");
        await insert("consumer-b");

        await expectSqlError(insert("consumer-a"), "23505", "inbox_messages_pk");
    });
});
