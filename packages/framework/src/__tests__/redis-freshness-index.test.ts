/**
 * Phase 3 test — RedisFreshnessIndex encoding + unit tests.
 *
 * Validates:
 * - encodeMember/decodeMember JSON roundtrip (including special chars)
 * - decodeMember rejects malformed input
 * - WitnessKind is preserved through encode/decode (not lost to "custom")
 *
 * Redis integration tests are skipped when no Redis is available (same
 * pattern as redis-checkpointer.test.ts).
 */

import { describe, it, expect } from "bun:test";
import { N, R } from "./_id-helpers.js";
import {
  __testEncodeMember,
  __testDecodeMember,
} from "../checkpoint/redis-freshness-index.js";

const encode = __testEncodeMember;
const decode = __testDecodeMember;

describe("RedisFreshnessIndex encoding", () => {
  it("roundtrips basic values", () => {
    const member = encode(R("run-1"), N("writer"), "version", "42");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.runId).toBe(R("run-1"));
    expect(decoded!.nodeId).toBe(N("writer"));
    expect(decoded!.witnessKind).toBe("version");
    expect(decoded!.witnessValue).toBe("42");
  });

  it("preserves WitnessKind through roundtrip", () => {
    const kinds = ["version", "etag", "timestamp", "lsn", "idempotency-key", "custom"] as const;
    for (const kind of kinds) {
      const member = encode(R("r"), N("n"), kind, "val");
      const decoded = decode(member);
      expect(decoded).not.toBeNull();
      expect(decoded!.witnessKind).toBe(kind);
    }
  });

  it("handles witness values containing pipe characters", () => {
    const member = encode(R("r"), N("n"), "etag", "abc|def|ghi");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessValue).toBe("abc|def|ghi");
  });

  it("handles witness values containing colons", () => {
    const member = encode(R("r"), N("n"), "etag", "W/\"abc:123\"");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessValue).toBe("W/\"abc:123\"");
  });

  it("handles witness values containing JSON special chars", () => {
    const member = encode(R("r"), N("n"), "custom", '{"key":"val\\nue"}');
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessValue).toBe('{"key":"val\\nue"}');
  });

  it("handles empty witness value", () => {
    const member = encode(R("r"), N("n"), "version", "");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessValue).toBe("");
  });

  it("handles unicode witness values", () => {
    const member = encode(R("r"), N("n"), "custom", "日本語テスト🎉");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessValue).toBe("日本語テスト🎉");
  });
});

describe("RedisFreshnessIndex decodeMember — rejection", () => {
  it("returns null for empty string", () => {
    expect(decode("")).toBeNull();
  });

  it("returns null for non-JSON string", () => {
    expect(decode("not-json")).toBeNull();
  });

  it("returns null for JSON object (not array)", () => {
    expect(decode('{"a":1}')).toBeNull();
  });

  it("returns null for JSON array with wrong length", () => {
    expect(decode('["a","b"]')).toBeNull();
    expect(decode('["a","b","c","d","e"]')).toBeNull();
  });

  it("returns null for JSON number", () => {
    expect(decode("42")).toBeNull();
  });
});
