export interface ProviderIdentity {
    authenticated: boolean;
    providerId: string | undefined;
}

export interface ProviderIdentityPort {
    authenticate(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<ProviderIdentity>;
    assertCanActAs(identity: ProviderIdentity, providerId: string): void;
}

export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");
