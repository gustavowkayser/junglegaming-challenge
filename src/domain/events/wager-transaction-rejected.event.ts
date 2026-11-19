import type { MoneyProps } from "../money/money.types";
import { withoutUndefined } from "../shared/deep-freeze.service";
import type { WagerTransaction } from "../wagering/wager-transaction.aggregate";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status.enum";
import type { EventContext } from "./event-context.types";
import { IntegrationEvent } from "./integration-event.base";
import { identityOf, requireDate, type WagerTransactionIdentity } from "./wager-transaction-event-data.types";

export interface WagerTransactionRejectedData extends WagerTransactionIdentity {
    status: string;
    failureCode: string;
    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;
    balance?: MoneyProps;
    rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
    readonly eventType = "WagerTransactionRejected";
    readonly version = 1;

    static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
        const terminalFailure =
            transaction.status === WagerTransactionStatus.Rejected ||
            transaction.status === WagerTransactionStatus.Failed;
        if (!terminalFailure || !transaction.failureCode) {
            throw new Error(`Transaction ${transaction.id} is not rejected`);
        }
        return new WagerTransactionRejected({
            ...context,
            aggregateId: transaction.walletId,
            data: withoutUndefined({
                ...identityOf(transaction),
                status: transaction.status,
                failureCode: transaction.failureCode,
                referenceExternalTransactionId: transaction.referenceExternalTransactionId,
                referenceTransactionId: transaction.referenceTransactionId,
                balance: transaction.resultBalance?.toJSON(),
                rejectedAt: requireDate(transaction.processedAt, "processedAt"),
            }),
        });
    }
}
