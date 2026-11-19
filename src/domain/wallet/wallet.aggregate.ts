import { CurrencyMismatchError } from "../money/money.error";
import { Money } from "../money/money.value-object";
import { LedgerDirection } from "./ledger-direction.enum";
import { InsufficientFundsError, InvalidWalletOperationError } from "./wallet.error";
import type { BalanceMovementProps, OpeningCreditProps, OpenWalletProps, WalletState } from "./wallet.types";
import { WalletLedgerEntry } from "./wallet-ledger-entry.entity";

export class Wallet {
    private constructor(
        readonly id: string,
        readonly playerId: string,
        readonly currency: string,
        private _balance: Money,
        private _version: number,
        readonly createdAt: Date,
        private _updatedAt: Date,
        private readonly _persistedVersion: number,
    ) {}

    static open(props: OpenWalletProps): Wallet {
        if (props.initialBalance.isNegative()) {
            throw new InvalidWalletOperationError("Initial balance must not be negative");
        }
        return new Wallet(
            props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            new Date(props.now),
            new Date(props.now),
            1,
        );
    }

    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.currency,
            state.balance,
            state.version,
            new Date(state.createdAt),
            new Date(state.updatedAt),
            state.version,
        );
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }

    get persistedVersion(): number {
        return this._persistedVersion;
    }

    hasChanges(): boolean {
        return this._version !== this._persistedVersion;
    }

    canDebit(money: Money): boolean {
        this.assertSameCurrency(money);
        return this._balance.isGreaterThanOrEqual(money);
    }

    openingCredit(props: OpeningCreditProps): WalletLedgerEntry | undefined {
        if (this._version !== 1 || !this._balance.isPositive()) {
            return undefined;
        }
        return WalletLedgerEntry.create({
            id: props.entryId,
            walletId: this.id,
            transactionId: props.transactionId,
            walletVersion: 1,
            direction: LedgerDirection.Credit,
            money: this._balance,
            balanceBefore: Money.zero(this.currency),
            balanceAfter: this._balance,
            createdAt: props.now,
        });
    }

    debit(props: BalanceMovementProps): WalletLedgerEntry {
        this.assertMovement(props.money);
        if (!this.canDebit(props.money)) {
            throw new InsufficientFundsError(`Wallet ${this.id} has insufficient funds`);
        }
        return this.apply(LedgerDirection.Debit, props);
    }

    credit(props: BalanceMovementProps): WalletLedgerEntry {
        this.assertMovement(props.money);
        return this.apply(LedgerDirection.Credit, props);
    }

    private apply(direction: LedgerDirection, props: BalanceMovementProps): WalletLedgerEntry {
        const balanceBefore = this._balance;
        const balanceAfter =
            direction === LedgerDirection.Credit ? balanceBefore.add(props.money) : balanceBefore.subtract(props.money);
        const entry = WalletLedgerEntry.create({
            id: props.entryId,
            walletId: this.id,
            transactionId: props.transactionId,
            walletVersion: this._version + 1,
            direction,
            money: props.money,
            balanceBefore,
            balanceAfter,
            createdAt: props.now,
        });
        this._balance = balanceAfter;
        this._version = entry.walletVersion;
        this._updatedAt = new Date(props.now);
        return entry;
    }

    private assertMovement(money: Money): void {
        this.assertSameCurrency(money);
        if (!money.isPositive()) {
            throw new InvalidWalletOperationError("Balance movements must be positive");
        }
    }

    private assertSameCurrency(money: Money): void {
        if (!money.hasCurrency(this.currency)) {
            throw new CurrencyMismatchError(this.currency, money.currency);
        }
    }
}
