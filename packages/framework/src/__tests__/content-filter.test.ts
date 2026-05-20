import { describe, it, expect } from "bun:test";
import { piiScrubber, IDENTITY_FILTER, composeFilters, resolveContentFilter } from "../tracing/content-filter.js";

describe("piiScrubber", () => {
  it("scrubs email addresses", () => {
    expect(piiScrubber("Contact alice@example.com for info")).toBe("Contact [EMAIL] for info");
  });

  it("scrubs phone numbers", () => {
    expect(piiScrubber("Call +1-555-010-1234 now")).toBe("Call [PHONE] now");
    expect(piiScrubber("Phone: (555) 123-4567")).toBe("Phone: [PHONE]");
  });

  it("scrubs credit card numbers", () => {
    expect(piiScrubber("Card: 4111-1111-1111-1111")).toBe("Card: [CREDIT_CARD]");
    expect(piiScrubber("Card: 4111 1111 1111 1111")).toBe("Card: [CREDIT_CARD]");
  });

  it("scrubs US SSN", () => {
    expect(piiScrubber("SSN: 123-45-6789")).toBe("SSN: [SSN]");
  });

  it("scrubs Danish CPR numbers", () => {
    expect(piiScrubber("CPR: 010190-1234")).toBe("CPR: [CPR]");
  });

  it("scrubs IP addresses", () => {
    expect(piiScrubber("Server at 192.168.1.1 responded")).toBe("Server at [IP] responded");
  });

  it("handles multiple PII in one string", () => {
    const input = "User alice@test.com called from +45 1234 5678";
    const result = piiScrubber(input);
    expect(result).not.toContain("alice@test.com");
    expect(result).toContain("[EMAIL]");
    expect(result).toContain("[PHONE]");
  });

  it("preserves non-PII content", () => {
    const input = "The customer sentiment is positive with score 0.85";
    expect(piiScrubber(input)).toBe(input);
  });

  it("does not scrub 10-digit order IDs", () => {
    expect(piiScrubber("Order #1234567890")).toBe("Order #1234567890");
  });

  it("does not scrub timestamps", () => {
    expect(piiScrubber("Created at 1715520000")).toBe("Created at 1715520000");
  });

  it("does not scrub version numbers", () => {
    expect(piiScrubber("Version 2.14.3 released")).toBe("Version 2.14.3 released");
  });

  it("scrubs CPR with valid date prefix", () => {
    // 15th January 1990
    expect(piiScrubber("CPR: 150190-1234")).toBe("CPR: [CPR]");
    // Without dash
    expect(piiScrubber("CPR: 1501901234")).toBe("CPR: [CPR]");
  });

  it("does not scrub invalid CPR dates", () => {
    // Month 13 is invalid
    expect(piiScrubber("Ref: 011390-1234")).toBe("Ref: 011390-1234");
    // Day 32 is invalid
    expect(piiScrubber("Ref: 320190-1234")).toBe("Ref: 320190-1234");
  });
});

describe("IDENTITY_FILTER", () => {
  it("passes content through unchanged", () => {
    const input = "alice@example.com 555-1234";
    expect(IDENTITY_FILTER(input)).toBe(input);
  });
});

describe("composeFilters", () => {
  it("applies filters left to right", () => {
    const upper = (s: string) => s.toUpperCase();
    const trim = (s: string) => s.trim();
    const composed = composeFilters(trim, upper);
    expect(composed("  hello  ")).toBe("HELLO");
  });
});

describe("resolveContentFilter", () => {
  it("returns contentFilter when provided", () => {
    const filter = (s: string) => s.toUpperCase();
    expect(resolveContentFilter({ contentFilter: filter })).toBe(filter);
  });

  it("returns IDENTITY_FILTER when set explicitly", () => {
    expect(resolveContentFilter({ contentFilter: IDENTITY_FILTER })).toBe(IDENTITY_FILTER);
  });

  it("returns null when nothing set", () => {
    expect(resolveContentFilter({})).toBeNull();
  });

  it("returns null when contentFilter is null", () => {
    expect(resolveContentFilter({ contentFilter: null })).toBeNull();
  });
});
