import { describe, expect, test } from "bun:test";
import {
    businessPayloadOf,
    type WagerBusinessFields,
    WagerPayloadHasher,
} from "../../../src/application/wagering/wager-transaction-payload.service";
import { InvalidMoneyError } from "../../../src/domain/money/money.error";
import { Sha256PayloadHasher } from "../../../src/infrastructure/system/sha256-payload-hasher.adapter";

const hasher = new WagerPayloadHasher(new Sha256PayloadHasher());

const fields: WagerBusinessFields = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
};

describe("payload hash", () => {
    test("is a SHA-256 hex digest of the canonical business payload", () => {
        expect(hasher.hashBusinessFields(fields)).toMatch(/^[0-9a-f]{64}$/);
        expect(hasher.hashBusinessFields(fields)).toBe(
            new Sha256PayloadHasher().hash(
                '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
            ),
        );
    });

    test("ignores key order, amount formatting and UUID casing", () => {
        const reordered = {
            money: { currency: "BRL", amount: "25" },
            kind: "BET",
            gameId: "fortune-chimp",
            roundId: "round-987",
            walletId: fields.walletId.toUpperCase(),
            playerId: fields.playerId,
            externalTransactionId: "transaction-123",
            providerId: "provider-a",
        } satisfies WagerBusinessFields;

        expect(hasher.hashBusinessFields(reordered)).toBe(hasher.hashBusinessFields(fields));
    });

    test.each([
        ["amount", { money: { amount: "25.01", currency: "BRL" } }],
        ["currency", { money: { amount: "25.00", currency: "USD" } }],
        ["kind", { kind: "WIN" }],
        ["round", { roundId: "round-988" }],
        ["game", { gameId: "other" }],
        ["wallet", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
        ["reference", { referenceExternalTransactionId: "bet-1" }],
    ])("diverges when the %s changes", (_field, override) => {
        expect(hasher.hashBusinessFields({ ...fields, ...override })).not.toBe(hasher.hashBusinessFields(fields));
    });

    test("only business fields are part of the payload", () => {
        const withTransportFields = { ...fields, idempotencyKey: "x", correlationId: "y", source: "http" } as never;

        expect(Object.keys(businessPayloadOf(withTransportFields)).sort()).toEqual([
            "externalTransactionId",
            "gameId",
            "kind",
            "money",
            "playerId",
            "providerId",
            "referenceExternalTransactionId",
            "roundId",
            "walletId",
        ]);
        expect(hasher.hashBusinessFields(withTransportFields)).toBe(hasher.hashBusinessFields(fields));
    });

    test("rejects invalid money before hashing", () => {
        expect(() => hasher.hashBusinessFields({ ...fields, money: { amount: "1.234", currency: "BRL" } })).toThrow(
            InvalidMoneyError,
        );
    });
});
