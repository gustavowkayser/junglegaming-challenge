export interface PayloadHasher {
    hash(canonicalPayload: string): string;
}

export const PAYLOAD_HASHER = Symbol("PayloadHasher");
