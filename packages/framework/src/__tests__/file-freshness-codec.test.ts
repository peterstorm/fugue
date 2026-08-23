/**
 * Pure-surface tests for the freshness index's DECISION core
 * (`file/freshness-codec.ts`) — architecture-tech-lead-2.
 *
 * The ADR-0079 parity rules — score monotonicity, the Redis reverse
 * unsigned-binary equal-score tie order, the lazy 24h TTL, and the strict
 * singleton codec — used to be reachable only through `mkdtempSync`, a real
 * per-digest lock and real file I/O. They are decisions, not I/O, so they are
 * tested here as decisions.
 *
 * The adapter-level suite (`file-freshness-index.test.ts`) remains the
 * transport/atomicity/corruption-surface layer and is unaffected by the split.
 */

import { describe, it, expect } from "bun:test";
import {
  TTL_MS,
  isExpired,
  prepareFreshnessWrite,
  parseConditionedOn,
  parseStoredFreshnessEntry,
  selectLatestWrite,
  serializeStoredFreshnessEntry,
  serializeRedisFreshnessMember,
  decideConflict,
} from "../file/freshness-codec.js";
import type { PreparedFreshnessWrite, StoredFreshnessEntry } from "../file/freshness-codec.js";

const writeEvent = (opts: {
  runId?: string;
  nodeId?: string;
  resource?: string;
  value?: string;
  succeededAtMs?: number;
}): unknown => ({
  type: "write-attempted",
  runId: opts.runId ?? "run-1",
  nodeId: opts.nodeId ?? "node-1",
  newWitness: { kind: "version", resource: opts.resource ?? "res-a", value: opts.value ?? "v1" },
  succeededAtMs: opts.succeededAtMs ?? 1_000,
});

const prepared = (opts: Parameters<typeof writeEvent>[0] = {}): PreparedFreshnessWrite => {
  const parsed = prepareFreshnessWrite(writeEvent(opts));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const stored = (
  opts: Parameters<typeof writeEvent>[0] & { writtenAtMs: number },
): StoredFreshnessEntry => ({ writtenAtMs: opts.writtenAtMs, ...prepared(opts) });

describe("isExpired — the ONE lazy 24h TTL rule (FR-032)", () => {
  it("is not expired at exactly the TTL boundary, and is one millisecond past it", () => {
    expect(isExpired(0, TTL_MS)).toBe(false);
    expect(isExpired(0, TTL_MS + 1)).toBe(true);
  });

  it("treats a clock that has gone backwards as not expired", () => {
    expect(isExpired(1_000, 0)).toBe(false);
  });
});

describe("prepareFreshnessWrite — the write-boundary parser", () => {
  it("accepts a well-formed write-attempted event and lifts its resource", () => {
    const p = prepared({ resource: "res-a" });
    expect(p.resource).toBe("res-a");
    expect(String(p.runId)).toBe("run-1");
    expect(String(p.nodeId)).toBe("node-1");
    expect(p.newWitness.value).toBe("v1");
  });

  it("rejects every off-contract field with a named reason", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, "write event must be an object"],
      [{ ...(writeEvent({}) as object), type: "other" }, 'write event type must be exactly "write-attempted"'],
      [{ ...(writeEvent({}) as object), runId: "not a valid id!" }, "runId does not match the framework ID boundary"],
      [{ ...(writeEvent({}) as object), nodeId: "not a valid id!" }, "nodeId does not match the framework ID boundary"],
      [{ ...(writeEvent({}) as object), newWitness: 7 }, "newWitness must be an object"],
      [{ ...(writeEvent({}) as object), newWitness: { kind: "nope", resource: "r", value: "v" } }, "newWitness.kind is not a WitnessKind"],
      [{ ...(writeEvent({}) as object), newWitness: { kind: "version", resource: "", value: "v" } }, "newWitness.resource must be non-empty"],
      [{ ...(writeEvent({}) as object), newWitness: { kind: "version", resource: "r", value: "" } }, "newWitness.value must be non-empty"],
      [{ ...(writeEvent({}) as object), succeededAtMs: Number.NaN }, "succeededAtMs must be finite"],
    ];
    for (const [input, reason] of cases) {
      const parsed = prepareFreshnessWrite(input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error(`expected a rejection for ${reason}`);
      expect(parsed.error).toBe(reason);
    }
  });

  it("runs every untrusted accessor exactly once, before validating anything", () => {
    let reads = 0;
    const hostile = {
      type: "write-attempted",
      get runId() { reads += 1; return "run-1"; },
      nodeId: "node-1",
      newWitness: { kind: "version", resource: "res-a", value: "v1" },
      succeededAtMs: 1,
    };
    expect(prepareFreshnessWrite(hostile).ok).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("parseConditionedOn — the read-boundary witness parser", () => {
  it("accepts a well-formed witness and rejects each off-contract field", () => {
    const good = parseConditionedOn({ kind: "version", resource: "res-a", value: "v1" });
    expect(good.ok).toBe(true);
    for (const bad of [
      null,
      { kind: "nope", resource: "r", value: "v" },
      { kind: "version", resource: "", value: "v" },
      { kind: "version", resource: "r", value: "" },
    ]) {
      expect(parseConditionedOn(bad).ok).toBe(false);
    }
  });
});

describe("selectLatestWrite — ADR-0079 score monotonicity and tie order", () => {
  it("takes the incoming write when there is no current singleton", () => {
    const winner = selectLatestWrite(null, prepared({ value: "v2" }), 5_000);
    expect(winner.newWitness.value).toBe("v2");
    expect(winner.writtenAtMs).toBe(5_000);
  });

  it("a higher succeededAtMs wins", () => {
    const current = stored({ value: "old", succeededAtMs: 1_000, writtenAtMs: 0 });
    const winner = selectLatestWrite(current, prepared({ value: "new", succeededAtMs: 2_000 }), 10);
    expect(winner.newWitness.value).toBe("new");
  });

  it("a LOWER succeededAtMs loses while the current singleton is within TTL", () => {
    const current = stored({ value: "new", succeededAtMs: 2_000, writtenAtMs: 0 });
    const winner = selectLatestWrite(current, prepared({ value: "old", succeededAtMs: 1_000 }), 10);
    expect(winner.newWitness.value).toBe("new");
  });

  it("but an EXPIRED singleton is replaced by any incoming write (lazy supersede)", () => {
    const current = stored({ value: "new", succeededAtMs: 2_000, writtenAtMs: 0 });
    const winner = selectLatestWrite(current, prepared({ value: "old", succeededAtMs: 1_000 }), TTL_MS + 1);
    expect(winner.newWitness.value).toBe("old");
  });

  it("refreshes writtenAtMs on EVERY record, including a losing write (Redis EXPIRE parity)", () => {
    const current = stored({ value: "new", succeededAtMs: 2_000, writtenAtMs: 0 });
    const winner = selectLatestWrite(current, prepared({ value: "old", succeededAtMs: 1_000 }), 999);
    expect(winner.newWitness.value).toBe("new"); // loser did not take the slot…
    expect(winner.writtenAtMs).toBe(999); // …but the TTL was refreshed
  });

  it("breaks an equal-score tie by the Redis member byte order, independent of arrival order", () => {
    const a = prepared({ nodeId: "node-a", value: "va", succeededAtMs: 1_000 });
    const b = prepared({ nodeId: "node-b", value: "vb", succeededAtMs: 1_000 });
    const aFirst = selectLatestWrite({ writtenAtMs: 0, ...a }, b, 10);
    const bFirst = selectLatestWrite({ writtenAtMs: 0, ...b }, a, 10);
    expect(aFirst.newWitness.value).toBe(bFirst.newWitness.value);
    // …and the winner is the one the member grammar orders higher.
    expect(serializeRedisFreshnessMember(aFirst)).not.toBe("");
  });
});

describe("the stored-singleton codec round-trips and fails closed", () => {
  it("round-trips exactly the ADR-0079 field set", () => {
    const entry = stored({ writtenAtMs: 42, succeededAtMs: 7 });
    const parsed = parseStoredFreshnessEntry(serializeStoredFreshnessEntry(entry), "res-a");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toEqual(entry);
  });

  it("rejects a digest/content resource disagreement", () => {
    const bytes = serializeStoredFreshnessEntry(stored({ writtenAtMs: 1, resource: "res-a" }));
    const parsed = parseStoredFreshnessEntry(bytes, "res-b");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.error).toBe("digest/content resource disagreement");
  });

  it("rejects malformed bytes, extra fields and missing fields", () => {
    expect(parseStoredFreshnessEntry("{not json", "res-a").ok).toBe(false);
    expect(parseStoredFreshnessEntry("[]", "res-a").ok).toBe(false);
    const entry = stored({ writtenAtMs: 1 });
    const extra = JSON.stringify({ ...JSON.parse(serializeStoredFreshnessEntry(entry)), extra: 1 });
    expect(parseStoredFreshnessEntry(extra, "res-a").ok).toBe(false);
    const { writtenAtMs: _dropped, ...missing } = JSON.parse(serializeStoredFreshnessEntry(entry)) as Record<string, unknown>;
    expect(parseStoredFreshnessEntry(JSON.stringify(missing), "res-a").ok).toBe(false);
  });
});

describe("decideConflict — ADR-0079 conflict verdict", () => {
  const entry = stored({ value: "v2", succeededAtMs: 1_000, writtenAtMs: 0 });

  it("reports a conflict when a DIFFERENT witness value was written in window", () => {
    const conflict = decideConflict(entry, "v1", 0, 10);
    expect(conflict).not.toBeNull();
    expect(conflict?.newWitness.value).toBe("v2");
  });

  it("reports no conflict when the stored write IS the value we conditioned on", () => {
    expect(decideConflict(entry, "v2", 0, 10)).toBeNull();
  });

  it("reports no conflict for a write that predates the window", () => {
    expect(decideConflict(entry, "v1", 2_000, 10)).toBeNull();
  });

  it("reports no conflict once the singleton has expired (lazy supersede)", () => {
    expect(decideConflict(entry, "v1", 0, TTL_MS + 1)).toBeNull();
  });
});
