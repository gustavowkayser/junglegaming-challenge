import { DomainError } from "../shared/domain.error";

export class InvalidTransactionStateError extends DomainError {
    readonly code = "INVALID_TRANSACTION_STATE";
}

export class InvalidWagerTransactionError extends DomainError {
    readonly code = "INVALID_WAGER_TRANSACTION";
}

export class MissingReferenceError extends DomainError {
    readonly code = "MISSING_REFERENCE";
}
