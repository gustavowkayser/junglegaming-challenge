export interface HttpResult<T = Record<string, unknown>> {
    status: number;
    body: T;
    headers: Headers;
}

export class HttpClient {
    constructor(readonly baseUrl: string) {}

    get<T = Record<string, unknown>>(path: string, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
        return this.request<T>("GET", path, undefined, headers);
    }

    post<T = Record<string, unknown>>(
        path: string,
        body: unknown,
        headers: Record<string, string> = {},
    ): Promise<HttpResult<T>> {
        return this.request<T>("POST", path, body, headers);
    }

    async request<T>(
        method: string,
        path: string,
        body: unknown,
        headers: Record<string, string>,
    ): Promise<HttpResult<T>> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
            parsed = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
            parsed = text;
        }
        return { status: response.status, body: parsed as T, headers: response.headers };
    }

    createWallet(initialAmount = "100.00", playerId: string = crypto.randomUUID(), currency = "BRL") {
        return this.post<{
            id: string;
            playerId: string;
            balance: { amount: string; currency: string };
            version: number;
        }>("/wallets", { playerId, initialBalance: { amount: initialAmount, currency } });
    }

    submit(payload: Record<string, unknown>, idempotencyKey?: string) {
        const key = idempotencyKey ?? `${String(payload.providerId)}:${String(payload.externalTransactionId)}`;
        return this.post<{
            transactionId: string;
            status: string;
            failureCode?: string;
            balance?: { amount: string; currency: string };
            idempotentReplay: boolean;
        }>("/wagering/transactions", payload, { "idempotency-key": key });
    }
}
