import type { WagerTransaction } from "../wagering/wager-transaction.aggregate";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status.enum";
import type { EventContext } from "./event-context.types";
import { IntegrationEvent } from "./integration-event.base";
import { identityOf, requireDate, type WagerTransactionIdentity } from "./wager-transaction-event-data.types";

export interface WagerTransactionPendingReferenceData extends WagerTransactionIdentity {
    referenceExternalTransactionId: string;
    attempts: number;
    nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
    readonly eventType = "WagerTransactionPendingReference";
    readonly version = 1;

    static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
        if (
            transaction.status !== WagerTransactionStatus.PendingReference ||
            transaction.referenceExternalTransactionId === undefined
        ) {
            throw new Error(`Transaction ${transaction.id} is not waiting for a reference`);
        }
        return new WagerTransactionPendingReference({
            ...context,
            aggregateId: transaction.walletId,
            data: {
                ...identityOf(transaction),
                referenceExternalTransactionId: transaction.referenceExternalTransactionId,
                attempts: transaction.referenceAttempts,
                nextAttemptAt: requireDate(transaction.nextReferenceAttemptAt, "nextReferenceAttemptAt"),
            },
        });
    }
}
