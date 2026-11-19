import type { EventContext } from "../../domain/events/event-context.types";
import type { IntegrationEvent } from "../../domain/events/integration-event.base";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import { OutboxMessage } from "../../domain/messaging/outbox-message.entity";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction.aggregate";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status.enum";
import type { Wallet } from "../../domain/wallet/wallet.aggregate";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry.entity";

export function outcomeEvents(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: () => EventContext,
): IntegrationEvent<unknown>[] {
    switch (transaction.status) {
        case WagerTransactionStatus.Processed:
            return entry
                ? [
                      WagerTransactionProcessed.from(transaction, context()),
                      WalletBalanceChanged.from(wallet, entry, context()),
                  ]
                : [WagerTransactionProcessed.from(transaction, context())];
        case WagerTransactionStatus.Rejected:
        case WagerTransactionStatus.Failed:
            return [WagerTransactionRejected.from(transaction, context())];
        case WagerTransactionStatus.PendingReference:
            return [WagerTransactionPendingReference.from(transaction, context())];
        case WagerTransactionStatus.Pending:
            return [];
    }
}

export function toOutboxMessages(events: IntegrationEvent<unknown>[]): OutboxMessage[] {
    return events.map((event) => OutboxMessage.enqueue(event));
}
