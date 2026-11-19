import type { MoneyProps } from "../../domain/money/money.types";
import { Money } from "../../domain/money/money.value-object";
import { canonicalJson } from "../../domain/shared/canonical-json.service";
import type { PayloadHasher } from "../ports/payload-hasher.port";

export interface WagerBusinessFields {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: MoneyProps;
    referenceExternalTransactionId?: string | undefined;
}

export function businessPayloadOf(fields: WagerBusinessFields): Record<string, unknown> {
    return {
        providerId: fields.providerId,
        externalTransactionId: fields.externalTransactionId,
        playerId: fields.playerId.toLowerCase(),
        walletId: fields.walletId.toLowerCase(),
        roundId: fields.roundId,
        gameId: fields.gameId,
        kind: fields.kind,
        money: Money.from(fields.money).toJSON(),
        referenceExternalTransactionId: fields.referenceExternalTransactionId,
    };
}

export class WagerPayloadHasher {
    constructor(private readonly hasher: PayloadHasher) {}

    hashBusinessFields(fields: WagerBusinessFields): string {
        return this.hasher.hash(canonicalJson(businessPayloadOf(fields)));
    }

    hashValue(value: unknown): string {
        return this.hasher.hash(canonicalJson(value));
    }
}
