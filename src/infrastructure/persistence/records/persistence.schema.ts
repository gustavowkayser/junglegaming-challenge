import { EntitySchema } from "@mikro-orm/postgresql";
import { InboxMessageRecord } from "./inbox-message.record";
import { OutboxMessageRecord } from "./outbox-message.record";
import { WagerTransactionRecord } from "./wager-transaction.record";
import { WalletRecord } from "./wallet.record";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";

const money = { type: "decimal", precision: 20, scale: 2 } as const;
const timestamp = { type: "datetime", columnType: "timestamptz" } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
    class: WalletRecord,
    tableName: "wallets",
    properties: {
        id: { type: "uuid", primary: true },
        playerId: { type: "uuid" },
        currency: { type: "string", columnType: "char(3)" },
        balance: money,
        version: { type: "integer" },
        createdAt: timestamp,
        updatedAt: timestamp,
    },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: "wallet_ledger_entries",
    properties: {
        id: { type: "uuid", primary: true },
        walletId: { type: "uuid" },
        transactionId: { type: "uuid" },
        walletVersion: { type: "integer" },
        direction: { type: "string" },
        amount: money,
        currency: { type: "string", columnType: "char(3)" },
        balanceBefore: money,
        balanceAfter: money,
        createdAt: timestamp,
    },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
    class: WagerTransactionRecord,
    tableName: "wager_transactions",
    properties: {
        id: { type: "uuid", primary: true },
        providerId: { type: "string" },
        externalTransactionId: { type: "string" },
        idempotencyKey: { type: "string" },
        payloadHash: { type: "string", columnType: "char(64)" },
        walletId: { type: "uuid" },
        playerId: { type: "uuid" },
        roundId: { type: "string" },
        gameId: { type: "string" },
        kind: { type: "string" },
        amount: money,
        currency: { type: "string", columnType: "char(3)" },
        referenceExternalTransactionId: { type: "string", nullable: true },
        referenceTransactionId: { type: "uuid", nullable: true },
        status: { type: "string" },
        failureCode: { type: "string", nullable: true },
        resultBalance: { ...money, nullable: true },
        referenceAttempts: { type: "integer" },
        nextReferenceAttemptAt: { ...timestamp, nullable: true },
        createdAt: timestamp,
        updatedAt: timestamp,
        processedAt: { ...timestamp, nullable: true },
    },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
    class: InboxMessageRecord,
    tableName: "inbox_messages",
    properties: {
        consumerName: { type: "string", primary: true },
        messageId: { type: "string", primary: true },
        payloadHash: { type: "string", columnType: "char(64)" },
        receivedAt: timestamp,
        processedAt: { ...timestamp, nullable: true },
    },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
    class: OutboxMessageRecord,
    tableName: "outbox_messages",
    properties: {
        id: { type: "uuid", primary: true },
        aggregateId: { type: "uuid" },
        eventType: { type: "string" },
        payload: { type: "json" },
        occurredAt: timestamp,
        attempts: { type: "integer" },
        nextAttemptAt: timestamp,
        publishedAt: { ...timestamp, nullable: true },
        lastError: { type: "text", nullable: true },
    },
});

export const PERSISTENCE_SCHEMAS = [
    WalletSchema,
    WalletLedgerEntrySchema,
    WagerTransactionSchema,
    InboxMessageSchema,
    OutboxMessageSchema,
];
