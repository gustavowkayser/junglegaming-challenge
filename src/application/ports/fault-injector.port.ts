export type FaultPoint = "after-commit-before-ack" | "before-publish-commit";

export interface FaultInjector {
    reach(point: FaultPoint): void;
}

export const FAULT_INJECTOR = Symbol("FaultInjector");
