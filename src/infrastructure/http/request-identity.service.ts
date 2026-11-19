import { NotFoundError } from "../../application/errors/application.error";
import { RequestContext } from "../observability/request-context.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string, code: "WALLET_NOT_FOUND" | "TRANSACTION_NOT_FOUND"): string {
    if (!UUID.test(value)) {
        throw new NotFoundError(code, `Resource ${value} does not exist`);
    }
    return value.toLowerCase();
}

export function currentCorrelationId(): string {
    return RequestContext.current().correlationId ?? "unknown";
}
