export interface ErrorDescription {
    name: string;
    message: string;
    code?: string;
    reason?: string;
    stack?: string;
    cause?: ErrorDescription;
}

export function describeError(error: unknown, depth = 0): ErrorDescription | unknown {
    if (!(error instanceof Error)) {
        return error;
    }
    const extra = error as Error & { code?: unknown; reason?: unknown; cause?: unknown };
    const description: ErrorDescription = { name: error.name, message: error.message };
    if (typeof extra.code === "string") {
        description.code = extra.code;
    }
    if (typeof extra.reason === "string") {
        description.reason = extra.reason;
    }
    if (depth === 0 && error.stack) {
        description.stack = error.stack;
    }
    if (extra.cause !== undefined && depth < 3) {
        description.cause = describeError(extra.cause, depth + 1) as ErrorDescription;
    }
    return description;
}
