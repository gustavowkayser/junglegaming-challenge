import { Injectable, LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Level, type Logger } from "pino";
import { RequestContext } from "./request-context.service";

export const REDACTED_PATHS = [
    "money",
    "balance",
    "initialBalance",
    "payload",
    "body",
    "*.money",
    "*.balance",
    "*.initialBalance",
    "*.payload",
    "*.body",
];

export function createRootLogger(level: string, destination?: DestinationStream): Logger {
    return pino(
        {
            level,
            base: { service: "wagering-processor", pid: process.pid },
            timestamp: pino.stdTimeFunctions.isoTime,
            messageKey: "message",
            formatters: {
                level: (label) => ({ level: label }),
            },
            redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
            mixin: () => ({ ...RequestContext.current() }),
        },
        destination,
    );
}

@Injectable()
export class AppLogger implements LoggerService {
    constructor(private readonly root: Logger) {}

    child(component: string): Logger {
        return this.root.child({ component });
    }

    log(message: unknown, ...optional: unknown[]): void {
        this.write("info", message, optional);
    }

    error(message: unknown, ...optional: unknown[]): void {
        this.write("error", message, optional);
    }

    warn(message: unknown, ...optional: unknown[]): void {
        this.write("warn", message, optional);
    }

    debug(message: unknown, ...optional: unknown[]): void {
        this.write("debug", message, optional);
    }

    verbose(message: unknown, ...optional: unknown[]): void {
        this.write("trace", message, optional);
    }

    fatal(message: unknown, ...optional: unknown[]): void {
        this.write("fatal", message, optional);
    }

    private write(level: Level, message: unknown, optional: unknown[]): void {
        const last = optional.at(-1);
        const fields: Record<string, unknown> = typeof last === "string" ? { component: last } : {};
        if (message instanceof Error) {
            this.root[level]({ ...fields, err: message }, message.message);
            return;
        }
        if (typeof message === "object" && message !== null) {
            this.root[level]({ ...fields, ...message });
            return;
        }
        this.root[level](fields, String(message));
    }
}
