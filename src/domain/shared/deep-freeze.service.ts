export function deepFreeze<T>(value: T): Readonly<T> {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

export function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
