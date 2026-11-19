import { Money } from "../../../domain/money/money.value-object";
import type { LedgerDirection } from "../../../domain/wallet/ledger-direction.enum";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry.entity";
import type { WalletLedgerEntryRecord } from "../records/wallet-ledger-entry.record";

export const WalletLedgerEntryMapper = {
    toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
        const money = (amount: string) => Money.fromPersistence({ amount, currency: record.currency });
        return WalletLedgerEntry.rehydrate({
            id: record.id,
            walletId: record.walletId,
            transactionId: record.transactionId,
            walletVersion: record.walletVersion,
            direction: record.direction as LedgerDirection,
            money: money(record.amount),
            balanceBefore: money(record.balanceBefore),
            balanceAfter: money(record.balanceAfter),
            createdAt: record.createdAt,
        });
    },

    toRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
        return {
            id: entry.id,
            walletId: entry.walletId,
            transactionId: entry.transactionId,
            walletVersion: entry.walletVersion,
            direction: entry.direction,
            amount: entry.money.toJSON().amount,
            currency: entry.money.currency,
            balanceBefore: entry.balanceBefore.toJSON().amount,
            balanceAfter: entry.balanceAfter.toJSON().amount,
            createdAt: entry.createdAt,
        };
    },
};
