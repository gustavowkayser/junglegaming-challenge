import { Global, Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../application/ports/clock.port";
import { FAULT_INJECTOR } from "../application/ports/fault-injector.port";
import { ID_GENERATOR, type IdGenerator } from "../application/ports/id-generator.port";
import { METRICS, type Metrics } from "../application/ports/metrics.port";
import { PAYLOAD_HASHER, type PayloadHasher } from "../application/ports/payload-hasher.port";
import { PROVIDER_IDENTITY } from "../application/ports/provider-identity.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../application/ports/unit-of-work.port";
import { EventContextFactory } from "../application/shared/event-context.factory";
import { GetWagerTransactionUseCase } from "../application/wagering/get-wager-transaction.use-case";
import { SubmitWagerTransactionUseCase } from "../application/wagering/submit-wager-transaction.use-case";
import { WagerPayloadHasher } from "../application/wagering/wager-transaction-payload.service";
import { CreateWalletUseCase } from "../application/wallet/create-wallet.use-case";
import { GetWalletUseCase } from "../application/wallet/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "../application/wallet/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../application/wallet/reconcile-wallet.use-case";
import { ReferenceRetryPolicy } from "../domain/wagering/reference-retry-policy.service";
import { WagerSettlementService } from "../domain/wagering/wager-settlement.service";
import { PassThroughProviderIdentity } from "./auth/pass-through-provider-identity.adapter";
import { EnvironmentService } from "./config/environment.service";
import { PromMetrics } from "./observability/prom-metrics.adapter";
import { EnvFaultInjector } from "./system/env-fault-injector.adapter";
import { Sha256PayloadHasher } from "./system/sha256-payload-hasher.adapter";
import { SystemClock } from "./system/system-clock.adapter";
import { UuidV7IdGenerator } from "./system/uuid-v7-id-generator.adapter";

@Global()
@Module({
    providers: [
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
        { provide: PAYLOAD_HASHER, useClass: Sha256PayloadHasher },
        {
            provide: METRICS,
            inject: [UNIT_OF_WORK],
            useFactory: (unitOfWork: UnitOfWork) =>
                new PromMetrics(() => unitOfWork.run((repositories) => repositories.outbox.pendingStats())),
        },
        { provide: PROVIDER_IDENTITY, useClass: PassThroughProviderIdentity },
        {
            provide: FAULT_INJECTOR,
            inject: [EnvironmentService],
            useFactory: (environment: EnvironmentService) => new EnvFaultInjector(environment.get("FAULT_INJECTION")),
        },
        {
            provide: ReferenceRetryPolicy,
            inject: [EnvironmentService],
            useFactory: (environment: EnvironmentService) =>
                new ReferenceRetryPolicy({
                    maxAttempts: environment.get("PENDING_REFERENCE_MAX_ATTEMPTS"),
                    baseDelayMs: environment.get("PENDING_REFERENCE_BASE_DELAY_MS"),
                    maxDelayMs: environment.get("PENDING_REFERENCE_MAX_DELAY_MS"),
                }),
        },
        {
            provide: WagerSettlementService,
            inject: [ReferenceRetryPolicy],
            useFactory: (policy: ReferenceRetryPolicy) => new WagerSettlementService(policy),
        },
        {
            provide: WagerPayloadHasher,
            inject: [PAYLOAD_HASHER],
            useFactory: (hasher: PayloadHasher) => new WagerPayloadHasher(hasher),
        },
        {
            provide: EventContextFactory,
            inject: [ID_GENERATOR, CLOCK],
            useFactory: (ids: IdGenerator, clock: Clock) => new EventContextFactory(ids, clock),
        },
        {
            provide: SubmitWagerTransactionUseCase,
            inject: [
                UNIT_OF_WORK,
                WagerSettlementService,
                WagerPayloadHasher,
                ID_GENERATOR,
                CLOCK,
                EventContextFactory,
                METRICS,
            ],
            useFactory: (
                unitOfWork: UnitOfWork,
                settlement: WagerSettlementService,
                hasher: WagerPayloadHasher,
                ids: IdGenerator,
                clock: Clock,
                events: EventContextFactory,
                metrics: Metrics,
            ) => new SubmitWagerTransactionUseCase(unitOfWork, settlement, hasher, ids, clock, events, metrics),
        },
        {
            provide: CreateWalletUseCase,
            inject: [UNIT_OF_WORK, WagerPayloadHasher, ID_GENERATOR, CLOCK, EventContextFactory, METRICS],
            useFactory: (
                unitOfWork: UnitOfWork,
                hasher: WagerPayloadHasher,
                ids: IdGenerator,
                clock: Clock,
                events: EventContextFactory,
                metrics: Metrics,
            ) => new CreateWalletUseCase(unitOfWork, hasher, ids, clock, events, metrics),
        },
        {
            provide: GetWalletUseCase,
            inject: [UNIT_OF_WORK],
            useFactory: (unitOfWork: UnitOfWork) => new GetWalletUseCase(unitOfWork),
        },
        {
            provide: ListWalletLedgerUseCase,
            inject: [UNIT_OF_WORK],
            useFactory: (unitOfWork: UnitOfWork) => new ListWalletLedgerUseCase(unitOfWork),
        },
        {
            provide: ReconcileWalletUseCase,
            inject: [UNIT_OF_WORK, METRICS],
            useFactory: (unitOfWork: UnitOfWork, metrics: Metrics) => new ReconcileWalletUseCase(unitOfWork, metrics),
        },
        {
            provide: GetWagerTransactionUseCase,
            inject: [UNIT_OF_WORK],
            useFactory: (unitOfWork: UnitOfWork) => new GetWagerTransactionUseCase(unitOfWork),
        },
    ],
    exports: [
        CLOCK,
        ID_GENERATOR,
        PAYLOAD_HASHER,
        METRICS,
        PROVIDER_IDENTITY,
        FAULT_INJECTOR,
        ReferenceRetryPolicy,
        WagerSettlementService,
        WagerPayloadHasher,
        EventContextFactory,
        SubmitWagerTransactionUseCase,
        CreateWalletUseCase,
        GetWalletUseCase,
        ListWalletLedgerUseCase,
        GetWagerTransactionUseCase,
        ReconcileWalletUseCase,
    ],
})
export class ApplicationModule {}
