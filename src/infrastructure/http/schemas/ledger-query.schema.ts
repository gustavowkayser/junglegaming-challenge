import { z } from "zod";
import { MAX_LEDGER_PAGE_SIZE } from "../../../application/wallet/list-wallet-ledger.use-case";

export const ledgerQuerySchema = z.object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LEDGER_PAGE_SIZE).default(50),
});

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
