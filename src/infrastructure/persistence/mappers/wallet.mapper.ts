import { Money } from "../../../domain/money/money.value-object";
import { Wallet } from "../../../domain/wallet/wallet.aggregate";
import type { WalletRecord } from "../records/wallet.record";

export const WalletMapper = {
    toDomain(record: WalletRecord): Wallet {
        return Wallet.rehydrate({
            id: record.id,
            playerId: record.playerId,
            currency: record.currency,
            balance: Money.fromPersistence({ amount: record.balance, currency: record.currency }),
            version: record.version,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        });
    },

    toRecord(wallet: Wallet): WalletRecord {
        return {
            id: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balance: wallet.balance.toJSON().amount,
            version: wallet.version,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
        };
    },
};
