export enum FailureCode {
    InsufficientFunds = "INSUFFICIENT_FUNDS",
    ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
    CurrencyMismatch = "CURRENCY_MISMATCH",
    WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
    ReferenceNotFound = "REFERENCE_NOT_FOUND",
    ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
    ReferenceMismatch = "REFERENCE_MISMATCH",
    ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
    ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
    ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
    ProcessingError = "PROCESSING_ERROR",
}

export type RejectionCode = Exclude<FailureCode, FailureCode.ProcessingError>;

export type PermanentFailureCode = FailureCode.ProcessingError;
