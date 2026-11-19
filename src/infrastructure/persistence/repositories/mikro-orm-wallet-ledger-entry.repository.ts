import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../../domain/money/money.value-object";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.entity";
import type { LedgerSummary, WalletLedgerEntryRepository } from "../../../domain/wallet/wallet-ledger-entry.repository";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";
import { WalletLedgerEntryRecord } from "../records/wallet-ledger-entry.record";

interface SummaryRow {
    credits: string;
    debits: string;
    entries: string | number;
    last_balance_after: string | null;
    last_wallet_version: number | null;
}

const SUMMARY_SQL = `
    select
        coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as credits,
        coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::text as debits,
        count(*) as entries,
        (select balance_after::text from wallet_ledger_entries last
            where last.wallet_id = ? order by last.wallet_version desc limit 1) as last_balance_after,
        max(wallet_version) as last_wallet_version
    from wallet_ledger_entries
    where wallet_id = ?
`;

function decimal(value: string): string {
    return value.includes(".") ? value : `${value}.00`;
}

export class MikroOrmWalletLedgerEntryRepository implements WalletLedgerEntryRepository {
    constructor(private readonly em: EntityManager) {}

    async insert(entry: WalletLedgerEntry): Promise<void> {
        await this.em.insert(WalletLedgerEntryRecord, WalletLedgerEntryMapper.toRecord(entry));
    }

    async listByWallet(walletId: string, afterWalletVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
        const records = await this.em.find(
            WalletLedgerEntryRecord,
            { walletId, walletVersion: { $gt: afterWalletVersion } },
            { orderBy: { walletVersion: "asc" }, limit, disableIdentityMap: true },
        );
        return records.map((record) => WalletLedgerEntryMapper.toDomain(record));
    }

    async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
        const [row] = await this.em.execute<SummaryRow[]>(SUMMARY_SQL, [walletId, walletId]);
        const money = (amount: string) => Money.fromPersistence({ amount: decimal(amount), currency });
        return {
            credits: money(row?.credits ?? "0"),
            debits: money(row?.debits ?? "0"),
            count: Number(row?.entries ?? 0),
            lastBalanceAfter: row?.last_balance_after ? money(row.last_balance_after) : undefined,
            lastWalletVersion: row?.last_wallet_version ?? undefined,
        };
    }
}
