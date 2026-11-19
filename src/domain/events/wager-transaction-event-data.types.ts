import type { MoneyProps } from "../money/money.types";
import type { WagerTransaction } from "../wagering/wager-transaction.aggregate";

export interface WagerTransactionIdentity {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: MoneyProps;
}

export function identityOf(transaction: WagerTransaction): WagerTransactionIdentity {
    return {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
    };
}

export function requireResultBalance(transaction: WagerTransaction): MoneyProps {
    if (!transaction.resultBalance) {
        throw new Error(`Transaction ${transaction.id} has no result balance`);
    }
    return transaction.resultBalance.toJSON();
}

export function requireDate(value: Date | undefined, field: string): string {
    if (!value) {
        throw new Error(`Missing ${field}`);
    }
    return value.toISOString();
}
