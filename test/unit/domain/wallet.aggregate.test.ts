import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError } from "../../../src/domain/money/money.error";
import { Money } from "../../../src/domain/money/money.value-object";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction.enum";
import { Wallet } from "../../../src/domain/wallet/wallet.aggregate";
import { InsufficientFundsError, InvalidWalletOperationError } from "../../../src/domain/wallet/wallet.error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const openedAt = new Date("2026-01-01T00:00:00.000Z");
const later = new Date("2026-01-01T00:05:00.000Z");

const openWallet = (amount = "100.00") =>
    Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(amount), now: openedAt });

const movement = (amount: string, entryId = "entry-2") => ({
    entryId,
    transactionId: `tx-${entryId}`,
    money: brl(amount),
    now: later,
});

describe("Wallet.open", () => {
    test("starts at version 1 with the initial balance", () => {
        const wallet = openWallet();

        expect(wallet.version).toBe(1);
        expect(wallet.persistedVersion).toBe(1);
        expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
        expect(wallet.currency).toBe("BRL");
        expect(wallet.createdAt).toEqual(openedAt);
        expect(wallet.updatedAt).toEqual(openedAt);
        expect(wallet.hasChanges()).toBe(false);
    });

    test("can open with a zero balance", () => {
        expect(openWallet("0").balance.isZero()).toBe(true);
    });

    test("rejects a negative initial balance", () => {
        expect(() =>
            Wallet.open({
                id: "wallet-1",
                playerId: "player-1",
                initialBalance: brl("1.00").negate(),
                now: openedAt,
            }),
        ).toThrow(InvalidWalletOperationError);
    });
});

describe("Wallet.openingCredit", () => {
    test("records the initial balance as version 1 without changing state", () => {
        const wallet = openWallet();
        const entry = wallet.openingCredit({ entryId: "entry-1", transactionId: "opening", now: openedAt });

        expect(entry?.walletVersion).toBe(1);
        expect(entry?.direction).toBe(LedgerDirection.Credit);
        expect(entry?.balanceBefore.isZero()).toBe(true);
        expect(entry?.balanceAfter.equals(brl("100.00"))).toBe(true);
        expect(wallet.version).toBe(1);
    });

    test("returns nothing for a zero balance", () => {
        expect(openWallet("0").openingCredit({ entryId: "e", transactionId: "t", now: openedAt })).toBeUndefined();
    });
});

describe("Wallet.debit", () => {
    test("decreases the balance, increments the version and produces a balanced entry", () => {
        const wallet = openWallet();
        const entry = wallet.debit(movement("25.00"));

        expect(wallet.balance.toJSON().amount).toBe("75.00");
        expect(wallet.version).toBe(2);
        expect(wallet.persistedVersion).toBe(1);
        expect(wallet.updatedAt).toEqual(later);
        expect(wallet.hasChanges()).toBe(true);
        expect(entry.direction).toBe(LedgerDirection.Debit);
        expect(entry.walletVersion).toBe(2);
        expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
        expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
        expect(entry.isBalanced()).toBe(true);
    });

    test("allows debiting the exact balance", () => {
        const wallet = openWallet("80.00");
        wallet.debit(movement("80.00"));

        expect(wallet.balance.isZero()).toBe(true);
    });

    test("rejects insufficient funds without changing state", () => {
        const wallet = openWallet();

        expect(() => wallet.debit(movement("100.01"))).toThrow(InsufficientFundsError);
        expect(wallet.balance.toJSON().amount).toBe("100.00");
        expect(wallet.version).toBe(1);
    });

    test("rejects non-positive amounts", () => {
        expect(() => openWallet().debit(movement("0"))).toThrow(InvalidWalletOperationError);
    });

    test("rejects another currency", () => {
        const wallet = openWallet();

        expect(() =>
            wallet.debit({ ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) }),
        ).toThrow(CurrencyMismatchError);
    });

    test("canDebit reflects the available balance", () => {
        const wallet = openWallet();

        expect(wallet.canDebit(brl("100.00"))).toBe(true);
        expect(wallet.canDebit(brl("100.01"))).toBe(false);
    });
});

describe("Wallet.credit", () => {
    test("increases the balance and the version", () => {
        const wallet = openWallet();
        const entry = wallet.credit(movement("50.00"));

        expect(wallet.balance.toJSON().amount).toBe("150.00");
        expect(wallet.version).toBe(2);
        expect(entry.direction).toBe(LedgerDirection.Credit);
        expect(entry.walletVersion).toBe(2);
    });

    test("sequential movements keep versions contiguous", () => {
        const wallet = openWallet();
        const first = wallet.credit(movement("10.00", "a"));
        const second = wallet.debit(movement("5.00", "b"));

        expect([first.walletVersion, second.walletVersion]).toEqual([2, 3]);
        expect(second.balanceBefore.equals(first.balanceAfter)).toBe(true);
        expect(wallet.version).toBe(3);
    });

    test("rejects another currency", () => {
        expect(() =>
            openWallet().credit({ ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) }),
        ).toThrow(CurrencyMismatchError);
    });
});

describe("Wallet.rehydrate", () => {
    test("restores persisted state", () => {
        const wallet = Wallet.rehydrate({
            id: "wallet-1",
            playerId: "player-1",
            currency: "BRL",
            balance: brl("42.00"),
            version: 7,
            createdAt: openedAt,
            updatedAt: later,
        });

        expect(wallet.version).toBe(7);
        expect(wallet.persistedVersion).toBe(7);
        expect(wallet.balance.toJSON().amount).toBe("42.00");
        expect(wallet.hasChanges()).toBe(false);
    });
});
