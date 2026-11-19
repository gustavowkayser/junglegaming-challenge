import type { MoneyProps } from "../money/money.types";
import type { LedgerDirection } from "../wallet/ledger-direction.enum";
import type { Wallet } from "../wallet/wallet.aggregate";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry.entity";
import type { EventContext } from "./event-context.types";
import { IntegrationEvent } from "./integration-event.base";

export interface WalletBalanceChangedData {
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
    readonly eventType = "WalletBalanceChanged";
    readonly version = 1;

    static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
        if (entry.walletId !== wallet.id) {
            throw new Error(`Ledger entry ${entry.id} does not belong to wallet ${wallet.id}`);
        }
        return new WalletBalanceChanged({
            ...context,
            aggregateId: wallet.id,
            data: {
                walletId: wallet.id,
                transactionId: entry.transactionId,
                direction: entry.direction,
                money: entry.money.toJSON(),
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                walletVersion: entry.walletVersion,
            },
        });
    }
}
