import { LedgerDirection } from "../wallet/ledger-direction.enum";
import { FailureCode, type RejectionCode } from "./failure-code.enum";
import type { ReferenceRetryPolicy } from "./reference-retry-policy.service";
import type { SettlementInput, SettlementOutcome } from "./wager-settlement.types";
import type { WagerTransaction } from "./wager-transaction.aggregate";
import { WagerTransactionKind } from "./wager-transaction-kind.enum";
import { WagerTransactionStatus } from "./wager-transaction-status.enum";

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
    [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export class WagerSettlementService {
    constructor(private readonly referenceRetryPolicy: ReferenceRetryPolicy) {}

    settle(input: SettlementInput): SettlementOutcome {
        const { wallet, transaction, reference, now } = input;

        if (transaction.playerId !== wallet.playerId || transaction.walletId !== wallet.id) {
            return this.reject(input, FailureCode.WalletPlayerMismatch);
        }
        if (!transaction.money.hasCurrency(wallet.currency)) {
            return this.reject(input, FailureCode.CurrencyMismatch);
        }

        if (transaction.hasReference()) {
            if (!reference?.isTerminal()) {
                return this.awaitReference(input);
            }
            const referenceRejection = this.validateReference(transaction, reference, input.referenceAlreadyReversed);
            if (referenceRejection) {
                return this.reject(input, referenceRejection);
            }
        }

        if (!transaction.affectsBalance()) {
            transaction.markProcessed(reference?.id, wallet.balance, now);
            return { type: "processed", entry: undefined };
        }

        const direction = transaction.ledgerDirectionFor(reference);
        if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
            const code =
                transaction.kind === WagerTransactionKind.Bet
                    ? FailureCode.InsufficientFunds
                    : FailureCode.ReversalInsufficientFunds;
            return this.reject(input, code);
        }

        const movement = { entryId: input.entryId, transactionId: transaction.id, money: transaction.money, now };
        const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        transaction.markProcessed(reference?.id, wallet.balance, now);
        return { type: "processed", entry };
    }

    private validateReference(
        transaction: WagerTransaction,
        reference: WagerTransaction,
        referenceAlreadyReversed: boolean,
    ): RejectionCode | undefined {
        const sameContext =
            reference.providerId === transaction.providerId &&
            reference.playerId === transaction.playerId &&
            reference.walletId === transaction.walletId &&
            reference.roundId === transaction.roundId &&
            reference.money.currency === transaction.money.currency;
        if (!sameContext) {
            return FailureCode.ReferenceMismatch;
        }
        if (reference.status !== WagerTransactionStatus.Processed) {
            return FailureCode.ReferenceNotProcessed;
        }
        const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
        if (!allowedKinds.includes(reference.kind)) {
            return FailureCode.ReferenceKindNotAllowed;
        }
        if (!transaction.requiresReference()) {
            return undefined;
        }
        if (!reference.money.equals(transaction.money)) {
            return FailureCode.ReferenceAmountMismatch;
        }
        if (referenceAlreadyReversed) {
            return FailureCode.ReferenceAlreadyReversed;
        }
        return undefined;
    }

    private awaitReference(input: SettlementInput): SettlementOutcome {
        const { transaction, reference, wallet, now } = input;
        if (this.referenceRetryPolicy.isExhausted(transaction.referenceAttempts)) {
            return this.reject(input, reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
        }
        const attempt = transaction.referenceAttempts + 1;
        transaction.markPendingReference(wallet.balance, this.referenceRetryPolicy.nextAttemptAt(now, attempt), now);
        return { type: "pending-reference" };
    }

    private reject(input: SettlementInput, code: RejectionCode): SettlementOutcome {
        const referenceId = input.reference?.isTerminal() ? input.reference.id : undefined;
        input.transaction.reject(code, input.wallet.balance, input.now, referenceId);
        return { type: "rejected", code };
    }
}
