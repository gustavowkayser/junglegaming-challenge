import type { MoneyProps } from "../money/money.types";
import { withoutUndefined } from "../shared/deep-freeze.service";
import type { WagerTransaction } from "../wagering/wager-transaction.aggregate";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status.enum";
import type { EventContext } from "./event-context.types";
import { IntegrationEvent } from "./integration-event.base";
import {
    identityOf,
    requireDate,
    requireResultBalance,
    type WagerTransactionIdentity,
} from "./wager-transaction-event-data.types";

export interface WagerTransactionProcessedData extends WagerTransactionIdentity {
    referenceTransactionId?: string;
    balance: MoneyProps;
    processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
    readonly eventType = "WagerTransactionProcessed";
    readonly version = 1;

    static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
        if (transaction.status !== WagerTransactionStatus.Processed) {
            throw new Error(`Transaction ${transaction.id} is not processed`);
        }
        return new WagerTransactionProcessed({
            ...context,
            aggregateId: transaction.walletId,
            data: withoutUndefined({
                ...identityOf(transaction),
                referenceTransactionId: transaction.referenceTransactionId,
                balance: requireResultBalance(transaction),
                processedAt: requireDate(transaction.processedAt, "processedAt"),
            }),
        });
    }
}
