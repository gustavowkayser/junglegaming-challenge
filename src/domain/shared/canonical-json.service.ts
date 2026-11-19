export class CanonicalJsonError extends Error {}

function canonicalize(value: unknown, path: string): string {
    if (value === null) {
        return "null";
    }
    switch (typeof value) {
        case "string":
        case "boolean":
            return JSON.stringify(value);
        case "number":
            if (!Number.isFinite(value)) {
                throw new CanonicalJsonError(`Non-finite number at ${path}`);
            }
            return JSON.stringify(value);
        case "object": {
            if (Array.isArray(value)) {
                return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
            }
            const entries = Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry, `${path}.${key}`)}`);
            return `{${entries.join(",")}}`;
        }
        default:
            throw new CanonicalJsonError(`Unsupported value of type ${typeof value} at ${path}`);
    }
}

export function canonicalJson(value: unknown): string {
    return canonicalize(value, "$");
}
