import { InvalidMessageStateError } from "./messaging.error";

export interface ReceiveInboxProps {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    now: Date;
}

export interface InboxMessageState {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
    processedAt: Date | undefined;
}

export class InboxMessage {
    private constructor(
        readonly messageId: string,
        readonly consumerName: string,
        readonly payloadHash: string,
        readonly receivedAt: Date,
        private _processedAt: Date | undefined,
    ) {}

    static receive(props: ReceiveInboxProps): InboxMessage {
        if (props.messageId.trim().length === 0 || props.consumerName.trim().length === 0) {
            throw new InvalidMessageStateError("Inbox messages require a message id and a consumer name");
        }
        return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.now), undefined);
    }

    static rehydrate(state: InboxMessageState): InboxMessage {
        return new InboxMessage(
            state.messageId,
            state.consumerName,
            state.payloadHash,
            new Date(state.receivedAt),
            state.processedAt ? new Date(state.processedAt) : undefined,
        );
    }

    get processedAt(): Date | undefined {
        return this._processedAt;
    }

    isProcessed(): boolean {
        return this._processedAt !== undefined;
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    markProcessed(at: Date): void {
        if (this.isProcessed()) {
            throw new InvalidMessageStateError(`Inbox message ${this.messageId} is already processed`);
        }
        this._processedAt = new Date(at);
    }
}
