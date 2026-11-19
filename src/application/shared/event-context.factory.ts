import type { EventContext } from "../../domain/events/event-context.types";
import type { Clock } from "../ports/clock.port";
import type { IdGenerator } from "../ports/id-generator.port";

export interface CorrelationContext {
    correlationId: string;
    causationId?: string | undefined;
}

export class EventContextFactory {
    constructor(
        private readonly ids: IdGenerator,
        private readonly clock: Clock,
    ) {}

    create(correlation: CorrelationContext, occurredAt: Date = this.clock.now()): EventContext {
        return {
            eventId: this.ids.next(),
            correlationId: correlation.correlationId,
            causationId: correlation.causationId,
            occurredAt,
        };
    }
}
