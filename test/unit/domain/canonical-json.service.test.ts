import { describe, expect, test } from "bun:test";
import { CanonicalJsonError, canonicalJson } from "../../../src/domain/shared/canonical-json.service";

describe("canonicalJson", () => {
    test("sorts keys recursively and removes whitespace", () => {
        expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
            '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
        );
    });

    test("is independent of key insertion order", () => {
        expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    });

    test("omits undefined properties", () => {
        expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    test("escapes strings like JSON", () => {
        expect(canonicalJson({ text: 'quote " and \\' })).toBe('{"text":"quote \\" and \\\\"}');
    });

    test("rejects unsupported values", () => {
        expect(() => canonicalJson({ value: Number.NaN })).toThrow(CanonicalJsonError);
        expect(() => canonicalJson({ value: 1n })).toThrow(CanonicalJsonError);
        expect(() => canonicalJson({ value: () => 1 })).toThrow(CanonicalJsonError);
    });
});
