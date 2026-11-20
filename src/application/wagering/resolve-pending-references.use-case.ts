import { FailureCode } from "../../domain/wagering/failure-code.enum";
import type { WagerSettlementService } from "../../domain/wagering/wager-settlement.service";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction.aggregate";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status.enum";
import { TransientInfrastructureError, UniqueConstraintRaceError } from "../errors/application.error";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";
import type { Metrics } from "../ports/metrics.port";
import type { TransactionalRepositories, UnitOfWork } from "../ports/unit-of-work.port";
import { withConflictRetry } from "../shared/conflict-retry.service";
import type { CorrelationContext, EventContextFactory } from "../shared/event-context.factory";
import { outcomeEvents, toOutboxMessages } from "./wager-outcome-events.service";

export type ResolutionOutcome = "processed" | "rejected" | "rescheduled" | "failed" | "skipped" | "deferred";

export interface ResolutionReport {
    transactionId: string;
    outcome: ResolutionOutcome;
    failureCode?: string;
}

export interface ResolutionObserver {
    resolved(report: ResolutionReport): void;
    failed(transactionId: string, error: unknown): void;
}

const MAX_CONFLICT_ATTEMPTS = 3;

export class ResolvePendingReferencesUseCase {
    constructor(
        private readonly unitOfWork: UnitOfWork,
        private readonly settlement: WagerSettlementService,
        private readonly ids: IdGenerator,
        private readonly clock: Clock,
        private readonly events: EventContextFactory,
        private readonly metrics: Metrics,
        private readonly batchSize: number,
    ) {}

    async execute(observer?: ResolutionObserver): Promise<ResolutionReport[]> {
        const due = await this.unitOfWork.run((repositories) =>
            repositories.transactions.findDuePendingReferenceIds(this.clock.now(), this.batchSize),
        );
        const reports: ResolutionReport[] = [];
        for (const transactionId of due) {
            const report = await this.resolveOne(transactionId, observer);
            reports.push(report);
            observer?.resolved(report);
        }
        return reports;
    }

    private async resolveOne(transactionId: string, observer?: ResolutionObserver): Promise<ResolutionReport> {
        try {
            return await withConflictRetry(this.metrics, MAX_CONFLICT_ATTEMPTS, () =>
                this.unitOfWork.run((repositories) => this.resolve(repositories, transactionId)),
            );
        } catch (error) {
            if (error instanceof TransientInfrastructureError || error instanceof UniqueConstraintRaceError) {
                this.metrics.retryScheduled("pending_reference", "transient");
                return { transactionId, outcome: "deferred" };
            }
            observer?.failed(transactionId, error);
            return this.markFailed(transactionId);
        }
    }

    private async resolve(repositories: TransactionalRepositories, transactionId: string): Promise<ResolutionReport> {
        const candidate = await repositories.transactions.findById(transactionId);
        if (candidate?.status !== WagerTransactionStatus.PendingReference) {
            return { transactionId, outcome: "skipped" };
        }
        const wallet = await repositories.wallets.findByIdForUpdate(candidate.walletId);
        const transaction = await repositories.transactions.findById(transactionId);
        const now = this.clock.now();
        if (!wallet || !transaction || !this.isDue(transaction, now)) {
            return { transactionId, outcome: "skipped" };
        }

        const reference = transaction.referenceExternalTransactionId
            ? await repositories.transactions.findByProviderExternalId(
                  transaction.providerId,
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

        await repositories.transactions.update(transaction);
        if (entry) {
            await repositories.ledger.insert(entry);
            await repositories.wallets.update(wallet);
        }
        if (outcome.type === "pending-reference") {
            return { transactionId, outcome: "rescheduled" };
        }
        await repositories.outbox.insert(
            toOutboxMessages(
                outcomeEvents(transaction, wallet, entry, () =>
                    this.events.create(this.correlationOf(transaction), now),
                ),
            ),
        );
        await repositories.transactions.expeditePendingDependents(
            transaction.providerId,
            transaction.externalTransactionId,
            now,
        );
        this.metrics.transactionFinished(transaction.kind, transaction.status, "worker");
        return outcome.type === "processed"
            ? { transactionId, outcome: "processed" }
            : { transactionId, outcome: "rejected", failureCode: outcome.code };
    }

    private async markFailed(transactionId: string): Promise<ResolutionReport> {
        return this.unitOfWork.run(async (repositories) => {
            const candidate = await repositories.transactions.findById(transactionId);
            if (candidate?.status !== WagerTransactionStatus.PendingReference) {
                return { transactionId, outcome: "skipped" as const };
            }
            const wallet = await repositories.wallets.findByIdForUpdate(candidate.walletId);
            const transaction = await repositories.transactions.findById(transactionId);
            if (!wallet || transaction?.status !== WagerTransactionStatus.PendingReference) {
                return { transactionId, outcome: "skipped" as const };
            }
            const now = this.clock.now();
            transaction.fail(FailureCode.ProcessingError, now);
            await repositories.transactions.update(transaction);
            await repositories.outbox.insert(
                toOutboxMessages(
                    outcomeEvents(transaction, wallet, undefined, () =>
                        this.events.create(this.correlationOf(transaction), now),
                    ),
                ),
            );
            this.metrics.transactionFinished(transaction.kind, transaction.status, "worker");
            return { transactionId, outcome: "failed" as const, failureCode: FailureCode.ProcessingError };
        });
    }

    private isDue(transaction: WagerTransaction, now: Date): boolean {
        return (
            transaction.status === WagerTransactionStatus.PendingReference &&
            (transaction.nextReferenceAttemptAt?.getTime() ?? 0) <= now.getTime()
        );
    }

    private correlationOf(transaction: WagerTransaction): CorrelationContext {
        return { correlationId: `transaction:${transaction.id}`, causationId: transaction.id };
    }
}
