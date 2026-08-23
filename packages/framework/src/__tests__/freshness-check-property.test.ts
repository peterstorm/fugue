import { witness, witnessValue, stampWitness, RN } from "./_freshness-helpers.js";
/**
 * Phase 3 property test — freshness conflict detection.
 *
 * For any sequence of write events, the violation set computed by
 * `checkFreshness` equals the set computed by a naive reference
 * implementation. This pins the contract with fast-check.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { N, R, D } from "./_id-helpers.js";
import {
  checkFreshness,
  InMemoryFreshnessIndex,
} from "../dag-runtime/freshness-check.js";
import { unwrap } from "../types/result.js";
import type {
  WriteAttemptedEvent,
} from "../types/events.js";
import type { WitnessKind } from "../types/freshness.js";
import type { RunId, NodeId } from "../types/ids.js";

const arbWitnessKind = fc.constantFrom<WitnessKind>(
  "version",
  "etag",
  "timestamp",
  "lsn",
  "idempotency-key",
  "custom",
);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbResource = fc.constantFrom(
  "postgres:orders",
  "postgres:users",
  "stripe:charges",
);

const arbWitnessValue = fc.constantFrom("1", "2", "3", "4", "5");

const arbRunId = fc.integer({ min: 1, max: 10 }).map((n) => R(`r${n}`));
const arbNodeId = fc.integer({ min: 1, max: 5 }).map((n) => N(`w${n}`));

const arbWriteEvent = fc.record({
  runId: arbRunId,
  nodeId: arbNodeId,
  resource: arbResource,
  conditionedOnValue: arbWitnessValue,
  newWitnessValue: arbWitnessValue,
  succeededAtMs: fc.integer({ min: 1, max: 10_000 }),
});

type WriteSpec = {
  runId: RunId;
  nodeId: NodeId;
  resource: string;
  conditionedOnValue: string;
  newWitnessValue: string;
  succeededAtMs: number;
};

const toWriteAttemptedEvent = (spec: WriteSpec): WriteAttemptedEvent => ({
  type: "write-attempted",
  runId: spec.runId,
  dagId: D("d"),
  nodeId: spec.nodeId,
  conditionedOn: witness("version", RN(spec.resource), spec.conditionedOnValue),
  newWitness: witness("version", RN(spec.resource), spec.newWitnessValue),
  succeededAtMs: spec.succeededAtMs,
  timestamp: new Date(spec.succeededAtMs),
});

// ---------------------------------------------------------------------------
// Reference implementation — deliberately naive, used to verify checkFreshness
// ---------------------------------------------------------------------------

/**
 * Naive O(n²) reference: for each write (in time order), check if the latest
 * prior write to the same resource produced a different witness value than
 * what the current write is conditioned on. Only the latest prior write
 * matters — older writes may have values that were subsequently superseded.
 */
const referenceConflictCount = (
  events: readonly WriteAttemptedEvent[],
): number => {
  // Sort by time to process in order
  const sorted = [...events].sort(
    (a, b) => a.succeededAtMs - b.succeededAtMs,
  );
  // Track latest write per resource (by insertion order; same-timestamp
  // writes use last-seen, matching checkFreshness/InMemoryFreshnessIndex).
  const latestWriteByResource = new Map<string, WriteAttemptedEvent>();
  let conflicts = 0;

  for (const event of sorted) {
    const resource = event.conditionedOn.resource;
    const latest = latestWriteByResource.get(resource);

    if (latest && latest.newWitness.value !== event.conditionedOn.value) {
      conflicts++;
    }

    // Always update — for same-timestamp writes, last-seen wins
    latestWriteByResource.set(resource, event);
  }

  return conflicts;
};

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("freshness conflict detection — property tests (Phase 3)", () => {
  it("checkFreshness conflict count matches reference implementation", () => {
    fc.assert(
      fc.property(
        fc.array(arbWriteEvent, { minLength: 0, maxLength: 20 }),
        (specs) => {
          const events = specs.map(toWriteAttemptedEvent);
          const result = checkFreshness([], events);
          const expected = referenceConflictCount(events);
          return result.conflicts.length === expected;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("InMemoryFreshnessIndex agrees with checkFreshness for sequential writes", () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(arbWriteEvent, { minLength: 0, maxLength: 15 }),
        async (specs) => {
          // Sort by time so the index sees them in order
          const sorted = [...specs].sort(
            (a, b) => a.succeededAtMs - b.succeededAtMs,
          );
          const events = sorted.map(toWriteAttemptedEvent);

          // Use InMemoryFreshnessIndex to detect conflicts one-by-one
          const index = new InMemoryFreshnessIndex();
          let indexConflicts = 0;
          for (const event of events) {
            const conflict = unwrap(await index.findConflict(event.conditionedOn, 0));
            if (conflict) indexConflicts++;
            unwrap(await index.recordWrite(event));
          }

          // Use checkFreshness for the same set
          const batchResult = checkFreshness([], events);

          return indexConflicts === batchResult.conflicts.length;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("InMemoryFreshnessIndex selects the greatest timestamp regardless of arrival order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 9_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        fc.boolean(),
        async (olderAtMs, deltaMs, reverseArrival) => {
          const newerAtMs = olderAtMs + deltaMs;
          const older = toWriteAttemptedEvent({
            runId: R("older"),
            nodeId: N("older"),
            resource: "postgres:orders",
            conditionedOnValue: "0",
            newWitnessValue: "1",
            succeededAtMs: olderAtMs,
          });
          const newer = toWriteAttemptedEvent({
            runId: R("newer"),
            nodeId: N("newer"),
            resource: "postgres:orders",
            conditionedOnValue: "1",
            newWitnessValue: "2",
            succeededAtMs: newerAtMs,
          });
          const index = new InMemoryFreshnessIndex();
          const arrival = reverseArrival ? [newer, older] : [older, newer];
          for (const event of arrival) unwrap(await index.recordWrite(event));

          const conflict = unwrap(await index.findConflict(
            witness("version", RN("postgres:orders"), "0"),
            newerAtMs,
          ));
          return conflict?.runId === R("newer") && conflict.succeededAtMs === newerAtMs;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("stampWitness yields the stamped resource and preserves (kind, value) for any input", () => {
    // Exercises the new resource-free → stamp path directly (the conflict
    // properties above build full Witness events and never reach stampWitness).
    // For any (resource, kind, non-empty value), the framework stamps exactly
    // the given resource and leaves the author-supplied (kind, value) intact.
    fc.assert(
      fc.property(
        arbResource,
        arbWitnessKind,
        fc.string({ minLength: 1 }),
        (resource, kind, value) => {
          const stamped = stampWitness(RN(resource), witnessValue(kind, value));
          return (
            stamped.resource === RN(resource) &&
            stamped.kind === kind &&
            stamped.value === value
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("no conflicts when all writes to a resource are sequential and conditioned on latest", () => {
    fc.assert(
      fc.property(
        arbResource,
        fc.array(fc.integer({ min: 1, max: 100 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (resource, versions) => {
          // Build a chain: write v1→v2, then v2→v3, then v3→v4, ...
          const events: WriteAttemptedEvent[] = [];
          let currentVersion = 0;
          for (let i = 0; i < versions.length; i++) {
            const nextVersion = currentVersion + versions[i]!;
            events.push({
              type: "write-attempted",
              runId: R(`r${i}`),
              dagId: D("d"),
              nodeId: N(`w${i}`),
              conditionedOn: witness("version", RN(resource), String(currentVersion)),
              newWitness: witness("version", RN(resource), String(nextVersion)),
              succeededAtMs: (i + 1) * 1000,
              timestamp: new Date((i + 1) * 1000),
            });
            currentVersion = nextVersion;
          }

          const result = checkFreshness([], events);
          return result.conflicts.length === 0;
        },
      ),
      { numRuns: 200 },
    );
  });

});
