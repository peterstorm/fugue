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
 * Redis-backed indexes is layered on top (see `checkpoint/redis-freshness-index.ts`).
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

/** Write log entry, keyed by resource. Returned by freshness index lookups. */
export interface WriteEntry {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
}

// ---------------------------------------------------------------------------
// FreshnessIndex port
//
// Defines the contract for freshness-write tracking. The in-memory
// implementation is the default (single-process); a Redis-backed adapter
// enables cross-process detection (see checkpoint/redis-freshness-index.ts).
//
// Both methods return `Promise<...>`. The in-memory implementation uses
// trivially-async methods to satisfy the same interface as the Redis adapter
// without requiring callers to handle sync/async differently.
// ---------------------------------------------------------------------------

export interface FreshnessIndex {
  /** Record a successful write for future conflict detection. */
  recordWrite(event: WriteAttemptedEvent): Promise<void>;
  /**
   * Check if a conditioned-on witness has been superseded by a write that
   * completed after `sinceMs`. Returns the first conflicting write, or `null`.
   */
  findConflict(
    resource: string,
    conditionedOnValue: string,
    sinceMs: number,
  ): Promise<WriteEntry | null>;
}

/**
 * Scan a sequence of witness-captured and write-attempted events to detect
 * freshness violations. A violation occurs when a write is conditioned on a
 * witness value that was superseded by a later write to the same resource.
 *
 * The algorithm:
 * 1. Maintain a per-resource list of completed writes (from `WriteAttemptedEvent`).
 * 2. For each `WriteAttemptedEvent`, check if the latest recorded write to the
 *    same resource produced a different witness value than `conditionedOn.value`.
 *    If so, the conditioned-on state is stale — record a conflict.
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

      // Check if the LATEST write to this resource produced a different
      // witness value. Only the most recent write matters — older writes
      // may have different values that were subsequently superseded.
      // A conflict means: the current state of the resource has moved past
      // what this write believes it's updating.
      const latest = existingWrites.length > 0
        ? existingWrites[existingWrites.length - 1]!
        : null;

      if (latest && latest.newWitness.value !== e.conditionedOn.value) {
        conflicts.push({
          writeNodeId: e.nodeId,
          writeRunId: e.runId,
          resource,
          conditionedOnWitness: e.conditionedOn,
          conflictingWrite: {
            runId: latest.runId,
            nodeId: latest.nodeId,
            newWitness: latest.newWitness,
            succeededAtMs: latest.succeededAtMs,
          },
        });
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
 *
 * The index is bounded: each resource retains at most `maxEntriesPerResource`
 * write entries (default 1000). Oldest entries are evicted on overflow.
 */
export class InMemoryFreshnessIndex implements FreshnessIndex {
  private readonly writes = new Map<string, WriteEntry[]>();
  private readonly latest = new Map<string, WriteEntry>();
  private readonly maxEntries: number;

  constructor(opts?: { maxEntriesPerResource?: number }) {
    this.maxEntries = opts?.maxEntriesPerResource ?? 1000;
  }

  /** Record a successful write. Evicts oldest if over capacity. */
  async recordWrite(event: WriteAttemptedEvent): Promise<void> {
    const resource = event.newWitness.resource;
    const entry: WriteEntry = {
      runId: event.runId,
      nodeId: event.nodeId,
      newWitness: event.newWitness,
      succeededAtMs: event.succeededAtMs,
    };
    const entries = this.writes.get(resource) ?? [];
    entries.push(entry);
    // Evict oldest entries when over capacity
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries);
    }
    this.writes.set(resource, entries);
    this.latest.set(resource, entry);
  }

  /**
   * Check if a conditioned-on witness has been superseded by a more recent
   * write. Returns the conflicting write entry, or `null`.
   *
   * Fast path (sinceMs === 0): O(1) check against the latest write per resource.
   * Slow path (sinceMs > 0): O(1) check against the last entry — entries are
   * append-only (monotonically ordered by succeededAtMs), so the latest is
   * always the last element.
   */
  async findConflict(
    resource: string,
    conditionedOnValue: string,
    sinceMs: number,
  ): Promise<WriteEntry | null> {
    // Fast path: sinceMs === 0 means "any write ever" — check latest directly
    if (sinceMs === 0) {
      const entry = this.latest.get(resource);
      if (entry && entry.newWitness.value !== conditionedOnValue) return entry;
      return null;
    }
    // Slow path: entries are append-only (monotonically ordered by succeededAtMs).
    // The latest write is always the last element.
    const entries = this.writes.get(resource) ?? [];
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1]!;
    if (latest.succeededAtMs >= sinceMs && latest.newWitness.value !== conditionedOnValue) {
      return latest;
    }
    return null;
  }

  /** Clear all entries. Useful for testing. */
  clear(): void {
    this.writes.clear();
    this.latest.clear();
  }
}
