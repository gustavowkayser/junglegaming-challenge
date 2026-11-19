import type { Money } from "../money/money.value-object";
import type { WalletLedgerEntry } from "./wallet-ledger-entry.entity";

export interface LedgerSummary {
    credits: Money;
    debits: Money;
    count: number;
    lastBalanceAfter: Money | undefined;
    lastWalletVersion: number | undefined;
}

export interface WalletLedgerEntryRepository {
    insert(entry: WalletLedgerEntry): Promise<void>;
    listByWallet(walletId: string, afterWalletVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
    summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
