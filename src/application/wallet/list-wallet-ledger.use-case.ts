import { NotFoundError, ValidationError } from "../errors/application.error";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import { type LedgerEntryView, toLedgerEntryView } from "./wallet.view";

export interface ListWalletLedgerQuery {
    walletId: string;
    cursor?: string | undefined;
    limit: number;
}

export interface LedgerPage {
    walletId: string;
    items: LedgerEntryView[];
    nextCursor: string | null;
}

export const MAX_LEDGER_PAGE_SIZE = 200;

export function encodeLedgerCursor(walletVersion: number): string {
    return Buffer.from(JSON.stringify({ v: walletVersion }), "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
    try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        const version = (decoded as { v?: unknown })?.v;
        if (typeof version === "number" && Number.isInteger(version) && version >= 0) {
            return version;
        }
    } catch {
        throw new ValidationError("Invalid ledger cursor");
    }
    throw new ValidationError("Invalid ledger cursor");
}

export class ListWalletLedgerUseCase {
    constructor(private readonly unitOfWork: UnitOfWork) {}

    async execute(query: ListWalletLedgerQuery): Promise<LedgerPage> {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LEDGER_PAGE_SIZE) {
            throw new ValidationError(`limit must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}`);
        }
        const afterVersion = query.cursor ? decodeLedgerCursor(query.cursor) : 0;
        return this.unitOfWork.run(async (repositories) => {
            const wallet = await repositories.wallets.findById(query.walletId);
            if (!wallet) {
                throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${query.walletId} does not exist`);
            }
            const entries = await repositories.ledger.listByWallet(query.walletId, afterVersion, query.limit + 1);
            const page = entries.slice(0, query.limit);
            const last = page.at(-1);
            return {
                walletId: wallet.id,
                items: page.map(toLedgerEntryView),
                nextCursor: entries.length > query.limit && last ? encodeLedgerCursor(last.walletVersion) : null,
            };
        });
    }
}
