import { NotFoundError } from "../errors/application.error";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import { toWalletView, type WalletView } from "./wallet.view";

export class GetWalletUseCase {
    constructor(private readonly unitOfWork: UnitOfWork) {}

    async execute(walletId: string): Promise<WalletView> {
        const wallet = await this.unitOfWork.run((repositories) => repositories.wallets.findById(walletId));
        if (!wallet) {
            throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} does not exist`);
        }
        return toWalletView(wallet);
    }
}
