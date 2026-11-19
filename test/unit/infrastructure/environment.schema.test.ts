import { describe, expect, test } from "bun:test";
import { parseEnvironment } from "../../../src/infrastructure/config/environment.schema";

describe("parseEnvironment", () => {
    test("applies defaults", () => {
        const environment = parseEnvironment({});

        expect(environment.PORT).toBe(3000);
        expect(environment.SQS_WAGER_QUEUE_NAME).toBe("wager-transactions.fifo");
        expect(environment.SQS_WAGER_DLQ_NAME).toBe("wager-transactions-dlq.fifo");
        expect(environment.SQS_EVENTS_QUEUE_NAME).toBe("wagering-events.fifo");
        expect(environment.HTTP_ENABLED).toBe(true);
        expect(environment.PENDING_REFERENCE_MAX_ATTEMPTS).toBe(10);
        expect(environment.FAULT_INJECTION).toBe("none");
    });

    test("parses boolean flags", () => {
        const environment = parseEnvironment({ HTTP_ENABLED: "false", SQS_CONSUMER_ENABLED: "true" });

        expect(environment.HTTP_ENABLED).toBe(false);
        expect(environment.SQS_CONSUMER_ENABLED).toBe(true);
    });

    test("coerces numeric values", () => {
        expect(parseEnvironment({ PORT: "8080" }).PORT).toBe(8080);
    });

    test("rejects invalid numbers", () => {
        expect(() => parseEnvironment({ PORT: "abc" })).toThrow();
    });

    test("rejects invalid booleans", () => {
        expect(() => parseEnvironment({ HTTP_ENABLED: "yes" })).toThrow();
    });

    test("rejects unknown fault injection points", () => {
        expect(() => parseEnvironment({ FAULT_INJECTION: "explode" })).toThrow();
    });
});
