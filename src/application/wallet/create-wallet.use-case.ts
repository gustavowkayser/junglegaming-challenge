import type { MoneyProps } from "../../domain/money/money.types";
import { Money } from "../../domain/money/money.value-object";
import { DomainError } from "../../domain/shared/domain.error";
import { WagerTransaction } from "../../domain/wagering/wager-transaction.aggregate";
import { Wallet } from "../../domain/wallet/wallet.aggregate";
import { ConflictError, UniqueConstraintRaceError, ValidationError } from "../errors/application.error";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { Metrics } from "../ports/metrics.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { CorrelationContext, EventContextFactory } from "../shared/event-context.factory";
import { outcomeEvents, toOutboxMessages } from "../wagering/wager-outcome-events.service";
import type { WagerPayloadHasher } from "../wagering/wager-transaction-payload.service";
import { toWalletView, type WalletView } from "./wallet.view";

export interface CreateWalletCommand extends CorrelationContext {
    playerId: string;
    initialBalance: MoneyProps;
}

export class CreateWalletUseCase {
    constructor(
        private readonly unitOfWork: UnitOfWork,
        private readonly payloadHasher: WagerPayloadHasher,
        private readonly ids: IdGenerator,
        private readonly clock: Clock,
        private readonly events: EventContextFactory,
        private readonly metrics: Metrics,
    ) {}

    async execute(command: CreateWalletCommand): Promise<WalletView> {
        const initialBalance = this.parseBalance(command.initialBalance);
        const playerId = command.playerId.toLowerCase();
        try {
            return await this.unitOfWork.run(async (repositories) => {
                const now = this.clock.now();
                const wallet = Wallet.open({ id: this.ids.next(), playerId, initialBalance, now });
                await repositories.wallets.insert(wallet);

                const opening = WagerTransaction.openingFor({
                    id: this.ids.next(),
                    walletId: wallet.id,
                    playerId,
                    money: initialBalance,
                    payloadHash: this.payloadHasher.hashValue({ walletId: wallet.id, playerId, initialBalance }),
                    now,
                });
                const entry = wallet.openingCredit({ entryId: this.ids.next(), transactionId: opening.id, now });
                if (entry) {
                    opening.markProcessed(undefined, wallet.balance, now);
                    await repositories.transactions.insert(opening);
                    await repositories.ledger.insert(entry);
                    await repositories.outbox.insert(
                        toOutboxMessages(outcomeEvents(opening, wallet, entry, () => this.events.create(command, now))),
                    );
                    this.metrics.transactionFinished(opening.kind, opening.status, "internal");
                }
                return toWalletView(wallet);
            });
        } catch (error) {
            if (error instanceof UniqueConstraintRaceError && error.constraint === "wallets_player_currency_uk") {
                throw new ConflictError(
                    "WALLET_ALREADY_EXISTS",
                    `Player ${playerId} already has a ${initialBalance.currency} wallet`,
                );
            }
            throw error;
        }
    }

    private parseBalance(props: MoneyProps): Money {
        try {
            return Money.from(props);
        } catch (error) {
            if (error instanceof DomainError) {
                throw new ValidationError(error.message);
            }
            throw error;
        }
    }
}
