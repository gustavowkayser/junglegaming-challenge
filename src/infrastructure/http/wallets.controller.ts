import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { CreateWalletUseCase } from "../../application/wallet/create-wallet.use-case";
import { GetWalletUseCase } from "../../application/wallet/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "../../application/wallet/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../../application/wallet/reconcile-wallet.use-case";
import { AppLogger } from "../observability/logger.service";
import { RequestContext } from "../observability/request-context.service";
import { currentCorrelationId, requireUuid } from "./request-identity.service";
import { type CreateWalletBody, createWalletSchema } from "./schemas/create-wallet.schema";
import { type LedgerQuery, ledgerQuerySchema } from "./schemas/ledger-query.schema";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("wallets")
export class WalletsController {
    constructor(
        private readonly createWallet: CreateWalletUseCase,
        private readonly getWallet: GetWalletUseCase,
        private readonly listLedger: ListWalletLedgerUseCase,
        private readonly reconcileWallet: ReconcileWalletUseCase,
        private readonly logger: AppLogger,
    ) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    async create(@Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletBody) {
        const wallet = await this.createWallet.execute({ ...body, correlationId: currentCorrelationId() });
        RequestContext.assign({ walletId: wallet.id });
        return wallet;
    }

    @Get(":walletId")
    find(@Param("walletId") walletId: string) {
        return this.getWallet.execute(requireUuid(walletId, "WALLET_NOT_FOUND"));
    }

    @Get(":walletId/ledger")
    ledger(@Param("walletId") walletId: string, @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery) {
        return this.listLedger.execute({
            walletId: requireUuid(walletId, "WALLET_NOT_FOUND"),
            cursor: query.cursor,
            limit: query.limit,
        });
    }

    @Post(":walletId/reconciliation")
    @HttpCode(HttpStatus.OK)
    async reconcile(@Param("walletId") walletId: string) {
        const id = requireUuid(walletId, "WALLET_NOT_FOUND");
        RequestContext.assign({ walletId: id });
        const report = await this.reconcileWallet.execute(id);
        if (report.consistent) {
            this.logger.log({ event: "reconciliation.consistent", checkedEntries: report.checkedEntries });
        } else {
            this.logger.error({
                event: "reconciliation.divergence_detected",
                checkedEntries: report.checkedEntries,
                walletVersion: report.walletVersion,
                checks: report.checks,
            });
        }
        return report;
    }
}
