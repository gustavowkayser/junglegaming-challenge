import { TransientInfrastructureError, UniqueConstraintRaceError } from "../errors/application.error";
import type { LockConflictType, Metrics } from "../ports/metrics.port";

const RETRYABLE: ReadonlySet<LockConflictType> = new Set(["unique_race", "deadlock", "serialization", "version"]);

export function conflictTypeOf(error: unknown): LockConflictType | undefined {
    if (error instanceof UniqueConstraintRaceError) {
        return "unique_race";
    }
    if (error instanceof TransientInfrastructureError) {
        switch (error.reason) {
            case "lock_timeout":
                return "lock_timeout";
            case "deadlock":
                return "deadlock";
            case "serialization":
                return "serialization";
            case "version_conflict":
                return "version";
            default:
                return undefined;
        }
    }
    return undefined;
}

export async function withConflictRetry<T>(metrics: Metrics, maxAttempts: number, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await work();
        } catch (error) {
            const conflict = conflictTypeOf(error);
            if (conflict) {
                metrics.lockConflict(conflict);
            }
            if (conflict && RETRYABLE.has(conflict) && attempt < maxAttempts) {
                metrics.retryScheduled("use_case", conflict);
                continue;
            }
            throw error;
        }
    }
}
