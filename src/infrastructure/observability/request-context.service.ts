import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContextValues {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContextValues>();

export const RequestContext = {
    run<T>(values: RequestContextValues, work: () => T): T {
        return storage.run({ ...storage.getStore(), ...values }, work);
    },

    current(): RequestContextValues {
        return storage.getStore() ?? {};
    },

    assign(values: RequestContextValues): void {
        const store = storage.getStore();
        if (store) {
            Object.assign(store, values);
        }
    },
};
