import type {
    LockConflictType,
    Metrics,
    RetryComponent,
    TransactionSource,
} from "../../application/ports/metrics.port";

export class NoopMetrics implements Metrics {
    transactionFinished(_kind: string, _status: string, _source: TransactionSource): void {}
    duplicateDetected(_source: TransactionSource, _layer: "inbox" | "idempotency"): void {}
    retryScheduled(_component: RetryComponent, _reason: string): void {}
    deadLettered(_reason: string): void {}
    lockConflict(_type: LockConflictType): void {}
    observeProcessing(_source: TransactionSource, _seconds: number): void {}
    reconciliationChecked(_consistent: boolean): void {}
    outboxPublished(_count: number): void {}
}
