import { InboxMessage } from "../../domain/messaging/inbox-message.entity";
import { Money } from "../../domain/money/money.value-object";
import { DomainError } from "../../domain/shared/domain.error";
import type { WagerSettlementService } from "../../domain/wagering/wager-settlement.service";
import { WagerTransaction } from "../../domain/wagering/wager-transaction.aggregate";
import {
    IdempotencyConflictError,
    NotFoundError,
    PermanentMessageError,
    UniqueConstraintRaceError,
    ValidationError,
} from "../errors/application.error";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { Metrics } from "../ports/metrics.port";
import type { TransactionalRepositories, UnitOfWork } from "../ports/unit-of-work.port";
import type { EventContextFactory } from "../shared/event-context.factory";
import type { SubmitWagerTransactionCommand } from "./submit-wager-transaction.command";
import { outcomeEvents, toOutboxMessages } from "./wager-outcome-events.service";
import { toWagerTransactionResult, type WagerTransactionResult } from "./wager-transaction.view";
import type { WagerPayloadHasher } from "./wager-transaction-payload.service";

const MAX_ATTEMPTS = 2;

export class SubmitWagerTransactionUseCase {
    constructor(
        private readonly unitOfWork: UnitOfWork,
        private readonly settlement: WagerSettlementService,
        private readonly payloadHasher: WagerPayloadHasher,
        private readonly ids: IdGenerator,
        private readonly clock: Clock,
        private readonly events: EventContextFactory,
        private readonly metrics: Metrics,
    ) {}

    async execute(input: SubmitWagerTransactionCommand): Promise<WagerTransactionResult> {
        const startedAt = performance.now();
        const command = this.normalize(input);
        const payloadHash = this.hashOf(command);
        for (let attempt = 1; ; attempt += 1) {
            try {
                const result = await this.unitOfWork.run((repositories) =>
                    this.process(repositories, command, payloadHash),
                );
                this.metrics.observeProcessing(command.source, (performance.now() - startedAt) / 1000);
                if (!result.idempotentReplay) {
                    this.metrics.transactionFinished(command.kind, result.status, command.source);
                }
                return result;
            } catch (error) {
                if (error instanceof UniqueConstraintRaceError && attempt < MAX_ATTEMPTS) {
                    this.metrics.lockConflict("unique_race");
                    this.metrics.retryScheduled("use_case", "unique_race");
                    continue;
                }
                throw error;
            }
        }
    }

    private async process(
        repositories: TransactionalRepositories,
        command: SubmitWagerTransactionCommand,
        payloadHash: string,
    ): Promise<WagerTransactionResult> {
        const now = this.clock.now();
        const inbox = await this.receiveInbox(repositories, command, now);
        if (inbox === "already-processed") {
            const replay = await repositories.transactions.findByIdempotencyKey(command.idempotencyKey);
            if (replay) {
                this.metrics.duplicateDetected(command.source, "inbox");
                return this.replay(replay, payloadHash);
            }
        }

        const wallet = await repositories.wallets.findByIdForUpdate(command.walletId);
        if (!wallet) {
            throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${command.walletId} does not exist`);
        }

        const existing =
            (await repositories.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
            (await repositories.transactions.findByProviderExternalId(
                command.providerId,
                command.externalTransactionId,
            ));
        if (existing) {
            this.metrics.duplicateDetected(command.source, "idempotency");
            const result = this.replay(existing, payloadHash, command.idempotencyKey);
            await this.completeInbox(repositories, inbox, now);
            return result;
        }

        const transaction = this.createTransaction(command, payloadHash, now);
        const reference = transaction.referenceExternalTransactionId
            ? await repositories.transactions.findByProviderExternalId(
                  command.providerId,
                  transaction.referenceExternalTransactionId,
              )
            : undefined;
        const referenceAlreadyReversed =
            reference && transaction.requiresReference()
                ? await repositories.transactions.hasProcessedReversal(reference.id)
                : false;

        const outcome = this.settlement.settle({
            wallet,
            transaction,
            reference,
            referenceAlreadyReversed,
            entryId: this.ids.next(),
            now,
        });
        const entry = outcome.type === "processed" ? outcome.entry : undefined;

        await repositories.transactions.insert(transaction);
        if (entry) {
            await repositories.ledger.insert(entry);
            await repositories.wallets.update(wallet);
        }
        await repositories.outbox.insert(
            toOutboxMessages(outcomeEvents(transaction, wallet, entry, () => this.events.create(command, now))),
        );
        await this.completeInbox(repositories, inbox, now);
        return toWagerTransactionResult(transaction, false);
    }

    private replay(existing: WagerTransaction, payloadHash: string, idempotencyKey?: string): WagerTransactionResult {
        const sameKey = idempotencyKey === undefined || existing.idempotencyKey === idempotencyKey;
        if (!sameKey || !existing.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError(
                `Transaction ${existing.providerId}:${existing.externalTransactionId} was already submitted with a different payload or idempotency key`,
            );
        }
        return toWagerTransactionResult(existing, true);
    }

    private async receiveInbox(
        repositories: TransactionalRepositories,
        command: SubmitWagerTransactionCommand,
        now: Date,
    ): Promise<InboxMessage | "already-processed" | undefined> {
        if (!command.inbox) {
            return undefined;
        }
        const message = InboxMessage.receive({ ...command.inbox, now });
        if (await repositories.inbox.insertIfAbsent(message)) {
            return message;
        }
        const stored = await repositories.inbox.find(command.inbox.consumerName, command.inbox.messageId);
        if (!stored) {
            throw new UniqueConstraintRaceError("inbox_messages_pk");
        }
        if (!stored.matchesPayload(command.inbox.payloadHash)) {
            throw new PermanentMessageError(
                "INBOX_PAYLOAD_MISMATCH",
                `Message ${command.inbox.messageId} was redelivered with a different payload`,
            );
        }
        return stored.isProcessed() ? "already-processed" : stored;
    }

    private async completeInbox(
        repositories: TransactionalRepositories,
        inbox: InboxMessage | "already-processed" | undefined,
        now: Date,
    ): Promise<void> {
        if (inbox instanceof InboxMessage && !inbox.isProcessed()) {
            inbox.markProcessed(now);
            await repositories.inbox.update(inbox);
        }
    }

    private createTransaction(command: SubmitWagerTransactionCommand, payloadHash: string, now: Date) {
        return this.asValidation(() =>
            WagerTransaction.create({
                id: this.ids.next(),
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                idempotencyKey: command.idempotencyKey,
                payloadHash,
                walletId: command.walletId,
                playerId: command.playerId,
                roundId: command.roundId,
                gameId: command.gameId,
                kind: command.kind,
                money: Money.from(command.money),
                referenceExternalTransactionId: command.referenceExternalTransactionId,
                now,
            }),
        );
    }

    private hashOf(command: SubmitWagerTransactionCommand): string {
        return this.asValidation(() => this.payloadHasher.hashBusinessFields(command));
    }

    private normalize(command: SubmitWagerTransactionCommand): SubmitWagerTransactionCommand {
        return { ...command, walletId: command.walletId.toLowerCase(), playerId: command.playerId.toLowerCase() };
    }

    private asValidation<T>(build: () => T): T {
        try {
            return build();
        } catch (error) {
            if (error instanceof DomainError) {
                throw new ValidationError(error.message);
            }
            throw error;
        }
    }
}
