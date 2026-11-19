import type { Metrics } from "../../application/ports/metrics.port";

export class NoopMetrics implements Metrics {
    transactionFinished(): void {}
    duplicateDetected(): void {}
    retryScheduled(): void {}
    deadLettered(): void {}
    lockConflict(): void {}
    observeProcessing(): void {}
    reconciliationChecked(): void {}
    outboxPublished(): void {}
}
