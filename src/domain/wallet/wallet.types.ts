import type { Money } from "../money/money.value-object";

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
    now: Date;
}

export interface BalanceMovementProps {
    entryId: string;
    transactionId: string;
    money: Money;
    now: Date;
}

export interface OpeningCreditProps {
    entryId: string;
    transactionId: string;
    now: Date;
}
