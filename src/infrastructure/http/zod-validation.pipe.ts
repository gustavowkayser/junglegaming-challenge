import { Injectable, PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ValidationError } from "../../application/errors/application.error";

export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
    return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export function parseWith<T extends z.ZodType>(schema: T, value: unknown, message = "Invalid request"): z.output<T> {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new ValidationError(message, issuesOf(result.error));
    }
    return result.data;
}

@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
    constructor(private readonly schema: T) {}

    transform(value: unknown): z.output<T> {
        return parseWith(this.schema, value);
    }
}
