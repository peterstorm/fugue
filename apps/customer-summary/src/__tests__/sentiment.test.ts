import { describe, test, expect } from "bun:test";
import { analyzeSentiment } from "../extraction/sentiment.js";
import type { Message } from "../schemas/crm.js";

const msg = (content: string): Message => ({ role: "customer", content, timestamp: "2025-01-01T00:00:00Z" });

describe("analyzeSentiment", () => {
  test("detects positive keywords", () => {
    const result = analyzeSentiment([msg("Thank you, this is great and excellent!")]);
    expect(result[0].sentiment).toBe("positive");
    expect(result[0].keywords).toContain("thank");
    expect(result[0].keywords).toContain("great");
  });

  test("detects negative keywords", () => {
    const result = analyzeSentiment([msg("This is terrible and awful service")]);
    expect(result[0].sentiment).toBe("negative");
    expect(result[0].keywords).toContain("terrible");
  });

  test("returns neutral for ambiguous messages", () => {
    const result = analyzeSentiment([msg("I have a question about my order")]);
    expect(result[0].sentiment).toBe("neutral");
    expect(result[0].keywords).toEqual([]);
  });
});
