import { describe, test, expect } from "bun:test";
import { stringifyOrTruncate, MAX_TOOL_IO_BYTES } from "../llm/spans.js";

describe("stringifyOrTruncate", () => {
  test("serializes plain objects", () => {
    expect(stringifyOrTruncate({ a: 1 })).toBe('{"a":1}');
  });

  test("serializes strings", () => {
    expect(stringifyOrTruncate("hello")).toBe('"hello"');
  });

  test("serializes null", () => {
    expect(stringifyOrTruncate(null)).toBe("null");
  });

  test("serializes arrays", () => {
    expect(stringifyOrTruncate([1, 2, 3])).toBe("[1,2,3]");
  });

  test("truncates values exceeding MAX_TOOL_IO_BYTES", () => {
    const large = "x".repeat(MAX_TOOL_IO_BYTES + 100);
    const result = stringifyOrTruncate(large);
    const parsed = JSON.parse(result);
    expect(parsed.truncated).toBeGreaterThan(MAX_TOOL_IO_BYTES);
  });

  test("returns unserializable marker for circular references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = stringifyOrTruncate(circular);
    const parsed = JSON.parse(result);
    expect(parsed.unserializable).toBe(true);
    expect(parsed.type).toBe("object");
  });

  test("values at exactly MAX_TOOL_IO_BYTES are not truncated", () => {
    // Create a string that serializes to exactly MAX_TOOL_IO_BYTES
    // JSON.stringify adds quotes, so the string content is shorter
    const content = "a".repeat(MAX_TOOL_IO_BYTES - 2); // minus 2 for quotes
    const result = stringifyOrTruncate(content);
    expect(result.length).toBe(MAX_TOOL_IO_BYTES);
    expect(result).toBe(`"${content}"`);
  });

  test("handles undefined (JSON.stringify returns undefined)", () => {
    const result = stringifyOrTruncate(undefined);
    // JSON.stringify(undefined) returns undefined, we coerce to ""
    expect(result).toBe("");
  });
});
