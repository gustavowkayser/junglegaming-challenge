export abstract class ApplicationError extends Error {
    abstract readonly code: string;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = new.target.name;
    }
}

export class ValidationError extends ApplicationError {
    constructor(
        message: string,
        readonly details?: unknown,
        readonly code: "VALIDATION_FAILED" | "IDEMPOTENCY_KEY_REQUIRED" = "VALIDATION_FAILED",
    ) {
        super(message);
    }
}

export class NotFoundError extends ApplicationError {
    constructor(
        readonly code: "WALLET_NOT_FOUND" | "TRANSACTION_NOT_FOUND",
        message: string,
    ) {
        super(message);
    }
}

export class ConflictError extends ApplicationError {
    constructor(
        readonly code: "WALLET_ALREADY_EXISTS",
        message: string,
    ) {
        super(message);
    }
}

export class IdempotencyConflictError extends ApplicationError {
    readonly code = "IDEMPOTENCY_KEY_CONFLICT";
}

export class UniqueConstraintRaceError extends ApplicationError {
    readonly code = "UNIQUE_CONSTRAINT_RACE";

    constructor(
        readonly constraint: string | undefined,
        options?: ErrorOptions,
    ) {
        super(`Unique constraint ${constraint ?? "unknown"} was violated by a concurrent writer`, options);
    }
}

export type TransientReason =
    | "lock_timeout"
    | "deadlock"
    | "serialization"
    | "statement_timeout"
    | "connection"
    | "version_conflict"
    | "broker";

export class TransientInfrastructureError extends ApplicationError {
    readonly code = "SERVICE_UNAVAILABLE";

    constructor(
        readonly reason: TransientReason,
        message: string,
        readonly retryAfterSeconds = 1,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

export class PermanentMessageError extends ApplicationError {
    constructor(
        readonly code: "INVALID_MESSAGE" | "INBOX_PAYLOAD_MISMATCH",
        message: string,
    ) {
        super(message);
    }
}

export class InvariantViolationError extends ApplicationError {
    readonly code = "INVARIANT_VIOLATION";
}
