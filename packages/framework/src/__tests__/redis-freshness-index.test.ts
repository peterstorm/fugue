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

import { afterEach, describe, it, expect } from "bun:test";
import fc from "fast-check";
import { D, N, R } from "./_id-helpers.js";
import { FE } from "./_freshness-helpers.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";

afterEach(() => __resetFrameworkLogger());
import {
  __testEncodeMember,
  __testDecodeMember,
} from "../checkpoint/redis-freshness-index.js";

const encode = (
  run: Parameters<typeof __testEncodeMember>[0],
  node: Parameters<typeof __testEncodeMember>[1],
  kind: Parameters<typeof __testEncodeMember>[3],
  value: Parameters<typeof __testEncodeMember>[4],
): string => __testEncodeMember(run, node, FE(), kind, value);
const decode = __testDecodeMember;
const validEpoch = freshnessExecutionEpochMember(FE());

describe("RedisFreshnessIndex encoding", () => {
  it("roundtrips basic values", () => {
    const member = encode(R("run-1"), N("writer"), "version", "42");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.runId).toBe(R("run-1"));
    expect(decoded!.nodeId).toBe(N("writer"));
    expect(decoded!.executionEpoch).toBe(FE());
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
    expect(decode(JSON.stringify(["r", "n", validEpoch, "version", ""]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", validEpoch, "version", null]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", validEpoch, "version", 42]))).toBeNull();
  });

  it("handles unicode witness values", () => {
    const member = encode(R("r"), N("n"), "custom", "日本語テスト🎉");
    const decoded = decode(member);
    expect(decoded).not.toBeNull();
    expect(decoded!.witnessValue).toBe("日本語テスト🎉");
  });

  it("orders epoch 10 after epoch 9 at equal scores", () => {
    const epoch9 = __testEncodeMember(R("r"), N("n"), FE(9), "version", "v");
    const epoch10 = __testEncodeMember(R("r"), N("n"), FE(10), "version", "v");
    expect(compareFreshnessMemberKeys(epoch9, epoch10)).toBeLessThan(0);
    expect(decode(epoch10)?.executionEpoch).toBe(FE(10));
  });

  it("property: member byte order agrees with numeric execution-epoch order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (left, right) => {
          const leftKey = __testEncodeMember(R("r"), N("n"), FE(left), "version", "v");
          const rightKey = __testEncodeMember(R("r"), N("n"), FE(right), "version", "v");
          expect(Math.sign(compareFreshnessMemberKeys(leftKey, rightKey))).toBe(
            Math.sign(left - right),
          );
        },
      ),
    );
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
    expect(decode('["a","b","c","d","e","f"]')).toBeNull();
  });

  it("returns null for JSON number", () => {
    expect(decode("42")).toBeNull();
  });

  // Round-18 tda-2: persisted bytes are untrusted — an off-contract kind
  // must not flow into conflict decisions. Unknown kinds are corrupt entries
  // (null), exactly like shape failures.
  it("returns null for invalid runId or nodeId fields", () => {
    for (const [runId, nodeId] of [
      ["", "n"],
      ["contains spaces", "n"],
      [42, "n"],
      ["r", ""],
      ["r", "contains spaces"],
      ["r", null],
    ] as const) {
      expect(decode(JSON.stringify([runId, nodeId, validEpoch, "version", "v"]))).toBeNull();
    }
  });

  it("returns null for an off-contract witnessKind (closed-union gate)", () => {
    expect(decode(JSON.stringify(["r", "n", validEpoch, "bogus-kind", "v"]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", validEpoch, "", "v"]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", validEpoch, 42, "v"]))).toBeNull();
    expect(decode(JSON.stringify(["r", "n", "-000000000000000001", "version", "v"]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findConflict corrupt-member verdict (round-21 sfh-2) — an undecodable
// LATEST member must fail CLOSED (ADR-0025): the caller aborts the wave
// rather than proceeding without conflict detection. Only the methods the
// class touches on this path are faked.
// ---------------------------------------------------------------------------

import { RedisFreshnessIndex } from "../checkpoint/redis-freshness-index.js";
import {
  compareFreshnessMemberKeys,
  FRESHNESS_TTL_SECONDS,
  freshnessExecutionEpochMember,
  freshnessWriteIdentityOf,
  witness,
  resourceName,
} from "../types/freshness.js";

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

describe("RedisFreshnessIndex recordWrite — atomic TTL contract", () => {
  it("loads and executes the atomic ZADD+EXPIRE script with the port TTL", async () => {
    const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
    const redis = {
      script: async (...args: unknown[]) => {
        calls.push({ method: "script", args });
        return "sha-1";
      },
      evalsha: async (...args: unknown[]) => {
        calls.push({ method: "evalsha", args });
        return 1;
      },
    } as unknown as ConstructorParameters<typeof RedisFreshnessIndex>[0];
    const index = new RedisFreshnessIndex(redis);

    const result = await index.recordWrite({
      type: "write-attempted",
      runId: R("run-ttl"),
      dagId: D("dag-ttl"),
      nodeId: N("writer"),
      executionEpoch: FE(),
      conditionedOn: witness("version", resourceName("postgres:orders"), "41"),
      newWitness: witness("version", resourceName("postgres:orders"), "42"),
      succeededAtMs: 1234,
      timestamp: new Date(1234),
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls[0]?.method).toBe("script");
    expect(calls[0]?.args[0]).toBe("LOAD");
    expect(calls[0]?.args[1]).toContain('redis.call("EXPIRE"');
    expect(calls[1]).toEqual({
      method: "evalsha",
      args: [
        "sha-1",
        1,
        "fugue:freshness:postgres:orders",
        "1234",
        encode(R("run-ttl"), N("writer"), "version", "42"),
        String(FRESHNESS_TTL_SECONDS),
      ],
    });
    expect(index.consecutiveFailures).toBe(0);
  });
});

describe("RedisFreshnessIndex logical-write acknowledgement", () => {
  it("queries the exact member without conflating it with the latest conflict", async () => {
    const calls: unknown[][] = [];
    const index = new RedisFreshnessIndex({
      zscore: async (...args: unknown[]) => {
        calls.push(args);
        return "900";
      },
    } as unknown as ConstructorParameters<typeof RedisFreshnessIndex>[0]);
    const event = {
      type: "write-attempted" as const,
      runId: R("run-ack"),
      dagId: D("dag-ack"),
      nodeId: N("writer"),
      executionEpoch: FE(10),
      conditionedOn: witness("version", resourceName("res:ack"), "1"),
      newWitness: witness("version", resourceName("res:ack"), "2"),
      succeededAtMs: 900,
      timestamp: new Date(900),
    };

    expect(await index.hasRecordedWrite(freshnessWriteIdentityOf(event))).toEqual({
      ok: true,
      value: true,
    });
    expect(calls).toEqual([
      ["fugue:freshness:res:ack", __testEncodeMember(R("run-ack"), N("writer"), FE(10), "version", "2")],
    ]);
  });
});

describe("RedisFreshnessIndex findConflict — corrupt-member verdict (ADR-0025)", () => {
  it("preserves the typed freshness failure when the degradation logger throws", async () => {
    setFrameworkLogger({
      debug() {},
      info() {},
      warn() { throw new Error("logger transport failed"); },
      error() {},
    });
    const redis = {
      zrevrangebyscore: async () => { throw new Error("redis unavailable"); },
    } as unknown as ConstructorParameters<typeof RedisFreshnessIndex>[0];
    const index = new RedisFreshnessIndex(redis);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await index.findConflict(
        witness("version", resourceName("res:logger-failure"), "1"),
        0,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("cache-error");
        if (result.error.kind === "cache-error") {
          expect(result.error.message).toContain("redis unavailable");
        }
      }
    }
    expect(index.consecutiveFailures).toBe(5);
  });

  it("contains hostile non-Error Redis rejections inside both Result-bearing methods", async () => {
    const hostile = Object.create(null);
    const recordIndex = new RedisFreshnessIndex({
      script: async () => { throw hostile; },
    } as unknown as ConstructorParameters<typeof RedisFreshnessIndex>[0]);
    const write = await recordIndex.recordWrite({
      type: "write-attempted",
      runId: R("run-hostile"),
      dagId: D("dag-hostile"),
      nodeId: N("writer"),
      executionEpoch: FE(),
      conditionedOn: witness("version", resourceName("res:hostile"), "1"),
      newWitness: witness("version", resourceName("res:hostile"), "2"),
      succeededAtMs: 1,
      timestamp: new Date(1),
    });

    const conflictIndex = new RedisFreshnessIndex({
      zrevrangebyscore: async () => { throw hostile; },
    } as unknown as ConstructorParameters<typeof RedisFreshnessIndex>[0]);
    const conflict = await conflictIndex.findConflict(
      witness("version", resourceName("res:hostile"), "1"),
      0,
    );

    for (const result of [write, conflict]) {
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "cache-error") {
        expect(typeof result.error.message).toBe("string");
      }
    }
    expect(recordIndex.lastError).toBeInstanceOf(Error);
    expect(conflictIndex.lastError).toBeInstanceOf(Error);
    expect(typeof recordIndex.lastError?.message).toBe("string");
    expect(typeof conflictIndex.lastError?.message).toBe("string");
  });

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
      JSON.stringify(["run-9", "writer", validEpoch, "bogus-kind", "v"]),
      JSON.stringify(["run-9", "writer", validEpoch, "version", ""]),
      JSON.stringify(["run-9", "writer", validEpoch, "version", null]),
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
    const member = encode(R("run-9"), N("writer"), "version", "1");
    const { redis } = fakeFindConflictRedis([member, "900"]);
    const index = new RedisFreshnessIndex(redis);

    // Same witness value as conditioned-on → no conflict, verified verdict.
    const result = await index.findConflict(witness("version", resourceName("res:b"), "1"), 0);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("returns the conflicting write when the latest member decodes to a different value", async () => {
    const member = encode(R("run-9"), N("writer"), "version", "2");
    const { redis } = fakeFindConflictRedis([member, "900"]);
    const index = new RedisFreshnessIndex(redis);

    const result = await index.findConflict(witness("version", resourceName("res:c"), "1"), 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value?.runId).toBe(R("run-9"));
      expect(result.value?.executionEpoch).toBe(FE());
      expect(result.value?.succeededAtMs).toBe(900);
    }
  });
});
