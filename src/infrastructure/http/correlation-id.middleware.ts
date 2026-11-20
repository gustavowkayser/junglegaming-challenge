import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AppLogger } from "../observability/logger.service";
import { RequestContext } from "../observability/request-context.service";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID_CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
    constructor(private readonly logger: AppLogger) {}

    use(request: Request, response: Response, next: NextFunction): void {
        const header = request.header(CORRELATION_HEADER);
        const correlationId = header && VALID_CORRELATION.test(header) ? header : randomUUID();
        const startedAt = performance.now();
        response.setHeader(CORRELATION_HEADER, correlationId);
        RequestContext.run({ correlationId }, () => {
            const context = RequestContext.current();
            response.on("finish", () => {
                RequestContext.run(context, () =>
                    this.logger.log({
                        event: "http.request.completed",
                        method: request.method,
                        route: request.route?.path ?? request.path,
                        status: response.statusCode,
                        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
                    }),
                );
            });
            next();
        });
    }
}
