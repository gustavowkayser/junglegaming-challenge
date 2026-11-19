import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import { TransientInfrastructureError } from "../../../application/errors/application.error";
import type { Wallet } from "../../../domain/wallet/wallet.aggregate";
import type { WalletRepository } from "../../../domain/wallet/wallet.repository";
import { WalletMapper } from "../mappers/wallet.mapper";
import { WalletRecord } from "../records/wallet.record";

export class MikroOrmWalletRepository implements WalletRepository {
    constructor(private readonly em: EntityManager) {}

    findById(id: string): Promise<Wallet | undefined> {
        return this.find(id, LockMode.NONE);
    }

    findByIdForUpdate(id: string): Promise<Wallet | undefined> {
        return this.find(id, LockMode.PESSIMISTIC_WRITE);
    }

    findByIdForShare(id: string): Promise<Wallet | undefined> {
        return this.find(id, LockMode.PESSIMISTIC_READ);
    }

    async insert(wallet: Wallet): Promise<void> {
        await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    }

    async update(wallet: Wallet): Promise<void> {
        if (!wallet.hasChanges()) {
            return;
        }
        const affected = await this.em.nativeUpdate(
            WalletRecord,
            { id: wallet.id, version: wallet.persistedVersion },
            {
                balance: wallet.balance.toJSON().amount,
                version: wallet.version,
                updatedAt: wallet.updatedAt,
            },
        );
        if (affected !== 1) {
            throw new TransientInfrastructureError(
                "version_conflict",
                `Wallet ${wallet.id} was modified concurrently (expected version ${wallet.persistedVersion})`,
            );
        }
    }

    private async find(id: string, lockMode: LockMode): Promise<Wallet | undefined> {
        const record = await this.em.findOne(
            WalletRecord,
            { id },
            lockMode === LockMode.NONE ? { disableIdentityMap: true } : { lockMode, disableIdentityMap: true },
        );
        return record ? WalletMapper.toDomain(record) : undefined;
    }
}
