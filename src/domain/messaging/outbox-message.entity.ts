import type { IntegrationEvent } from "../events/integration-event.base";
import { deepFreeze } from "../shared/deep-freeze.service";
import { InvalidMessageStateError } from "./messaging.error";
import { type BackoffSettings, nextAttemptAt } from "./retry-backoff.service";

export const OUTBOX_RETRY_BACKOFF: BackoffSettings = { baseDelayMs: 1000, maxDelayMs: 60_000 };

const MAX_ERROR_LENGTH = 500;

export interface OutboxMessageState {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt: Date | undefined;
    publishedAt: Date | undefined;
    lastError: string | undefined;
}

export class OutboxMessage {
    private constructor(
        readonly id: string,
        readonly aggregateId: string,
        readonly eventType: string,
        readonly payload: Readonly<Record<string, unknown>>,
        readonly occurredAt: Date,
        private _attempts: number,
        private _nextAttemptAt: Date | undefined,
        private _publishedAt: Date | undefined,
        private _lastError: string | undefined,
    ) {}

    static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
        const envelope = event.toJSON() as unknown as Record<string, unknown>;
        return new OutboxMessage(
            event.eventId,
            event.aggregateId,
            event.eventType,
            deepFreeze(envelope),
            new Date(event.occurredAt),
            0,
            new Date(event.occurredAt),
            undefined,
            undefined,
        );
    }

    static rehydrate(state: OutboxMessageState): OutboxMessage {
        return new OutboxMessage(
            state.id,
            state.aggregateId,
            state.eventType,
            deepFreeze(state.payload),
            new Date(state.occurredAt),
            state.attempts,
            state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
            state.publishedAt ? new Date(state.publishedAt) : undefined,
            state.lastError,
        );
    }

    get attempts(): number {
        return this._attempts;
    }

    get nextAttemptAt(): Date | undefined {
        return this._nextAttemptAt;
    }

    get publishedAt(): Date | undefined {
        return this._publishedAt;
    }

    get lastError(): string | undefined {
        return this._lastError;
    }

    isPending(): boolean {
        return this._publishedAt === undefined;
    }

    isDue(now: Date): boolean {
        return (
            this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
        );
    }

    markPublished(at: Date): void {
        if (!this.isPending()) {
            throw new InvalidMessageStateError(`Outbox message ${this.id} is already published`);
        }
        this._attempts += 1;
        this._publishedAt = new Date(at);
        this._nextAttemptAt = undefined;
    }

    scheduleRetry(now: Date, error?: string): void {
        if (!this.isPending()) {
            throw new InvalidMessageStateError(`Outbox message ${this.id} is already published`);
        }
        this._attempts += 1;
        this._nextAttemptAt = nextAttemptAt(now, this._attempts, OUTBOX_RETRY_BACKOFF);
        if (error !== undefined) {
            this._lastError = error.slice(0, MAX_ERROR_LENGTH);
        }
    }
}
