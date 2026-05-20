import { describe, test, expect } from "bun:test";
import { extractTopics } from "../extraction/topics.js";
import type { Message } from "../schemas/crm.js";

const msg = (content: string): Message => ({ role: "customer", content, timestamp: "2025-01-01T00:00:00Z" });

describe("extractTopics", () => {
  test("extracts billing topics", () => {
    const result = extractTopics([msg("I need a refund for the invoice charge")]);
    expect(result).toContain("billing");
  });

  test("extracts technical topics", () => {
    const result = extractTopics([msg("I got an error when trying to login")]);
    expect(result).toContain("technical");
  });

  test("deduplicates and sorts", () => {
    const result = extractTopics([
      msg("payment invoice refund"),
      msg("another payment issue with my bill"),
    ]);
    expect(result).toEqual([...result].sort());
    expect(new Set(result).size).toBe(result.length);
  });
});
