import type { MoneyProps } from "../../domain/money/money.types";
import type { Wallet } from "../../domain/wallet/wallet.aggregate";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry.entity";

export interface WalletView {
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
}

export interface LedgerEntryView {
    id: string;
    transactionId: string;
    walletVersion: number;
    direction: string;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
    return {
        id: entry.id,
        transactionId: entry.transactionId,
        walletVersion: entry.walletVersion,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
    };
}
