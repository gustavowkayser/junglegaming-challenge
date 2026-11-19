import type { ProviderIdentity, ProviderIdentityPort } from "../../application/ports/provider-identity.port";

export class PassThroughProviderIdentity implements ProviderIdentityPort {
    async authenticate(): Promise<ProviderIdentity> {
        return { authenticated: false, providerId: undefined };
    }

    assertCanActAs(): void {}
}
