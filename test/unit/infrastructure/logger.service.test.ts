import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { AppLogger, createRootLogger } from "../../../src/infrastructure/observability/logger.service";
import { RequestContext } from "../../../src/infrastructure/observability/request-context.service";

function capture() {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            lines.push(JSON.parse(String(chunk)));
            callback();
        },
    });
    return { logger: new AppLogger(createRootLogger("info", stream)), lines };
}

describe("AppLogger", () => {
    test("writes structured JSON enriched with the request context", () => {
        const { logger, lines } = capture();
        RequestContext.run(
            { correlationId: "corr-1", messageId: "msg-1", walletId: "wallet-1", providerId: "provider-a" },
            () => {
                RequestContext.assign({ transactionId: "tx-1" });
                logger.log({ event: "wager.transaction_submitted", status: "PROCESSED" });
            },
        );

        expect(lines[0]).toMatchObject({
            level: "info",
            service: "wagering-processor",
            event: "wager.transaction_submitted",
            status: "PROCESSED",
            correlationId: "corr-1",
            messageId: "msg-1",
            transactionId: "tx-1",
            walletId: "wallet-1",
            providerId: "provider-a",
        });
        expect(typeof lines[0]?.time).toBe("string");
    });

    test("redacts financial values and payloads", () => {
        const { logger, lines } = capture();
        logger.log({
            event: "debug",
            money: { amount: "25.00", currency: "BRL" },
            balance: { amount: "975.00", currency: "BRL" },
            payload: { secret: true },
            nested: { initialBalance: { amount: "1.00" }, body: "raw" },
        });

        expect(lines[0]).toMatchObject({
            money: "[redacted]",
            balance: "[redacted]",
            payload: "[redacted]",
            nested: { initialBalance: "[redacted]", body: "[redacted]" },
        });
    });

    test("maps Nest log levels and string messages", () => {
        const { logger, lines } = capture();
        logger.warn("careful", "SomeComponent");
        logger.error(new Error("boom"));

        expect(lines[0]).toMatchObject({ level: "warn", message: "careful", component: "SomeComponent" });
        expect(lines[1]).toMatchObject({ level: "error", message: "boom" });
    });
});
