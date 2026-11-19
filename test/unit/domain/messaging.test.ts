import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed.event";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message.entity";
import { InvalidMessageStateError } from "../../../src/domain/messaging/messaging.error";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message.entity";
import { Money } from "../../../src/domain/money/money.value-object";
import { Wallet } from "../../../src/domain/wallet/wallet.aggregate";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("InboxMessage", () => {
    const receive = () =>
        InboxMessage.receive({ messageId: "msg-1", consumerName: "consumer", payloadHash: "hash", now });

    test("starts unprocessed", () => {
        const message = receive();

        expect(message.isProcessed()).toBe(false);
        expect(message.processedAt).toBeUndefined();
        expect(message.receivedAt).toEqual(now);
    });

    test("can be processed exactly once", () => {
        const message = receive();
        message.markProcessed(now);

        expect(message.isProcessed()).toBe(true);
        expect(() => message.markProcessed(now)).toThrow(InvalidMessageStateError);
    });

    test("compares payload hashes", () => {
        expect(receive().matchesPayload("hash")).toBe(true);
        expect(receive().matchesPayload("other")).toBe(false);
    });

    test("requires identifiers", () => {
        expect(() => InboxMessage.receive({ messageId: "", consumerName: "c", payloadHash: "h", now })).toThrow(
            InvalidMessageStateError,
        );
    });

    test("rehydrates processed state", () => {
        const message = InboxMessage.rehydrate({
            messageId: "msg-1",
            consumerName: "consumer",
            payloadHash: "hash",
            receivedAt: now,
            processedAt: now,
        });

        expect(message.isProcessed()).toBe(true);
    });
});

describe("OutboxMessage", () => {
    const event = () => {
        const wallet = Wallet.open({
            id: "wallet-1",
            playerId: "player-1",
            initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
            now,
        });
        const entry = wallet.credit({
            entryId: "entry-1",
            transactionId: "tx-1",
            money: Money.from({ amount: "5.00", currency: "BRL" }),
            now,
        });
        return WalletBalanceChanged.from(wallet, entry, {
            eventId: "event-1",
            correlationId: "corr-1",
            occurredAt: now,
        });
    };

    test("enqueue stores the serialized envelope and is immediately due", () => {
        const message = OutboxMessage.enqueue(event());

        expect(message.id).toBe("event-1");
        expect(message.aggregateId).toBe("wallet-1");
        expect(message.eventType).toBe("WalletBalanceChanged");
        expect(message.payload.eventType).toBe("WalletBalanceChanged");
        expect(message.payload.occurredAt).toBe("2026-01-01T00:00:00.000Z");
        expect(message.attempts).toBe(0);
        expect(message.isPending()).toBe(true);
        expect(message.isDue(now)).toBe(true);
        expect(Object.isFrozen(message.payload)).toBe(true);
    });

    test("markPublished is final", () => {
        const message = OutboxMessage.enqueue(event());
        message.markPublished(now);

        expect(message.isPending()).toBe(false);
        expect(message.isDue(now)).toBe(false);
        expect(message.publishedAt).toEqual(now);
        expect(message.attempts).toBe(1);
        expect(() => message.markPublished(now)).toThrow(InvalidMessageStateError);
        expect(() => message.scheduleRetry(now)).toThrow(InvalidMessageStateError);
    });

    test("scheduleRetry backs off exponentially and caps at one minute", () => {
        const message = OutboxMessage.enqueue(event());
        const delays: number[] = [];
        for (let index = 0; index < 8; index += 1) {
            message.scheduleRetry(now, "boom");
            delays.push((message.nextAttemptAt?.getTime() ?? 0) - now.getTime());
        }

        expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
        expect(message.attempts).toBe(8);
        expect(message.lastError).toBe("boom");
    });

    test("isDue respects nextAttemptAt", () => {
        const message = OutboxMessage.enqueue(event());
        message.scheduleRetry(now);

        expect(message.isDue(new Date(now.getTime() + 999))).toBe(false);
        expect(message.isDue(new Date(now.getTime() + 1000))).toBe(true);
    });

    test("truncates long errors", () => {
        const message = OutboxMessage.enqueue(event());
        message.scheduleRetry(now, "x".repeat(2000));

        expect(message.lastError?.length).toBe(500);
    });
});
