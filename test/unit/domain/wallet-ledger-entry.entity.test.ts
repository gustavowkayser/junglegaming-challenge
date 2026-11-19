import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError } from "../../../src/domain/money/money.error";
import { Money } from "../../../src/domain/money/money.value-object";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction.enum";
import { InvalidLedgerEntryError } from "../../../src/domain/wallet/wallet.error";
import { WalletLedgerEntry } from "../../../src/domain/wallet/wallet-ledger-entry.entity";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-01-01T00:00:00.000Z");

const props = (overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) => ({
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "transaction-1",
    walletVersion: 2,
    direction: LedgerDirection.Debit,
    money: brl("25.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    createdAt: now,
    ...overrides,
});

describe("WalletLedgerEntry.create", () => {
    test("creates a balanced debit", () => {
        const entry = WalletLedgerEntry.create(props());

        expect(entry.isBalanced()).toBe(true);
        expect(entry.direction).toBe(LedgerDirection.Debit);
        expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
    });

    test("creates a balanced credit", () => {
        const entry = WalletLedgerEntry.create(
            props({ direction: LedgerDirection.Credit, balanceAfter: brl("125.00") }),
        );

        expect(entry.isBalanced()).toBe(true);
    });

    test("rejects unbalanced arithmetic", () => {
        expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl("80.00") }))).toThrow(InvalidLedgerEntryError);
        expect(() =>
            WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit, balanceAfter: brl("75.00") })),
        ).toThrow(InvalidLedgerEntryError);
    });

    test("rejects a zero amount", () => {
        expect(() => WalletLedgerEntry.create(props({ money: brl("0"), balanceAfter: brl("100.00") }))).toThrow(
            InvalidLedgerEntryError,
        );
    });

    test("rejects a negative resulting balance", () => {
        expect(() =>
            WalletLedgerEntry.create(
                props({ balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("25.00")) }),
            ),
        ).toThrow(InvalidLedgerEntryError);
    });

    test("rejects a non-positive wallet version", () => {
        expect(() => WalletLedgerEntry.create(props({ walletVersion: 0 }))).toThrow(InvalidLedgerEntryError);
    });

    test("rejects mixed currencies", () => {
        const usd = Money.from({ amount: "25.00", currency: "USD" });

        expect(() => WalletLedgerEntry.create(props({ money: usd }))).toThrow(CurrencyMismatchError);
    });

    test("is structurally immutable", () => {
        const entry = WalletLedgerEntry.create(props());

        expect(Object.isFrozen(entry)).toBe(true);
        expect(() => {
            (entry as unknown as { walletId: string }).walletId = "other";
        }).toThrow();
    });
});

describe("WalletLedgerEntry.rehydrate", () => {
    test("does not revalidate persisted state", () => {
        const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("1.00") }));

        expect(entry.isBalanced()).toBe(false);
    });
});
