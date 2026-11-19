import type { Wallet } from "./wallet.aggregate";

export interface WalletRepository {
    findById(id: string): Promise<Wallet | undefined>;
    findByIdForUpdate(id: string): Promise<Wallet | undefined>;
    findByIdForShare(id: string): Promise<Wallet | undefined>;
    insert(wallet: Wallet): Promise<void>;
    update(wallet: Wallet): Promise<void>;
}
