import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ValidationError } from "../../application/errors/application.error";
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from "../../application/ports/provider-identity.port";
import { GetWagerTransactionUseCase } from "../../application/wagering/get-wager-transaction.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/wagering/submit-wager-transaction.use-case";
import {
    idempotencyKeySchema,
    type WagerTransactionFields,
    wagerTransactionFieldsSchema,
} from "../contracts/wager-transaction.schema";
import { AppLogger } from "../observability/logger.service";
import { RequestContext } from "../observability/request-context.service";
import { TRANSACTION_STATUS_HTTP } from "./error-status.service";
import { type AuthenticatedRequest, ProviderAuthGuard } from "./provider-auth.guard";
import { currentCorrelationId, requireUuid } from "./request-identity.service";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("wagering/transactions")
@UseGuards(ProviderAuthGuard)
export class WageringController {
    constructor(
        private readonly submit: SubmitWagerTransactionUseCase,
        private readonly transactions: GetWagerTransactionUseCase,
        @Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort,
        private readonly logger: AppLogger,
    ) {}

    @Post()
    async create(
        @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
        @Body(new ZodValidationPipe(wagerTransactionFieldsSchema)) body: WagerTransactionFields,
        @Req() request: AuthenticatedRequest,
        @Res({ passthrough: true }) response: Response,
    ) {
        const idempotencyKey = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
        if (!idempotencyKey.success) {
            throw new ValidationError("The Idempotency-Key header is required", undefined, "IDEMPOTENCY_KEY_REQUIRED");
        }
        RequestContext.assign({ walletId: body.walletId, providerId: body.providerId });
        this.identities.assertCanActAs(
            request.providerIdentity ?? { authenticated: false, providerId: undefined },
            body.providerId,
        );
        const result = await this.submit.execute({
            ...body,
            idempotencyKey: idempotencyKey.data,
            source: "http",
            correlationId: currentCorrelationId(),
        });
        RequestContext.assign({ transactionId: result.transactionId });
        this.logger.log({
            event: "wager.transaction_submitted",
            source: "http",
            kind: body.kind,
            status: result.status,
            failureCode: result.failureCode,
            replay: result.idempotentReplay,
        });
        response.status(TRANSACTION_STATUS_HTTP[result.status] ?? 500);
        return result;
    }

    @Get(":transactionId")
    find(@Param("transactionId") transactionId: string) {
        return this.transactions.byId(requireUuid(transactionId, "TRANSACTION_NOT_FOUND"));
    }
}
