import { randomUUID } from "node:crypto";
import { Money } from "../../src/domain/money/money.value-object";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction.aggregate";
import { type SubmittableKind, WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind.enum";
import { Wallet } from "../../src/domain/wallet/wallet.aggregate";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export function openWallet(amount = "100.00", now = new Date()) {
    return Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl(amount), now });
}

export function newTransaction(
    wallet: Wallet,
    kind: SubmittableKind,
    amount: string,
    overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) {
    const externalTransactionId = overrides.externalTransactionId ?? `ext-${randomUUID()}`;
    return WagerTransaction.create({
        id: randomUUID(),
        providerId: "provider-a",
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        payloadHash: "a".repeat(64),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: brl(amount),
        referenceExternalTransactionId:
            kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
                ? "ext-reference"
                : undefined,
        now: new Date(),
        ...overrides,
    });
}

export function bettingPayload(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
    const externalTransactionId = `ext-${randomUUID()}`;
    return {
        providerId: "provider-a",
        externalTransactionId,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        ...overrides,
    };
}
