import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { describeError } from "../observability/error-description.service";
import { AppLogger } from "../observability/logger.service";
import { httpErrorFor } from "./error-status.service";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    constructor(private readonly logger: AppLogger) {}

    catch(error: unknown, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const request = http.getRequest<Request>();
        const reply = http.getResponse<Response>();
        const operation = request.method === "GET" ? "query" : "command";
        const mapped = httpErrorFor(error, operation);

        if (mapped.status >= 500) {
            this.logger.error({
                event: "http.request.failed",
                method: request.method,
                route: request.route?.path ?? request.path,
                status: mapped.status,
                code: mapped.body.error.code,
                err: describeError(error),
            });
        }
        for (const [header, value] of Object.entries(mapped.headers)) {
            reply.setHeader(header, value);
        }
        reply.status(mapped.status).json(mapped.body);
    }
}
