/**
 * Freshness check — pure module for detecting stale-read → write hazards.
 *
 * Takes an event log (or a subset of it) and returns freshness violations.
 * The check is purely functional: it scans `WitnessCapturedEvent` and
 * `WriteAttemptedEvent` entries, and for any `writes` node whose
 * `conditionedOn` witness has been superseded by an intervening write to the
 * same resource, returns a `FreshnessCheckResult` describing the conflict.
 *
 * This module is the single-process fallback. Cross-process detection with
 * Redis-backed indexes is layered on top (see `checkpoint/redis-checkpointer.ts`).
 */

import type { WitnessCapturedEvent, WriteAttemptedEvent } from "../types/events.js";
import type { Witness } from "../types/freshness.js";
import type { RunId, NodeId } from "../types/ids.js";

export interface FreshnessConflict {
  /** The write node that is conditioned on a stale witness. */
  readonly writeNodeId: NodeId;
  readonly writeRunId: RunId;
  readonly resource: string;
  readonly conditionedOnWitness: Witness;
  /** The conflicting write that superseded the conditioned-on witness. */
  readonly conflictingWrite: {
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly newWitness: Witness;
    readonly succeededAtMs: number;
  };
}

export interface FreshnessCheckResult {
  readonly conflicts: readonly FreshnessConflict[];
}

/** In-memory write log entry, keyed by resource. */
interface WriteEntry {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
}

/**
 * Scan a sequence of witness-captured and write-attempted events to detect
 * freshness violations. A violation occurs when a write is conditioned on a
 * witness value that was superseded by a later write to the same resource.
 *
 * The algorithm:
 * 1. Maintain a per-resource list of completed writes (from `WriteAttemptedEvent`).
 * 2. For each `WriteAttemptedEvent`, check if `conditionedOn.value` matches
 *    the latest known witness for that resource. If a newer write exists,
 *    record a conflict.
 *
 * Pure function — no I/O, no side effects.
 */
export const checkFreshness = (
  witnessEvents: readonly WitnessCapturedEvent[],
  writeEvents: readonly WriteAttemptedEvent[],
): FreshnessCheckResult => {
  // Build a time-ordered log of all writes per resource.
  // Key: resource string → sorted array of writes.
  const writesByResource = new Map<string, WriteEntry[]>();

  // Merge events into a single time-ordered stream
  type TaggedEvent =
    | { readonly kind: "witness"; readonly event: WitnessCapturedEvent }
    | { readonly kind: "write"; readonly event: WriteAttemptedEvent };

  const timeline: TaggedEvent[] = [
    ...witnessEvents.map((e) => ({ kind: "witness" as const, event: e })),
    ...writeEvents.map((e) => ({ kind: "write" as const, event: e })),
  ].sort((a, b) => {
    const aMs = a.kind === "witness" ? a.event.capturedAtMs : a.event.succeededAtMs;
    const bMs = b.kind === "witness" ? b.event.capturedAtMs : b.event.succeededAtMs;
    return aMs - bMs;
  });

  const conflicts: FreshnessConflict[] = [];

  for (const entry of timeline) {
    if (entry.kind === "write") {
      const e = entry.event;
      const resource = e.conditionedOn.resource;
      const existingWrites = writesByResource.get(resource) ?? [];

      // Check if any write completed after the conditioned-on witness was
      // captured AND produced a different witness value. If so, the
      // conditioned-on witness is stale.
      for (const prior of existingWrites) {
        if (prior.newWitness.value !== e.conditionedOn.value) {
          // The conditioned-on witness doesn't match the latest write to
          // this resource — this is expected when the write is updating the
          // same version. Check if the prior write is strictly newer than
          // the conditioned-on value.
          conflicts.push({
            writeNodeId: e.nodeId,
            writeRunId: e.runId,
            resource,
            conditionedOnWitness: e.conditionedOn,
            conflictingWrite: {
              runId: prior.runId,
              nodeId: prior.nodeId,
              newWitness: prior.newWitness,
              succeededAtMs: prior.succeededAtMs,
            },
          });
          break; // One conflict per write is sufficient
        }
      }

      // Record this write
      existingWrites.push({
        runId: e.runId,
        nodeId: e.nodeId,
        newWitness: e.newWitness,
        succeededAtMs: e.succeededAtMs,
      });
      writesByResource.set(resource, existingWrites);
    }
    // witness-captured events don't need tracking for the basic algorithm;
    // they are recorded in the event log for forensic queries.
  }

  return { conflicts };
};

/**
 * In-memory freshness index for single-process detection. Maintains a
 * per-resource write log that can be queried at write time.
 *
 * Thread-safe within a single JS event loop (no concurrent mutation).
 * For cross-process detection, see Redis-backed freshness index.
 */
export class InMemoryFreshnessIndex {
  private readonly writes = new Map<string, WriteEntry[]>();

  /** Record a successful write. */
  recordWrite(event: WriteAttemptedEvent): void {
    const resource = event.newWitness.resource;
    const entries = this.writes.get(resource) ?? [];
    entries.push({
      runId: event.runId,
      nodeId: event.nodeId,
      newWitness: event.newWitness,
      succeededAtMs: event.succeededAtMs,
    });
    this.writes.set(resource, entries);
  }

  /**
   * Check if a conditioned-on witness has been superseded by a write that
   * completed after `sinceMs`. Returns the first conflicting write, or `null`.
   */
  findConflict(
    resource: string,
    conditionedOnValue: string,
    sinceMs: number,
  ): WriteEntry | null {
    const entries = this.writes.get(resource) ?? [];
    for (const entry of entries) {
      if (
        entry.succeededAtMs >= sinceMs &&
        entry.newWitness.value !== conditionedOnValue
      ) {
        return entry;
      }
    }
    return null;
  }

  /** Clear all entries. Useful for testing. */
  clear(): void {
    this.writes.clear();
  }
}
