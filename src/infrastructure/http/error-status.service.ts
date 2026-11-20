import { HttpException, HttpStatus } from "@nestjs/common";
import {
    ApplicationError,
    ConflictError,
    IdempotencyConflictError,
    InvariantViolationError,
    NotFoundError,
    PermanentMessageError,
    TransientInfrastructureError,
    UniqueConstraintRaceError,
    ValidationError,
} from "../../application/errors/application.error";

export interface HttpErrorBody {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
}

export interface HttpErrorResponse {
    status: number;
    body: HttpErrorBody;
    headers: Record<string, string>;
}

export const TRANSACTION_STATUS_HTTP: Record<string, number> = {
    PROCESSED: HttpStatus.OK,
    PENDING_REFERENCE: HttpStatus.ACCEPTED,
    PENDING: HttpStatus.ACCEPTED,
    REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
    FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
};

function response(status: number, code: string, message: string, details?: unknown): HttpErrorResponse {
    return {
        status,
        body: { error: details === undefined ? { code, message } : { code, message, details } },
        headers: {},
    };
}

export function httpErrorFor(error: unknown): HttpErrorResponse {
    if (error instanceof ValidationError) {
        return response(HttpStatus.BAD_REQUEST, error.code, error.message, error.details);
    }
    if (error instanceof NotFoundError) {
        const status = error.referencedBy === "payload" ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.NOT_FOUND;
        return response(status, error.code, error.message);
    }
    if (error instanceof IdempotencyConflictError || error instanceof ConflictError) {
        return response(HttpStatus.CONFLICT, error.code, error.message);
    }
    if (error instanceof TransientInfrastructureError) {
        const result = response(HttpStatus.SERVICE_UNAVAILABLE, error.code, "Temporarily unavailable, retry later");
        result.headers["Retry-After"] = String(error.retryAfterSeconds);
        return result;
    }
    if (error instanceof UniqueConstraintRaceError) {
        const result = response(
            HttpStatus.SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "Concurrent update, retry later",
        );
        result.headers["Retry-After"] = "1";
        return result;
    }
    if (error instanceof PermanentMessageError) {
        return response(HttpStatus.BAD_REQUEST, error.code, error.message);
    }
    if (error instanceof InvariantViolationError) {
        return response(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal error");
    }
    if (error instanceof ApplicationError) {
        return response(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal error");
    }
    if (error instanceof HttpException) {
        const status = error.getStatus();
        const code =
            status === HttpStatus.NOT_FOUND
                ? "ROUTE_NOT_FOUND"
                : status === HttpStatus.BAD_REQUEST
                  ? "VALIDATION_FAILED"
                  : status < 500
                    ? "REQUEST_REJECTED"
                    : "INTERNAL_ERROR";
        return response(status, code, error.message);
    }
    return response(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Internal error");
}
