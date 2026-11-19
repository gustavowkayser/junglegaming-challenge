import type { Wallet } from "../wallet/wallet.aggregate";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry.entity";
import type { RejectionCode } from "./failure-code.enum";
import type { WagerTransaction } from "./wager-transaction.aggregate";

export interface SettlementInput {
    wallet: Wallet;
    transaction: WagerTransaction;
    reference: WagerTransaction | undefined;
    referenceAlreadyReversed: boolean;
    entryId: string;
    now: Date;
}

export type SettlementOutcome =
    | { type: "processed"; entry: WalletLedgerEntry | undefined }
    | { type: "rejected"; code: RejectionCode }
    | { type: "pending-reference" };
