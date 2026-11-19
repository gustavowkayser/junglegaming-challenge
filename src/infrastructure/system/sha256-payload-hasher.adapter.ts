import { createHash } from "node:crypto";
import type { PayloadHasher } from "../../application/ports/payload-hasher.port";

export class Sha256PayloadHasher implements PayloadHasher {
    hash(canonicalPayload: string): string {
        return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
    }
}
