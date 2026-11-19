import type { FaultInjector, FaultPoint } from "../../application/ports/fault-injector.port";
import type { Environment } from "../config/environment.schema";

const POINT_BY_SETTING: Record<Environment["FAULT_INJECTION"], FaultPoint | undefined> = {
    none: undefined,
    "crash-after-commit": "after-commit-before-ack",
    "crash-before-publish-commit": "before-publish-commit",
};

export const FAULT_EXIT_CODE = 86;

export class EnvFaultInjector implements FaultInjector {
    private readonly armed: FaultPoint | undefined;

    constructor(setting: Environment["FAULT_INJECTION"]) {
        this.armed = POINT_BY_SETTING[setting];
    }

    reach(point: FaultPoint): void {
        if (this.armed === point) {
            process.stderr.write(`${JSON.stringify({ level: "fatal", event: "fault.injected", point })}\n`);
            process.exit(FAULT_EXIT_CODE);
        }
    }
}
