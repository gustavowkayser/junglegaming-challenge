import { expect } from "bun:test";

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    const outcome = await promise.then(
        () => ({ rejected: false as const }),
        (error: unknown) => ({ rejected: true as const, error }),
    );
    expect(outcome.rejected).toBe(true);
    return outcome.rejected ? outcome.error : undefined;
}
