import type { Money } from "../money/money.value-object";
import { LedgerDirection } from "./ledger-direction.enum";
import { InvalidLedgerEntryError } from "./wallet.error";

export interface LedgerEntryState {
    id: string;
    walletId: string;
    transactionId: string;
    walletVersion: number;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
    private constructor(
        readonly id: string,
        readonly walletId: string,
        readonly transactionId: string,
        readonly walletVersion: number,
        readonly direction: LedgerDirection,
        readonly money: Money,
        readonly balanceBefore: Money,
        readonly balanceAfter: Money,
        readonly createdAt: Date,
    ) {
        Object.freeze(this);
    }

    static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
        const entry = WalletLedgerEntry.rehydrate(props);
        if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
            throw new InvalidLedgerEntryError("Ledger entry wallet version must be a positive integer");
        }
        if (!entry.money.isPositive()) {
            throw new InvalidLedgerEntryError("Ledger entry amount must be positive");
        }
        if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
            throw new InvalidLedgerEntryError("Ledger entry balances must not be negative");
        }
        if (!entry.isBalanced()) {
            throw new InvalidLedgerEntryError("Ledger entry arithmetic does not balance");
        }
        return entry;
    }

    static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(
            state.id,
            state.walletId,
            state.transactionId,
            state.walletVersion,
            state.direction,
            state.money,
            state.balanceBefore,
            state.balanceAfter,
            new Date(state.createdAt),
        );
    }

    isBalanced(): boolean {
        const expected =
            this.direction === LedgerDirection.Credit
                ? this.balanceBefore.add(this.money)
                : this.balanceBefore.subtract(this.money);
        return expected.equals(this.balanceAfter);
    }

    signedAmount(): Money {
        return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
    }
}
