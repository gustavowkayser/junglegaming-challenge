import { NotFoundError } from "../errors/application.error";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import { toWagerTransactionView, type WagerTransactionView } from "./wager-transaction.view";

export class GetWagerTransactionUseCase {
    constructor(private readonly unitOfWork: UnitOfWork) {}

    async byId(transactionId: string): Promise<WagerTransactionView> {
        const transaction = await this.unitOfWork.run((repositories) =>
            repositories.transactions.findById(transactionId),
        );
        if (!transaction) {
            throw new NotFoundError("TRANSACTION_NOT_FOUND", `Transaction ${transactionId} does not exist`);
        }
        return toWagerTransactionView(transaction);
    }

    async byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
        const transaction = await this.unitOfWork.run((repositories) =>
            repositories.transactions.findByProviderExternalId(providerId, externalTransactionId),
        );
        if (!transaction) {
            throw new NotFoundError(
                "TRANSACTION_NOT_FOUND",
                `Transaction ${providerId}:${externalTransactionId} does not exist`,
            );
        }
        return toWagerTransactionView(transaction);
    }
}
