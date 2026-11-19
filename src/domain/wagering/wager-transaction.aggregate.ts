import type { Money } from "../money/money.value-object";
import { LedgerDirection, oppositeDirection } from "../wallet/ledger-direction.enum";
import type { FailureCode, PermanentFailureCode, RejectionCode } from "./failure-code.enum";
import {
    InvalidTransactionStateError,
    InvalidWagerTransactionError,
    MissingReferenceError,
} from "./wager-transaction.error";
import type {
    CreateWagerTransactionProps,
    OpeningTransactionProps,
    WagerTransactionState,
} from "./wager-transaction.types";
import { isReversal, WagerTransactionKind } from "./wager-transaction-kind.enum";
import { TERMINAL_STATUSES, WagerTransactionStatus } from "./wager-transaction-status.enum";

export const INTERNAL_PROVIDER_ID = "internal";

export class WagerTransaction {
    private constructor(
        readonly id: string,
        readonly providerId: string,
        readonly externalTransactionId: string,
        readonly idempotencyKey: string,
        readonly payloadHash: string,
        readonly walletId: string,
        readonly playerId: string,
        readonly roundId: string,
        readonly gameId: string,
        readonly kind: WagerTransactionKind,
        readonly money: Money,
        readonly referenceExternalTransactionId: string | undefined,
        readonly createdAt: Date,
        private _updatedAt: Date,
        private _status: WagerTransactionStatus,
        private _referenceTransactionId: string | undefined,
        private _failureCode: FailureCode | undefined,
        private _processedAt: Date | undefined,
        private _resultBalance: Money | undefined,
        private _referenceAttempts: number,
        private _nextReferenceAttemptAt: Date | undefined,
    ) {}

    static create(props: CreateWagerTransactionProps): WagerTransaction {
        const kind = props.kind as WagerTransactionKind;
        if (kind === WagerTransactionKind.Opening) {
            throw new InvalidWagerTransactionError("OPENING transactions are internal and cannot be submitted");
        }
        for (const [field, value] of Object.entries({
            id: props.id,
            providerId: props.providerId,
            externalTransactionId: props.externalTransactionId,
            idempotencyKey: props.idempotencyKey,
            payloadHash: props.payloadHash,
            walletId: props.walletId,
            playerId: props.playerId,
            roundId: props.roundId,
            gameId: props.gameId,
        })) {
            if (value.trim().length === 0) {
                throw new InvalidWagerTransactionError(`${field} must not be blank`);
            }
        }
        const reference = props.referenceExternalTransactionId;
        const hasReference = reference !== undefined;
        if (isReversal(kind) && (!hasReference || reference.trim().length === 0)) {
            throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
        }
        if ((kind === WagerTransactionKind.Bet || kind === WagerTransactionKind.Loss) && hasReference) {
            throw new InvalidWagerTransactionError(`${kind} does not accept a reference`);
        }
        if (props.money.isNegative()) {
            throw new InvalidWagerTransactionError("Amount must not be negative");
        }
        if (kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
            throw new InvalidWagerTransactionError(`${kind} requires a positive amount`);
        }
        return WagerTransaction.pending({
            ...props,
            kind,
            referenceExternalTransactionId: hasReference ? reference : undefined,
        });
    }

    static openingFor(props: OpeningTransactionProps): WagerTransaction {
        return WagerTransaction.pending({
            id: props.id,
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `opening:${props.walletId}`,
            idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
            payloadHash: props.payloadHash,
            walletId: props.walletId,
            playerId: props.playerId,
            roundId: "opening",
            gameId: "opening",
            kind: WagerTransactionKind.Opening,
            money: props.money,
            referenceExternalTransactionId: undefined,
            now: props.now,
        });
    }

    static rehydrate(state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(
            state.id,
            state.providerId,
            state.externalTransactionId,
            state.idempotencyKey,
            state.payloadHash,
            state.walletId,
            state.playerId,
            state.roundId,
            state.gameId,
            state.kind,
            state.money,
            state.referenceExternalTransactionId,
            new Date(state.createdAt),
            new Date(state.updatedAt),
            state.status,
            state.referenceTransactionId,
            state.failureCode,
            state.processedAt ? new Date(state.processedAt) : undefined,
            state.resultBalance,
            state.referenceAttempts,
            state.nextReferenceAttemptAt ? new Date(state.nextReferenceAttemptAt) : undefined,
        );
    }

    private static pending(
        props: Omit<CreateWagerTransactionProps, "kind"> & {
            kind: WagerTransactionKind;
            referenceExternalTransactionId: string | undefined;
        },
    ): WagerTransaction {
        return new WagerTransaction(
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
            props.kind,
            props.money,
            props.referenceExternalTransactionId,
            new Date(props.now),
            new Date(props.now),
            WagerTransactionStatus.Pending,
            undefined,
            undefined,
            undefined,
            undefined,
            0,
            undefined,
        );
    }

    get status(): WagerTransactionStatus {
        return this._status;
    }

    get referenceTransactionId(): string | undefined {
        return this._referenceTransactionId;
    }

    get failureCode(): FailureCode | undefined {
        return this._failureCode;
    }

    get processedAt(): Date | undefined {
        return this._processedAt;
    }

    get resultBalance(): Money | undefined {
        return this._resultBalance;
    }

    get referenceAttempts(): number {
        return this._referenceAttempts;
    }

    get nextReferenceAttemptAt(): Date | undefined {
        return this._nextReferenceAttemptAt;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }

    markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
        this.assertNotTerminal("markProcessed");
        this._status = WagerTransactionStatus.Processed;
        this._referenceTransactionId = referenceTransactionId;
        this.settle(resultBalance, at);
    }

    markPendingReference(resultBalance: Money, nextAttemptAt: Date, at: Date): void {
        this.assertNotTerminal("markPendingReference");
        if (!this.hasReference()) {
            throw new InvalidTransactionStateError(`${this.kind} without a reference cannot wait for one`);
        }
        this._status = WagerTransactionStatus.PendingReference;
        this._referenceAttempts += 1;
        this._nextReferenceAttemptAt = new Date(nextAttemptAt);
        this._resultBalance = resultBalance;
        this._updatedAt = new Date(at);
    }

    reject(code: RejectionCode, resultBalance: Money, at: Date, referenceTransactionId?: string): void {
        this.assertNotTerminal("reject");
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
        this._referenceTransactionId = referenceTransactionId;
        this.settle(resultBalance, at);
    }

    fail(code: PermanentFailureCode, at: Date): void {
        this.assertNotTerminal("fail");
        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
        this._processedAt = new Date(at);
        this._nextReferenceAttemptAt = undefined;
        this._updatedAt = new Date(at);
    }

    isTerminal(): boolean {
        return TERMINAL_STATUSES.includes(this._status);
    }

    isProcessed(): boolean {
        return this._status === WagerTransactionStatus.Processed;
    }

    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    requiresReference(): boolean {
        return isReversal(this.kind);
    }

    hasReference(): boolean {
        return this.referenceExternalTransactionId !== undefined;
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
        switch (this.kind) {
            case WagerTransactionKind.Bet:
                return LedgerDirection.Debit;
            case WagerTransactionKind.Opening:
            case WagerTransactionKind.Win:
            case WagerTransactionKind.Refund:
                return LedgerDirection.Credit;
            case WagerTransactionKind.Rollback:
                if (!reference) {
                    throw new MissingReferenceError("ROLLBACK direction depends on the referenced transaction");
                }
                return oppositeDirection(reference.ledgerDirectionFor());
            case WagerTransactionKind.Loss:
                throw new InvalidWagerTransactionError("LOSS does not move balance");
        }
    }

    toState(): WagerTransactionState {
        return {
            id: this.id,
            providerId: this.providerId,
            externalTransactionId: this.externalTransactionId,
            idempotencyKey: this.idempotencyKey,
            payloadHash: this.payloadHash,
            walletId: this.walletId,
            playerId: this.playerId,
            roundId: this.roundId,
            gameId: this.gameId,
            kind: this.kind,
            money: this.money,
            referenceExternalTransactionId: this.referenceExternalTransactionId,
            createdAt: this.createdAt,
            updatedAt: this._updatedAt,
            status: this._status,
            referenceTransactionId: this._referenceTransactionId,
            failureCode: this._failureCode,
            processedAt: this._processedAt,
            resultBalance: this._resultBalance,
            referenceAttempts: this._referenceAttempts,
            nextReferenceAttemptAt: this._nextReferenceAttemptAt,
        };
    }

    private settle(resultBalance: Money, at: Date): void {
        this._resultBalance = resultBalance;
        this._processedAt = new Date(at);
        this._nextReferenceAttemptAt = undefined;
        this._updatedAt = new Date(at);
    }

    private assertNotTerminal(transition: string): void {
        if (this.isTerminal()) {
            throw new InvalidTransactionStateError(
                `Cannot ${transition} transaction ${this.id}: status ${this._status} is terminal`,
            );
        }
    }
}
