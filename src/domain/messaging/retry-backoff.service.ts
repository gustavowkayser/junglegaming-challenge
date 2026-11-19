export interface BackoffSettings {
    baseDelayMs: number;
    maxDelayMs: number;
}

export function exponentialDelayMs(attempt: number, settings: BackoffSettings): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = settings.baseDelayMs * 2 ** Math.min(exponent, 30);
    return Math.min(settings.maxDelayMs, delay);
}

export function nextAttemptAt(now: Date, attempt: number, settings: BackoffSettings): Date {
    return new Date(now.getTime() + exponentialDelayMs(attempt, settings));
}
