import { z } from "zod";
import { Money } from "../../domain/money/money.value-object";

export const moneySchema = z
    .object({
        amount: z.string(),
        currency: z.string(),
    })
    .strict()
    .superRefine((value, context) => {
        try {
            Money.from(value);
        } catch (error) {
            context.addIssue({ code: "custom", message: (error as Error).message, path: ["amount"] });
        }
    });

export const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export const identifierSchema = z.string().trim().min(1).max(128);
