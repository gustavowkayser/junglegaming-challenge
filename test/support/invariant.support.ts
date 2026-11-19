import { expect } from "bun:test";
import { sql } from "./database.support";

interface InvariantRow {
    id: string;
    balance: string;
    version: number;
    ledger_balance: string;
    entries: string;
    max_version: number | null;
    last_balance_after: string | null;
}

const INVARIANT_SQL = `
    select
        wallet.id,
        wallet.balance::text as balance,
        wallet.version,
        coalesce(sum(case entry.direction when 'CREDIT' then entry.amount else -entry.amount end), 0)::numeric(20, 2)::text
            as ledger_balance,
        count(entry.id) as entries,
        max(entry.wallet_version) as max_version,
        (select last.balance_after::text from wallet_ledger_entries last
            where last.wallet_id = wallet.id order by last.wallet_version desc limit 1) as last_balance_after
    from wallets wallet
    left join wallet_ledger_entries entry on entry.wallet_id = wallet.id
    where (?::uuid is null or wallet.id = ?::uuid)
    group by wallet.id
`;

export async function assertLedgerInvariant(walletId?: string): Promise<void> {
    const rows = await sql<InvariantRow>(INVARIANT_SQL, [walletId ?? null, walletId ?? null]);
    if (walletId) {
        expect(rows.length).toBe(1);
    }
    for (const row of rows) {
        expect({ wallet: row.id, balance: row.balance }).toEqual({ wallet: row.id, balance: row.ledger_balance });
        if (Number(row.entries) > 0) {
            expect(row.last_balance_after).toBe(row.balance);
            expect(row.max_version).toBe(row.version);
        } else {
            expect(row.version).toBe(1);
        }
    }
}

export async function walletBalance(walletId: string): Promise<string> {
    const [row] = await sql<{ balance: string }>("select balance::text as balance from wallets where id = ?", [
        walletId,
    ]);
    if (!row) {
        throw new Error(`Wallet ${walletId} not found`);
    }
    return row.balance;
}

export async function ledgerEntries(walletId: string) {
    return sql<{ direction: string; amount: string; wallet_version: number; transaction_id: string }>(
        "select direction, amount::text as amount, wallet_version, transaction_id from wallet_ledger_entries where wallet_id = ? order by wallet_version",
        [walletId],
    );
}
