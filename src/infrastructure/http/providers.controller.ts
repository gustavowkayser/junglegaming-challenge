import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { GetWagerTransactionUseCase } from "../../application/wagering/get-wager-transaction.use-case";
import { ProviderAuthGuard } from "./provider-auth.guard";

@Controller("providers/:providerId/wagering/transactions")
@UseGuards(ProviderAuthGuard)
export class ProvidersController {
    constructor(private readonly transactions: GetWagerTransactionUseCase) {}

    @Get(":externalTransactionId")
    find(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string) {
        return this.transactions.byProviderExternalId(providerId, externalTransactionId);
    }
}
