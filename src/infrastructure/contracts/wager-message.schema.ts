import { z } from "zod";
import { idempotencyKeySchema, wagerTransactionFieldsSchema } from "./wager-transaction.schema";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

export const wagerMessageSchema = z.object({
    messageId: z.string().trim().min(1).max(256),
    type: z.literal(WAGER_MESSAGE_TYPE),
    occurredAt: z.iso.datetime(),
    correlationId: z.string().trim().min(1).max(128).optional(),
    data: wagerTransactionFieldsSchema.extend({ idempotencyKey: idempotencyKeySchema }).strict(),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
