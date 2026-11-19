import { CurrencyMismatchError, InvalidMoneyError } from "./money.error";
import type { MoneyProps } from "./money.types";

const SCALE = 2;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const MAX_MINOR_UNITS = 10n ** 20n - 1n;
const UNSIGNED_AMOUNT = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const SIGNED_AMOUNT = /^-?(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class Money {
    private constructor(
        private readonly minorUnits: bigint,
        readonly currency: string,
    ) {
        Object.freeze(this);
    }

    static from(props: MoneyProps): Money {
        return Money.parse(props, UNSIGNED_AMOUNT);
    }

    static fromPersistence(props: MoneyProps): Money {
        return Money.parse(props, SIGNED_AMOUNT);
    }

    static zero(currency: string): Money {
        return new Money(0n, Money.assertCurrency(currency));
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return Money.bounded(this.minorUnits + other.minorUnits, this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return Money.bounded(this.minorUnits - other.minorUnits, this.currency);
    }

    negate(): Money {
        return new Money(-this.minorUnits, this.currency);
    }

    isZero(): boolean {
        return this.minorUnits === 0n;
    }

    isPositive(): boolean {
        return this.minorUnits > 0n;
    }

    isNegative(): boolean {
        return this.minorUnits < 0n;
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.minorUnits < other.minorUnits;
    }

    isGreaterThanOrEqual(other: Money): boolean {
        return !this.isLessThan(other);
    }

    equals(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.minorUnits === other.minorUnits;
    }

    hasCurrency(currency: string): boolean {
        return this.currency === currency;
    }

    toJSON(): MoneyProps {
        return { amount: this.formatAmount(), currency: this.currency };
    }

    toString(): string {
        return `${this.formatAmount()} ${this.currency}`;
    }

    private formatAmount(): string {
        const negative = this.minorUnits < 0n;
        const absolute = negative ? -this.minorUnits : this.minorUnits;
        const integer = absolute / SCALE_FACTOR;
        const fraction = (absolute % SCALE_FACTOR).toString().padStart(SCALE, "0");
        return `${negative ? "-" : ""}${integer}.${fraction}`;
    }

    private assertSameCurrency(other: Money): void {
        if (other.currency !== this.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }

    private static parse(props: MoneyProps, pattern: RegExp): Money {
        const currency = Money.assertCurrency(props?.currency);
        const amount = props?.amount;
        if (typeof amount !== "string" || !pattern.test(amount)) {
            throw new InvalidMoneyError(`Invalid monetary amount: ${String(amount)}`);
        }
        const negative = amount.startsWith("-");
        const unsigned = negative ? amount.slice(1) : amount;
        const [integerPart = "0", fractionPart = ""] = unsigned.split(".");
        const minorUnits = BigInt(integerPart) * SCALE_FACTOR + BigInt(fractionPart.padEnd(SCALE, "0"));
        return Money.bounded(negative ? -minorUnits : minorUnits, currency);
    }

    private static bounded(minorUnits: bigint, currency: string): Money {
        const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
        if (absolute > MAX_MINOR_UNITS) {
            throw new InvalidMoneyError("Monetary amount exceeds the supported precision");
        }
        return new Money(minorUnits, currency);
    }

    private static assertCurrency(currency: unknown): string {
        if (typeof currency !== "string" || !CURRENCY.test(currency)) {
            throw new InvalidMoneyError(`Invalid currency: ${String(currency)}`);
        }
        return currency;
    }
}
