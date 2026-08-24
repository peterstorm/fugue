import { FE, mkWitness } from "./_freshness-helpers.js";
/**
 * Tests for the FreshnessIndex Result-typed interface.
 *
 * Validates:
 * - InMemoryFreshnessIndex.recordWrite returns ok(undefined)
 * - InMemoryFreshnessIndex.findConflict returns ok(null) / ok(entry)
 * - O(1) amortized eviction with cursor-based approach
 */

import { describe, it, expect } from "bun:test";
import { N, R, D } from "./_id-helpers.js";
import { InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import { isOk, unwrap } from "../types/result.js";

const mkWriteEvent = (
  runId: string,
  nodeId: string,
  resource: string,
  conditionedOnValue: string,
  newValue: string,
  succeededAtMs: number,
): WriteAttemptedEvent => ({
  type: "write-attempted",
  runId: R(runId),
  dagId: D("d"),
  nodeId: N(nodeId),
  executionEpoch: FE(),
  conditionedOn: mkWitness(resource, conditionedOnValue),
  newWitness: mkWitness(resource, newValue),
  succeededAtMs,
  timestamp: new Date(succeededAtMs),
});

describe("InMemoryFreshnessIndex — Result interface", () => {
  it("recordWrite returns ok(undefined)", async () => {
    const index = new InMemoryFreshnessIndex();
    const result = await index.recordWrite(
      mkWriteEvent("r1", "w", "pg:orders", "1", "2", 1000),
    );
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toBeUndefined();
  });

  it("findConflict returns ok(null) when no writes", async () => {
    const index = new InMemoryFreshnessIndex();
    const result = await index.findConflict(mkWitness("pg:orders", "1"), 0);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toBeNull();
  });

  it("findConflict returns ok(entry) when conflict exists", async () => {
    const index = new InMemoryFreshnessIndex();
    await index.recordWrite(mkWriteEvent("r1", "w", "pg:orders", "1", "2", 1000));
    const result = await index.findConflict(mkWitness("pg:orders", "1"), 0);
    expect(isOk(result)).toBe(true);
    const conflict = unwrap(result);
    expect(conflict).not.toBeNull();
    expect(conflict!.newWitness.value).toBe("2");
  });

  it("eviction with cursor: maxResources cap works", async () => {
    const index = new InMemoryFreshnessIndex({ maxResources: 3, maxEntriesPerResource: 10 });
    // Write 4 resources — first should be evicted
    for (let i = 0; i < 4; i++) {
      await index.recordWrite(
        mkWriteEvent("r1", "w", `resource-${i}`, "0", "1", 1000 + i),
      );
    }
    // resource-0 should have been evicted
    const r0 = unwrap(await index.findConflict(mkWitness("resource-0", "0"), 0));
    expect(r0).toBeNull(); // evicted, so no conflict data

    // resource-3 should still be present
    const r3 = unwrap(await index.findConflict(mkWitness("resource-3", "0"), 0));
    expect(r3).not.toBeNull();
  });

  it("clear resets cursor", async () => {
    const index = new InMemoryFreshnessIndex({ maxResources: 2 });
    await index.recordWrite(mkWriteEvent("r1", "w", "a", "0", "1", 1000));
    await index.recordWrite(mkWriteEvent("r1", "w", "b", "0", "1", 2000));
    index.clear();
    // After clear, can add resources again without hitting cursor issues
    await index.recordWrite(mkWriteEvent("r1", "w", "c", "0", "1", 3000));
    const result = unwrap(await index.findConflict(mkWitness("c", "0"), 0));
    expect(result).not.toBeNull();
  });
});
