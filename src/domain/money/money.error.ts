import { DomainError } from "../shared/domain.error";

export class InvalidMoneyError extends DomainError {
    readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
    readonly code = "CURRENCY_MISMATCH";

    constructor(
        readonly expected: string,
        readonly actual: string,
    ) {
        super(`Currency mismatch: expected ${expected}, received ${actual}`);
    }
}
