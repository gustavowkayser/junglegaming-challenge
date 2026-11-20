import { z } from "zod";
import { SUBMITTABLE_KINDS } from "../../domain/wagering/wager-transaction-kind.enum";
import { identifierSchema, moneySchema, uuidSchema } from "./money.schema";

export const wagerTransactionFieldsSchema = z
    .object({
        providerId: identifierSchema,
        externalTransactionId: identifierSchema,
        playerId: uuidSchema,
        walletId: uuidSchema,
        roundId: identifierSchema,
        gameId: identifierSchema,
        kind: z.enum(SUBMITTABLE_KINDS),
        money: moneySchema,
        referenceExternalTransactionId: identifierSchema.optional(),
    })
    .strict();

export type WagerTransactionFields = z.infer<typeof wagerTransactionFieldsSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(255);
