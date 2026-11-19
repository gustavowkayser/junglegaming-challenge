import { describe, expect, test } from "bun:test";
import { exponentialDelayMs, nextAttemptAt } from "../../../src/domain/messaging/retry-backoff.service";
import { ReferenceRetryPolicy } from "../../../src/domain/wagering/reference-retry-policy.service";

describe("exponentialDelayMs", () => {
    const settings = { baseDelayMs: 1000, maxDelayMs: 300_000 };

    test("doubles per attempt starting at the base delay", () => {
        expect([1, 2, 3, 4, 5].map((attempt) => exponentialDelayMs(attempt, settings))).toEqual([
            1000, 2000, 4000, 8000, 16000,
        ]);
    });

    test("caps at the maximum delay", () => {
        expect(exponentialDelayMs(9, settings)).toBe(256_000);
        expect(exponentialDelayMs(10, settings)).toBe(300_000);
        expect(exponentialDelayMs(500, settings)).toBe(300_000);
    });

    test("treats attempts below one as the first attempt", () => {
        expect(exponentialDelayMs(0, settings)).toBe(1000);
    });

    test("nextAttemptAt offsets from now", () => {
        const now = new Date("2026-01-01T00:00:00.000Z");

        expect(nextAttemptAt(now, 3, settings).toISOString()).toBe("2026-01-01T00:00:04.000Z");
    });
});

describe("ReferenceRetryPolicy", () => {
    const policy = new ReferenceRetryPolicy({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1000 });

    test("is exhausted once attempts reach the limit", () => {
        expect(policy.isExhausted(0)).toBe(false);
        expect(policy.isExhausted(2)).toBe(false);
        expect(policy.isExhausted(3)).toBe(true);
    });

    test("schedules with exponential backoff", () => {
        const now = new Date(0);

        expect(policy.nextAttemptAt(now, 1).getTime()).toBe(50);
        expect(policy.nextAttemptAt(now, 2).getTime()).toBe(100);
        expect(policy.nextAttemptAt(now, 3).getTime()).toBe(200);
    });
});
