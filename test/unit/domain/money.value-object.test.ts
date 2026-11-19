import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/money/money.error";
import { Money } from "../../../src/domain/money/money.value-object";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
    test("normalizes to a fixed scale of two decimals", () => {
        expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
        expect(brl("25.5").toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
        expect(brl("25.05").toJSON()).toEqual({ amount: "25.05", currency: "BRL" });
        expect(brl("0").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
        expect(brl("0.01").toJSON()).toEqual({ amount: "0.01", currency: "BRL" });
    });

    test.each([
        "",
        " ",
        " 1.00",
        "1.00 ",
        "NaN",
        "Infinity",
        "-Infinity",
        "1e3",
        "1E3",
        "-1.00",
        "+1.00",
        "1.234",
        "1.005",
        "01.00",
        ".5",
        "5.",
        "1,00",
        "0x10",
        "1000000000000000000.00",
    ])("rejects invalid amount %p", (amount) => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    test.each(["", "brl", "BR", "BRLL", "R$", "123"])("rejects invalid currency %p", (currency) => {
        expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    });

    test("rejects non-string amounts", () => {
        expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    });

    test("accepts the largest representable amount", () => {
        expect(brl("999999999999999999.99").toString()).toBe("999999999999999999.99 BRL");
    });
});

describe("Money.fromPersistence", () => {
    test("accepts signed values", () => {
        expect(Money.fromPersistence({ amount: "-5.10", currency: "BRL" }).toJSON().amount).toBe("-5.10");
    });

    test("still rejects malformed values", () => {
        expect(() => Money.fromPersistence({ amount: "-5.101", currency: "BRL" })).toThrow(InvalidMoneyError);
    });
});

describe("Money arithmetic", () => {
    test("adds exactly without floating point drift", () => {
        expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
        expect(brl("999999999999.99").add(brl("0.01")).toJSON().amount).toBe("1000000000000.00");
    });

    test("subtracts exactly", () => {
        expect(brl("100.00").subtract(brl("80.00")).toJSON().amount).toBe("20.00");
        expect(brl("0.30").subtract(brl("0.10")).toJSON().amount).toBe("0.20");
    });

    test("subtraction may produce a negative internal value", () => {
        const result = brl("20.00").subtract(brl("80.00"));

        expect(result.isNegative()).toBe(true);
        expect(result.toJSON().amount).toBe("-60.00");
    });

    test("negate flips the sign", () => {
        expect(brl("12.34").negate().toJSON().amount).toBe("-12.34");
        expect(brl("12.34").negate().negate().equals(brl("12.34"))).toBe(true);
        expect(brl("0").negate().toJSON().amount).toBe("0.00");
    });

    test("is immutable", () => {
        const original = brl("10.00");
        original.add(brl("5.00"));
        original.subtract(brl("5.00"));
        original.negate();

        expect(original.toJSON().amount).toBe("10.00");
        expect(Object.isFrozen(original)).toBe(true);
    });
});

describe("Money comparisons", () => {
    test("sign predicates", () => {
        expect(Money.zero("BRL").isZero()).toBe(true);
        expect(brl("0.01").isPositive()).toBe(true);
        expect(brl("0.01").isNegative()).toBe(false);
        expect(Money.zero("BRL").isPositive()).toBe(false);
    });

    test("isLessThan and equals", () => {
        expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
        expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
        expect(brl("80").equals(brl("80.00"))).toBe(true);
        expect(brl("80.01").equals(brl("80.00"))).toBe(false);
    });

    test("isGreaterThanOrEqual", () => {
        expect(brl("80.00").isGreaterThanOrEqual(brl("80.00"))).toBe(true);
        expect(brl("79.99").isGreaterThanOrEqual(brl("80.00"))).toBe(false);
    });
});

describe("Money currency conflicts", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });

    test.each([
        ["add", () => brl("1.00").add(usd)],
        ["subtract", () => brl("1.00").subtract(usd)],
        ["isLessThan", () => brl("1.00").isLessThan(usd)],
        ["isGreaterThanOrEqual", () => brl("1.00").isGreaterThanOrEqual(usd)],
        ["equals", () => brl("1.00").equals(usd)],
    ])("%s throws CurrencyMismatchError", (_name, operation) => {
        expect(operation).toThrow(CurrencyMismatchError);
    });

    test("hasCurrency", () => {
        expect(brl("1.00").hasCurrency("BRL")).toBe(true);
        expect(brl("1.00").hasCurrency("USD")).toBe(false);
    });
});

describe("Money serialization", () => {
    test("toString", () => {
        expect(brl("25").toString()).toBe("25.00 BRL");
    });

    test("JSON.stringify uses the decimal string contract", () => {
        expect(JSON.stringify({ money: brl("25") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    });

    test("round trips through toJSON", () => {
        const money = brl("1234.56");

        expect(Money.from(money.toJSON()).equals(money)).toBe(true);
    });
});
