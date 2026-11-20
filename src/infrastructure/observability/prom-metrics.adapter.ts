import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type {
    LockConflictType,
    Metrics,
    RetryComponent,
    TransactionSource,
} from "../../application/ports/metrics.port";

export interface OutboxBacklog {
    count: number;
    oldestOccurredAt: Date | undefined;
}

export class PromMetrics implements Metrics {
    readonly registry = new Registry();

    private readonly transactions = new Counter({
        name: "wagering_transactions_total",
        help: "Wager transactions that reached a status, by kind, status and entry point",
        labelNames: ["kind", "status", "source"] as const,
        registers: [this.registry],
    });

    private readonly duplicates = new Counter({
        name: "wagering_duplicates_total",
        help: "Duplicate deliveries detected, by entry point and deduplication layer",
        labelNames: ["source", "layer"] as const,
        registers: [this.registry],
    });

    private readonly retries = new Counter({
        name: "wagering_retries_total",
        help: "Retries scheduled, by component and reason",
        labelNames: ["component", "reason"] as const,
        registers: [this.registry],
    });

    private readonly deadLetters = new Counter({
        name: "wagering_dlq_messages_total",
        help: "Messages moved to the dead letter queue, by reason",
        labelNames: ["reason"] as const,
        registers: [this.registry],
    });

    private readonly lockConflicts = new Counter({
        name: "wagering_lock_conflicts_total",
        help: "Concurrency conflicts observed while applying wallet changes",
        labelNames: ["type"] as const,
        registers: [this.registry],
    });

    private readonly processing = new Histogram({
        name: "wagering_processing_duration_seconds",
        help: "End-to-end processing latency of wager transactions",
        labelNames: ["source"] as const,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [this.registry],
    });

    private readonly reconciliations = new Counter({
        name: "wagering_reconciliations_total",
        help: "Wallet reconciliations, by outcome",
        labelNames: ["consistent"] as const,
        registers: [this.registry],
    });

    private readonly outboxPublishedTotal = new Counter({
        name: "wagering_outbox_published_total",
        help: "Outbox events published to the broker",
        registers: [this.registry],
    });

    constructor(outboxBacklog?: () => Promise<OutboxBacklog>) {
        collectDefaultMetrics({ register: this.registry });
        if (outboxBacklog) {
            this.registerOutboxGauges(outboxBacklog);
        }
    }

    transactionFinished(kind: string, status: string, source: TransactionSource): void {
        this.transactions.inc({ kind, status, source });
    }

    duplicateDetected(source: TransactionSource, layer: "inbox" | "idempotency"): void {
        this.duplicates.inc({ source, layer });
    }

    retryScheduled(component: RetryComponent, reason: string): void {
        this.retries.inc({ component, reason });
    }

    deadLettered(reason: string): void {
        this.deadLetters.inc({ reason });
    }

    lockConflict(type: LockConflictType): void {
        this.lockConflicts.inc({ type });
    }

    observeProcessing(source: TransactionSource, seconds: number): void {
        this.processing.observe({ source }, seconds);
    }

    reconciliationChecked(consistent: boolean): void {
        this.reconciliations.inc({ consistent: String(consistent) });
    }

    outboxPublished(count: number): void {
        if (count > 0) {
            this.outboxPublishedTotal.inc(count);
        }
    }

    private registerOutboxGauges(outboxBacklog: () => Promise<OutboxBacklog>): void {
        new Gauge({
            name: "wagering_outbox_pending",
            help: "Outbox events not yet published",
            registers: [this.registry],
            async collect() {
                this.set((await outboxBacklog()).count);
            },
        });
        new Gauge({
            name: "wagering_outbox_lag_seconds",
            help: "Age of the oldest unpublished outbox event",
            registers: [this.registry],
            async collect() {
                const oldest = (await outboxBacklog()).oldestOccurredAt;
                this.set(oldest ? Math.max(0, (Date.now() - oldest.getTime()) / 1000) : 0);
            },
        });
    }
}
