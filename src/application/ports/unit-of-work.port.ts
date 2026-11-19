import type { InboxMessageRepository } from "../../domain/messaging/inbox-message.repository";
import type { OutboxMessageRepository } from "../../domain/messaging/outbox-message.repository";
import type { WagerTransactionRepository } from "../../domain/wagering/wager-transaction.repository";
import type { WalletRepository } from "../../domain/wallet/wallet.repository";
import type { WalletLedgerEntryRepository } from "../../domain/wallet/wallet-ledger-entry.repository";

export interface TransactionalRepositories {
    wallets: WalletRepository;
    ledger: WalletLedgerEntryRepository;
    transactions: WagerTransactionRepository;
    inbox: InboxMessageRepository;
    outbox: OutboxMessageRepository;
}

export interface UnitOfWork {
    run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UnitOfWork");
