import type { MoneyProps } from "../../domain/money/money.types";
import { NotFoundError } from "../errors/application.error";
import type { Metrics } from "../ports/metrics.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";

export interface ReconciliationReport {
    walletId: string;
    storedBalance: MoneyProps;
    calculatedBalance: MoneyProps;
    difference: MoneyProps;
    consistent: boolean;
    checkedEntries: number;
    walletVersion: number;
    checks: {
        ledgerSumMatchesBalance: boolean;
        lastEntryMatchesBalance: boolean;
        lastEntryMatchesVersion: boolean;
    };
}

export class ReconcileWalletUseCase {
    constructor(
        private readonly unitOfWork: UnitOfWork,
        private readonly metrics: Metrics,
    ) {}

    async execute(walletId: string): Promise<ReconciliationReport> {
        const report = await this.unitOfWork.run(async (repositories) => {
            const wallet = await repositories.wallets.findByIdForShare(walletId);
            if (!wallet) {
                throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} does not exist`);
            }
            const summary = await repositories.ledger.summarize(wallet.id, wallet.currency);
            const calculated = summary.credits.subtract(summary.debits);
            const difference = wallet.balance.subtract(calculated);
            const hasEntries = summary.count > 0;
            const checks = {
                ledgerSumMatchesBalance: difference.isZero(),
                lastEntryMatchesBalance: hasEntries
                    ? (summary.lastBalanceAfter?.equals(wallet.balance) ?? false)
                    : wallet.balance.isZero(),
                lastEntryMatchesVersion: hasEntries
                    ? summary.lastWalletVersion === wallet.version
                    : wallet.version === 1,
            };
            return {
                walletId: wallet.id,
                storedBalance: wallet.balance.toJSON(),
                calculatedBalance: calculated.toJSON(),
                difference: difference.toJSON(),
                consistent: Object.values(checks).every(Boolean),
                checkedEntries: summary.count,
                walletVersion: wallet.version,
                checks,
            };
        });
        this.metrics.reconciliationChecked(report.consistent);
        return report;
    }
}
