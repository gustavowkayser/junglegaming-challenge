import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "./environment.schema";

@Injectable()
export class EnvironmentService {
    constructor(private readonly config: ConfigService<Environment, true>) {}

    get<TKey extends keyof Environment>(key: TKey): Environment[TKey] {
        return this.config.get(key, { infer: true });
    }
}
