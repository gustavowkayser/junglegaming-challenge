export enum WagerTransactionKind {
    Opening = "OPENING",
    Bet = "BET",
    Win = "WIN",
    Loss = "LOSS",
    Refund = "REFUND",
    Rollback = "ROLLBACK",
}

export const SUBMITTABLE_KINDS = [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
] as const;

export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

export const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
];

export function isReversal(kind: WagerTransactionKind): boolean {
    return REVERSAL_KINDS.includes(kind);
}
