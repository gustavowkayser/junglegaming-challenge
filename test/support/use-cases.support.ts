import type { MikroORM } from "@mikro-orm/postgresql";
import { PublishOutboxUseCase } from "../../src/application/messaging/publish-outbox.use-case";
import type { EventPublisher } from "../../src/application/ports/event-publisher.port";
import type { FaultInjector } from "../../src/application/ports/fault-injector.port";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work.port";
import { EventContextFactory } from "../../src/application/shared/event-context.factory";
import { SubmitWagerTransactionUseCase } from "../../src/application/wagering/submit-wager-transaction.use-case";
import { WagerPayloadHasher } from "../../src/application/wagering/wager-transaction-payload.service";
import { CreateWalletUseCase } from "../../src/application/wallet/create-wallet.use-case";
import { ReferenceRetryPolicy } from "../../src/domain/wagering/reference-retry-policy.service";
import { WagerSettlementService } from "../../src/domain/wagering/wager-settlement.service";
import { NoopMetrics } from "../../src/infrastructure/observability/noop-metrics.adapter";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work.adapter";
import { Sha256PayloadHasher } from "../../src/infrastructure/system/sha256-payload-hasher.adapter";
import { SystemClock } from "../../src/infrastructure/system/system-clock.adapter";
import { UuidV7IdGenerator } from "../../src/infrastructure/system/uuid-v7-id-generator.adapter";

export const clock = new SystemClock();
export const ids = new UuidV7IdGenerator();
export const metrics = new NoopMetrics();
export const noFaults: FaultInjector = { reach: () => undefined };

export function unitOfWorkFor(orm: MikroORM): UnitOfWork {
    return new MikroOrmUnitOfWork(orm);
}

export function referencePolicy(
    overrides: Partial<{ maxAttempts: number; baseDelayMs: number; maxDelayMs: number }> = {},
) {
    return new ReferenceRetryPolicy({ maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 300_000, ...overrides });
}

export function submitUseCase(unitOfWork: UnitOfWork, policy = referencePolicy()) {
    return new SubmitWagerTransactionUseCase(
        unitOfWork,
        new WagerSettlementService(policy),
        new WagerPayloadHasher(new Sha256PayloadHasher()),
        ids,
        clock,
        new EventContextFactory(ids, clock),
        metrics,
    );
}

export function publishUseCase(unitOfWork: UnitOfWork, publisher: EventPublisher, batchSize = 20) {
    return new PublishOutboxUseCase(unitOfWork, publisher, clock, metrics, noFaults, batchSize);
}

export function createWalletUseCase(unitOfWork: UnitOfWork) {
    return new CreateWalletUseCase(
        unitOfWork,
        new WagerPayloadHasher(new Sha256PayloadHasher()),
        ids,
        clock,
        new EventContextFactory(ids, clock),
        metrics,
    );
}

export async function seedWallet(unitOfWork: UnitOfWork, amount = "100.00") {
    const wallet = await createWalletUseCase(unitOfWork).execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount, currency: "BRL" },
        correlationId: "seed",
    });
    return { walletId: wallet.id, playerId: wallet.playerId };
}
