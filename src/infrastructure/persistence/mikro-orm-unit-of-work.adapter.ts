import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { ApplicationError } from "../../application/errors/application.error";
import type { TransactionalRepositories, UnitOfWork } from "../../application/ports/unit-of-work.port";
import { DomainError } from "../../domain/shared/domain.error";
import { translatePostgresError } from "./postgres-error.service";
import { MikroOrmInboxMessageRepository } from "./repositories/mikro-orm-inbox-message.repository";
import { MikroOrmOutboxMessageRepository } from "./repositories/mikro-orm-outbox-message.repository";
import { MikroOrmWagerTransactionRepository } from "./repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletRepository } from "./repositories/mikro-orm-wallet.repository";
import { MikroOrmWalletLedgerEntryRepository } from "./repositories/mikro-orm-wallet-ledger-entry.repository";

export function repositoriesFor(em: EntityManager): TransactionalRepositories {
    return {
        wallets: new MikroOrmWalletRepository(em),
        ledger: new MikroOrmWalletLedgerEntryRepository(em),
        transactions: new MikroOrmWagerTransactionRepository(em),
        inbox: new MikroOrmInboxMessageRepository(em),
        outbox: new MikroOrmOutboxMessageRepository(em),
    };
}

export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(private readonly orm: MikroORM) {}

    async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
        try {
            return await this.orm.em.fork().transactional((em) => work(repositoriesFor(em)));
        } catch (error) {
            if (error instanceof ApplicationError || error instanceof DomainError) {
                throw error;
            }
            throw translatePostgresError(error);
        }
    }
}
