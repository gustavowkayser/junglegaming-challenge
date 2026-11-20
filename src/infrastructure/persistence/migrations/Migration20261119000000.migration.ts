import { Migration } from "@mikro-orm/migrations";

export class Migration20261119000000 extends Migration {
    override up(): void {
        this.addSql(`
            create function forbid_mutation() returns trigger language plpgsql as $$
            begin
                raise exception '% on % is not allowed', tg_op, tg_table_name using errcode = 'P0001';
            end
            $$;
        `);

        this.addSql(`
            create table wallets (
                id uuid primary key,
                player_id uuid not null,
                currency char(3) not null,
                balance numeric(20, 2) not null,
                version integer not null,
                created_at timestamptz not null,
                updated_at timestamptz not null,
                constraint wallets_player_currency_uk unique (player_id, currency),
                constraint wallets_id_currency_uk unique (id, currency),
                constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
                constraint wallets_balance_non_negative_ck check (balance >= 0),
                constraint wallets_version_ck check (version >= 1)
            );
        `);

        this.addSql(`
            create function guard_wallet_version() returns trigger language plpgsql as $$
            begin
                if new.player_id <> old.player_id or new.currency <> old.currency or new.created_at <> old.created_at then
                    raise exception 'wallet % identity is immutable', old.id using errcode = 'P0001';
                end if;
                if new.balance <> old.balance and new.version <> old.version + 1 then
                    raise exception 'wallet % balance change must increment version by one', old.id using errcode = 'P0001';
                end if;
                if new.balance = old.balance and new.version <> old.version then
                    raise exception 'wallet % version may only change with its balance', old.id using errcode = 'P0001';
                end if;
                return new;
            end
            $$;
        `);
        this.addSql(`
            create trigger wallets_version_guard before update on wallets
                for each row execute function guard_wallet_version();
        `);
        this.addSql(`
            create trigger wallets_no_delete before delete on wallets
                for each row execute function forbid_mutation();
        `);

        this.addSql(`
            create table wager_transactions (
                id uuid primary key,
                provider_id text not null,
                external_transaction_id text not null,
                idempotency_key text not null,
                payload_hash char(64) not null,
                wallet_id uuid not null references wallets (id),
                player_id uuid not null,
                round_id text not null,
                game_id text not null,
                kind text not null,
                amount numeric(20, 2) not null,
                currency char(3) not null,
                reference_external_transaction_id text,
                reference_transaction_id uuid references wager_transactions (id),
                status text not null,
                failure_code text,
                result_balance numeric(20, 2),
                reference_attempts integer not null default 0,
                next_reference_attempt_at timestamptz,
                created_at timestamptz not null,
                updated_at timestamptz not null,
                processed_at timestamptz,
                constraint wager_transactions_idempotency_key_uk unique (idempotency_key),
                constraint wager_transactions_provider_external_uk unique (provider_id, external_transaction_id),
                constraint wager_transactions_kind_ck
                    check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
                constraint wager_transactions_status_ck
                    check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
                constraint wager_transactions_amount_ck check (amount >= 0),
                constraint wager_transactions_result_balance_ck check (result_balance is null or result_balance >= 0),
                constraint wager_transactions_reference_attempts_ck check (reference_attempts >= 0),
                constraint wager_transactions_reference_required_ck
                    check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
                constraint wager_transactions_failure_code_ck
                    check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
                constraint wager_transactions_settled_ck
                    check (status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null),
                constraint wager_transactions_pending_schedule_ck
                    check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null),
                constraint wager_transactions_processed_reversal_reference_ck
                    check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null)
            );
        `);
        this.addSql(`
            create unique index wager_transactions_single_reversal_uk on wager_transactions (reference_transaction_id)
                where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
        `);
        this.addSql(`
            create index wager_transactions_pending_reference_ix on wager_transactions (next_reference_attempt_at)
                where status = 'PENDING_REFERENCE';
        `);
        this.addSql(`
            create index wager_transactions_pending_dependents_ix
                on wager_transactions (provider_id, reference_external_transaction_id)
                where status = 'PENDING_REFERENCE';
        `);
        this.addSql(`create index wager_transactions_wallet_ix on wager_transactions (wallet_id, created_at);`);

        this.addSql(`
            create function guard_terminal_wager_transaction() returns trigger language plpgsql as $$
            begin
                if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
                    raise exception 'wager transaction % is terminal', old.id using errcode = 'P0001';
                end if;
                if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
                    new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
                    new.reference_external_transaction_id, new.created_at)
                    is distinct from
                   (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
                    old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
                    old.reference_external_transaction_id, old.created_at) then
                    raise exception 'wager transaction % business fields are immutable', old.id using errcode = 'P0001';
                end if;
                return new;
            end
            $$;
        `);
        this.addSql(`
            create trigger wager_transactions_terminal_guard before update on wager_transactions
                for each row execute function guard_terminal_wager_transaction();
        `);
        this.addSql(`
            create trigger wager_transactions_no_delete before delete on wager_transactions
                for each row execute function forbid_mutation();
        `);

        this.addSql(`
            create table wallet_ledger_entries (
                id uuid primary key,
                wallet_id uuid not null,
                transaction_id uuid not null references wager_transactions (id),
                wallet_version integer not null,
                direction text not null,
                amount numeric(20, 2) not null,
                currency char(3) not null,
                balance_before numeric(20, 2) not null,
                balance_after numeric(20, 2) not null,
                created_at timestamptz not null,
                constraint wallet_ledger_entries_wallet_currency_fk
                    foreign key (wallet_id, currency) references wallets (id, currency),
                constraint wallet_ledger_entries_transaction_uk unique (transaction_id),
                constraint wallet_ledger_entries_wallet_version_uk unique (wallet_id, wallet_version),
                constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
                constraint wallet_ledger_entries_wallet_version_ck check (wallet_version >= 1),
                constraint wallet_ledger_entries_amount_ck check (amount > 0),
                constraint wallet_ledger_entries_balance_before_ck check (balance_before >= 0),
                constraint wallet_ledger_entries_balance_after_ck check (balance_after >= 0),
                constraint wallet_ledger_entries_arithmetic_ck check (
                    (direction = 'CREDIT' and balance_after = balance_before + amount)
                    or (direction = 'DEBIT' and balance_after = balance_before - amount)
                )
            );
        `);
        this.addSql(`
            create trigger wallet_ledger_entries_immutable before update or delete on wallet_ledger_entries
                for each row execute function forbid_mutation();
        `);

        this.addSql(`
            create function assert_wallet_matches_ledger() returns trigger language plpgsql as $$
            begin
                if new.balance = 0 and new.version = 1 then
                    return null;
                end if;
                if not exists (
                    select 1 from wallet_ledger_entries entry
                    where entry.wallet_id = new.id
                      and entry.wallet_version = new.version
                      and entry.balance_after = new.balance
                ) then
                    raise exception 'wallet % version % has no matching ledger entry', new.id, new.version
                        using errcode = 'P0001';
                end if;
                return null;
            end
            $$;
        `);
        this.addSql(`
            create constraint trigger wallets_ledger_consistency after insert or update on wallets
                deferrable initially deferred
                for each row execute function assert_wallet_matches_ledger();
        `);

        this.addSql(`
            create table inbox_messages (
                consumer_name text not null,
                message_id text not null,
                payload_hash char(64) not null,
                received_at timestamptz not null,
                processed_at timestamptz,
                constraint inbox_messages_pk primary key (consumer_name, message_id)
            );
        `);

        this.addSql(`
            create table outbox_messages (
                id uuid primary key,
                aggregate_id uuid not null,
                event_type text not null,
                payload jsonb not null,
                occurred_at timestamptz not null,
                attempts integer not null default 0,
                next_attempt_at timestamptz not null,
                published_at timestamptz,
                last_error text,
                constraint outbox_messages_attempts_ck check (attempts >= 0)
            );
        `);
        this.addSql(`
            create index outbox_messages_pending_ix on outbox_messages (next_attempt_at, occurred_at)
                where published_at is null;
        `);
    }

    override down(): void {
        this.addSql("drop table if exists outbox_messages;");
        this.addSql("drop table if exists inbox_messages;");
        this.addSql("drop table if exists wallet_ledger_entries;");
        this.addSql("drop table if exists wager_transactions;");
        this.addSql("drop table if exists wallets;");
        this.addSql("drop function if exists assert_wallet_matches_ledger();");
        this.addSql("drop function if exists guard_terminal_wager_transaction();");
        this.addSql("drop function if exists guard_wallet_version();");
        this.addSql("drop function if exists forbid_mutation();");
    }
}
