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

  it("rejects empty and non-string witness values from persisted bytes", () => {
    expect(decode(JSON.stringify(["r", "n", "version", ""]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", "version", null]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", "version", 42]))).toBeNull();
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

  // Round-18 tda-2: persisted bytes are untrusted — an off-contract kind
  // must not flow into conflict decisions. Unknown kinds are corrupt entries
  // (null), exactly like shape failures.
  it("returns null for an off-contract witnessKind (closed-union gate)", () => {
    expect(decode(JSON.stringify(["r", "n", "bogus-kind", "v"]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", "", "v"]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", 42, "v"]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findConflict corrupt-member verdict (round-21 sfh-2) — an undecodable
// LATEST member must fail CLOSED (ADR-0025): the caller aborts the wave
// rather than proceeding without conflict detection. Only the methods the
// class touches on this path are faked.
// ---------------------------------------------------------------------------

import { RedisFreshnessIndex } from "../checkpoint/redis-freshness-index.js";
import { witness, resourceName } from "../types/freshness.js";

const fakeFindConflictRedis = (members: readonly string[]): {
  redis: ConstructorParameters<typeof RedisFreshnessIndex>[0];
  state: { calls: number };
} => {
  const state = { calls: 0 };
  const redis = {
    zrevrangebyscore: async () => {
      state.calls += 1;
      return [...members];
    },
  };
  return { redis: redis as unknown as ConstructorParameters<typeof RedisFreshnessIndex>[0], state };
};

describe("RedisFreshnessIndex findConflict — corrupt-member verdict (ADR-0025)", () => {
  it("fails closed on an undecodable (non-JSON) latest member instead of returning ok(null)", async () => {
    const { redis, state } = fakeFindConflictRedis(["not-json", "900"]);
    const index = new RedisFreshnessIndex(redis);

    const result = await index.findConflict(witness("version", resourceName("res:orders"), "1"), 0);
    expect(state.calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fail-closed rejection");
    expect(result.error.kind).toBe("cache-error");
    if (result.error.kind === "cache-error") {
      expect(result.error.operation).toBe("freshness:findConflict");
      expect(result.error.failureClass).toBe("permanent");
      expect(result.error.message).toContain("res:orders");
      expect(result.error.message).toContain("corrupt/undecodable");
    }
    // The failure is observable on the port's instrumentation surface.
    expect(index.consecutiveFailures).toBe(1);
  });

  it("fails closed on off-contract kind or witness-value members", async () => {
    const corruptMembers = [
      JSON.stringify(["run-9", "writer", "bogus-kind", "v"]),
      JSON.stringify(["run-9", "writer", "version", ""]),
      JSON.stringify(["run-9", "writer", "version", null]),
    ];

    for (const corruptMember of corruptMembers) {
      const { redis } = fakeFindConflictRedis([corruptMember, "900"]);
      const index = new RedisFreshnessIndex(redis);
      const result = await index.findConflict(witness("version", resourceName("res:a"), "1"), 0);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a fail-closed rejection");
      expect(result.error.kind).toBe("cache-error");
      if (result.error.kind === "cache-error") {
        expect(result.error.operation).toBe("freshness:findConflict");
        expect(result.error.message).toContain("res:a");
      }
    }
  });

  it("still returns ok(null) when the latest member decodes and does not conflict", async () => {
    const member = __testEncodeMember(R("run-9"), N("writer"), "version", "1");
    const { redis } = fakeFindConflictRedis([member, "900"]);
    const index = new RedisFreshnessIndex(redis);

    // Same witness value as conditioned-on → no conflict, verified verdict.
    const result = await index.findConflict(witness("version", resourceName("res:b"), "1"), 0);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("returns the conflicting write when the latest member decodes to a different value", async () => {
    const member = __testEncodeMember(R("run-9"), N("writer"), "version", "2");
    const { redis } = fakeFindConflictRedis([member, "900"]);
    const index = new RedisFreshnessIndex(redis);

    const result = await index.findConflict(witness("version", resourceName("res:c"), "1"), 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value?.runId).toBe(R("run-9"));
      expect(result.value?.succeededAtMs).toBe(900);
    }
  });
});
