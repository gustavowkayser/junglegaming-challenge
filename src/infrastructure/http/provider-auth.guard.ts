import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import {
    PROVIDER_IDENTITY,
    type ProviderIdentity,
    type ProviderIdentityPort,
} from "../../application/ports/provider-identity.port";

export type AuthenticatedRequest = Request & { providerIdentity?: ProviderIdentity };

@Injectable()
export class ProviderAuthGuard implements CanActivate {
    constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        request.providerIdentity = await this.identities.authenticate(request.headers);
        return true;
    }
}
