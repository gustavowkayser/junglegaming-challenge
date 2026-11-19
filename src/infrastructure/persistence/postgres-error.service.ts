import {
    InvariantViolationError,
    TransientInfrastructureError,
    UniqueConstraintRaceError,
} from "../../application/errors/application.error";

interface DriverErrorShape {
    code?: unknown;
    sqlState?: unknown;
    constraint?: unknown;
    message?: unknown;
}

const CONNECTION_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "57P01",
    "57P02",
    "57P03",
]);

function sqlStateOf(error: DriverErrorShape): string | undefined {
    const candidate = error.sqlState ?? error.code;
    return typeof candidate === "string" ? candidate : undefined;
}

function constraintOf(error: DriverErrorShape): string | undefined {
    if (typeof error.constraint === "string") {
        return error.constraint;
    }
    const message = typeof error.message === "string" ? error.message : "";
    return /constraint "([^"]+)"/.exec(message)?.[1];
}

function isConnectionFailure(error: DriverErrorShape, sqlState: string | undefined): boolean {
    if (sqlState && (CONNECTION_CODES.has(sqlState) || sqlState.startsWith("08"))) {
        return true;
    }
    const message = typeof error.message === "string" ? error.message : "";
    return /connect|connection terminated|timeout exceeded when trying to connect|socket/i.test(message);
}

export function translatePostgresError(error: unknown): unknown {
    if (error === null || typeof error !== "object") {
        return error;
    }
    const shape = error as DriverErrorShape;
    const sqlState = sqlStateOf(shape);
    const options = { cause: error };
    switch (sqlState) {
        case "23505":
            return new UniqueConstraintRaceError(constraintOf(shape), options);
        case "55P03":
            return new TransientInfrastructureError("lock_timeout", "Timed out waiting for a row lock", 1, options);
        case "40P01":
            return new TransientInfrastructureError("deadlock", "Deadlock detected", 1, options);
        case "40001":
            return new TransientInfrastructureError("serialization", "Serialization failure", 1, options);
        case "57014":
            return new TransientInfrastructureError("statement_timeout", "Statement timed out", 2, options);
        case "P0001":
        case "23514":
        case "23503":
        case "23502":
            return new InvariantViolationError(`Database invariant violated: ${String(shape.message)}`, options);
    }
    if (isConnectionFailure(shape, sqlState)) {
        return new TransientInfrastructureError("connection", "Database is unavailable", 2, options);
    }
    return error;
}
