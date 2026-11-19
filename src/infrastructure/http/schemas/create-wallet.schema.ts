import { z } from "zod";
import { moneySchema, uuidSchema } from "./money.schema";

export const createWalletSchema = z
    .object({
        playerId: uuidSchema,
        initialBalance: moneySchema,
    })
    .strict();

export type CreateWalletBody = z.infer<typeof createWalletSchema>;
