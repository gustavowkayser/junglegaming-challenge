import { type BackoffSettings, nextAttemptAt } from "../messaging/retry-backoff.service";

export interface ReferenceRetrySettings extends BackoffSettings {
    maxAttempts: number;
}

export class ReferenceRetryPolicy {
    constructor(private readonly settings: ReferenceRetrySettings) {}

    isExhausted(attempts: number): boolean {
        return attempts >= this.settings.maxAttempts;
    }

    nextAttemptAt(now: Date, attempt: number): Date {
        return nextAttemptAt(now, attempt, this.settings);
    }
}
