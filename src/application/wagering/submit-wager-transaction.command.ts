import type { MoneyProps } from "../../domain/money/money.types";
import type { SubmittableKind } from "../../domain/wagering/wager-transaction-kind.enum";
import type { TransactionSource } from "../ports/metrics.port";

export interface InboxReceipt {
    consumerName: string;
    messageId: string;
    payloadHash: string;
}

export interface SubmitWagerTransactionCommand {
    idempotencyKey: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: SubmittableKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string | undefined;
    source: TransactionSource;
    correlationId: string;
    causationId?: string | undefined;
    inbox?: InboxReceipt | undefined;
}
