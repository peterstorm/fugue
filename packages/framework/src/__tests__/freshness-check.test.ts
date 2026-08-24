/**
 * Phase 3 test — freshness-check pure module.
 *
 * Validates:
 * - `checkFreshness` detects conflicts when conditionedOn is stale.
 * - `checkFreshness` returns no conflicts when conditionedOn matches latest.
 * - `InMemoryFreshnessIndex` findConflict returns correct results.
 */

import { describe, it, expect } from "bun:test";
import { N, R, D } from "./_id-helpers.js";
import { checkFreshness, InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import { FE, mkWitness } from "./_freshness-helpers.js";
import { unwrap } from "../types/result.js";
import { freshnessWriteIdentityOf } from "../types/freshness.js";

describe("checkFreshness — pure conflict detection", () => {
  it("returns empty conflicts when no writes exist", () => {
    const result = checkFreshness([], []);
    expect(result.conflicts).toHaveLength(0);
  });

  it("returns empty conflicts when single write matches conditioned-on", () => {
    const write: WriteAttemptedEvent = {
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d1"),
      nodeId: N("writer"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "42"),
      newWitness: mkWitness("postgres:orders", "43"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    };

    const result = checkFreshness([], [write]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("detects conflict when second write is conditioned on stale witness", () => {
    const write1: WriteAttemptedEvent = {
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d1"),
      nodeId: N("writer-1"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "42"),
      newWitness: mkWitness("postgres:orders", "43"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    };

    const write2: WriteAttemptedEvent = {
      type: "write-attempted",
      runId: R("r2"),
      dagId: D("d1"),
      nodeId: N("writer-2"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "42"), // stale!
      newWitness: mkWitness("postgres:orders", "44"),
      succeededAtMs: 2000,
      timestamp: new Date(2000),
    };

    const result = checkFreshness([], [write1, write2]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.writeNodeId).toBe(N("writer-2"));
    expect(result.conflicts[0]!.conditionedOnWitness.value).toBe("42");
    expect(result.conflicts[0]!.conflictingWrite.newWitness.value).toBe("43");
    expect(result.conflicts[0]!.conflictingWrite.runId).toBe(R("r1"));
  });

  it("no conflict when different resources", () => {
    const write1: WriteAttemptedEvent = {
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d1"),
      nodeId: N("writer-1"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "42"),
      newWitness: mkWitness("postgres:orders", "43"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    };

    const write2: WriteAttemptedEvent = {
      type: "write-attempted",
      runId: R("r2"),
      dagId: D("d1"),
      nodeId: N("writer-2"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:users", "1"), // different resource
      newWitness: mkWitness("postgres:users", "2"),
      succeededAtMs: 2000,
      timestamp: new Date(2000),
    };

    const result = checkFreshness([], [write1, write2]);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("InMemoryFreshnessIndex", () => {
  it("findConflict returns null when no writes recorded", async () => {
    const index = new InMemoryFreshnessIndex();
    expect(unwrap(await index.findConflict(mkWitness("postgres:orders", "42"), 0))).toBeNull();
  });

  it("findConflict returns null when conditioned value matches latest write", async () => {
    const index = new InMemoryFreshnessIndex();
    await index.recordWrite({
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d"),
      nodeId: N("w"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "41"),
      newWitness: mkWitness("postgres:orders", "42"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    });

    // Conditioned on "42" which matches the latest write
    expect(unwrap(await index.findConflict(mkWitness("postgres:orders", "42"), 0))).toBeNull();
  });

  it("findConflict returns conflicting write entry", async () => {
    const index = new InMemoryFreshnessIndex();
    await index.recordWrite({
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d"),
      nodeId: N("w"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "41"),
      newWitness: mkWitness("postgres:orders", "42"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    });

    // Conditioned on "41" but the latest write produced "42"
    const conflict = unwrap(await index.findConflict(mkWitness("postgres:orders", "41"), 0));
    expect(conflict).not.toBeNull();
    expect(conflict!.newWitness.value).toBe("42");
    expect(conflict!.runId).toBe(R("r1"));
  });

  it("findConflict respects sinceMs threshold", async () => {
    const index = new InMemoryFreshnessIndex();
    await index.recordWrite({
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d"),
      nodeId: N("w"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "41"),
      newWitness: mkWitness("postgres:orders", "42"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    });

    // sinceMs=2000 should not see the write at 1000
    expect(unwrap(await index.findConflict(mkWitness("postgres:orders", "41"), 2000))).toBeNull();

    // sinceMs=500 should see it
    expect(unwrap(await index.findConflict(mkWitness("postgres:orders", "41"), 500))).not.toBeNull();
  });

  it("selects the timestamp-latest write when callbacks arrive out of order", async () => {
    const index = new InMemoryFreshnessIndex();
    const newer: WriteAttemptedEvent = {
      type: "write-attempted",
      runId: R("newer"),
      dagId: D("d"),
      nodeId: N("newer-writer"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "41"),
      newWitness: mkWitness("postgres:orders", "43"),
      succeededAtMs: 2000,
      timestamp: new Date(2000),
    };
    const older: WriteAttemptedEvent = {
      ...newer,
      runId: R("older"),
      nodeId: N("older-writer"),
      newWitness: mkWitness("postgres:orders", "42"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    };

    await index.recordWrite(newer);
    await index.recordWrite(older);

    const conflict = unwrap(await index.findConflict(mkWitness("postgres:orders", "41"), 1500));
    expect(conflict?.runId).toBe(R("newer"));
    expect(conflict?.succeededAtMs).toBe(2000);
    expect(unwrap(await index.findConflict(mkWitness("postgres:orders", "43"), 0))).toBeNull();
  });

  it("evicts acknowledgement identities with the bounded write window", async () => {
    const index = new InMemoryFreshnessIndex({ maxEntriesPerResource: 2 });
    const event = (sequence: number): WriteAttemptedEvent => ({
      type: "write-attempted",
      runId: R(`r${sequence}`),
      dagId: D("d"),
      nodeId: N(`w${sequence}`),
      executionEpoch: FE(sequence),
      conditionedOn: mkWitness("postgres:orders", String(sequence)),
      newWitness: mkWitness("postgres:orders", String(sequence + 1)),
      succeededAtMs: sequence,
      timestamp: new Date(sequence),
    });
    const oldest = event(1);
    const retained = [event(2), event(3)] as const;

    await index.recordWrite(oldest);
    for (const write of retained) await index.recordWrite(write);

    expect(unwrap(await index.hasRecordedWrite(freshnessWriteIdentityOf(oldest)))).toBe(false);
    for (const write of retained) {
      expect(unwrap(await index.hasRecordedWrite(freshnessWriteIdentityOf(write)))).toBe(true);
    }
  });

  it("clear empties the index", async () => {
    const index = new InMemoryFreshnessIndex();
    await index.recordWrite({
      type: "write-attempted",
      runId: R("r1"),
      dagId: D("d"),
      nodeId: N("w"),
      executionEpoch: FE(),
      conditionedOn: mkWitness("postgres:orders", "41"),
      newWitness: mkWitness("postgres:orders", "42"),
      succeededAtMs: 1000,
      timestamp: new Date(1000),
    });

    index.clear();
    expect(unwrap(await index.findConflict(mkWitness("postgres:orders", "41"), 0))).toBeNull();
  });
});
