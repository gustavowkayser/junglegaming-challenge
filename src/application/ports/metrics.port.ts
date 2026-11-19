export type TransactionSource = "http" | "sqs" | "worker" | "internal";

export type LockConflictType = "lock_timeout" | "deadlock" | "serialization" | "version" | "unique_race";

export type RetryComponent = "sqs" | "outbox" | "pending_reference" | "use_case";

export interface Metrics {
    transactionFinished(kind: string, status: string, source: TransactionSource): void;
    duplicateDetected(source: TransactionSource, layer: "inbox" | "idempotency"): void;
    retryScheduled(component: RetryComponent, reason: string): void;
    deadLettered(reason: string): void;
    lockConflict(type: LockConflictType): void;
    observeProcessing(source: TransactionSource, seconds: number): void;
    reconciliationChecked(consistent: boolean): void;
    outboxPublished(count: number): void;
}

export const METRICS = Symbol("Metrics");
