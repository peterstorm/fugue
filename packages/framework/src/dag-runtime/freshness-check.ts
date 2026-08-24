/**
 * Freshness check — pure module for detecting stale-read → write hazards.
 *
 * Takes an event log (or a subset of it) and returns freshness violations.
 * The check is purely functional: it scans `WitnessCapturedEvent` and
 * `WriteAttemptedEvent` entries, and for any `writes` node whose
 * `conditionedOn` witness has been superseded by an intervening write to the
 * same resource, returns a `FreshnessCheckResult` describing the conflict.
 *
 * This module is the single-process fallback. Cross-process detection is
 * layered on top via the Redis adapter (`checkpoint/redis-freshness-index.ts`)
 * or the durable file adapter (`file/freshness-index.ts`, FR-030 — records
 * survive process restart).
 */

import type { WitnessCapturedEvent, WriteAttemptedEvent } from "../types/events.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";
import { freshnessWriteKey, writeEntryOf } from "../types/freshness.js";
import type {
  FreshnessConflict,
  FreshnessCheckResult,
  FreshnessIndex,
  FreshnessWriteIdentity,
  WriteEntry,
} from "../types/freshness.js";

export type {
  FreshnessConflict,
  FreshnessCheckResult,
  FreshnessIndex,
  FreshnessWriteIdentity,
  WriteEntry,
};

/**
 * Scan a sequence of witness-captured and write-attempted events to detect
 * freshness violations. A violation occurs when a write is conditioned on a
 * witness value that was superseded by a later write to the same resource.
 *
 * NOT ON THE RUNTIME PATH. The runtime detects conflicts incrementally through
 * `FreshnessIndex.findConflict` (`freshness-emission.ts` → `wave-execution.ts`);
 * this is the BATCH form over a whole event log, and it exists for two jobs:
 *
 *  1. Forensics — answering "did this run have a stale-read hazard?" from an
 *     exported log after the fact, where no live index is available.
 *  2. The differential oracle for the incremental path. Two independent
 *     implementations of one rule would normally be a drift risk; here the drift
 *     is what a property test actively hunts —
 *     `__tests__/freshness-check-property.test.ts` asserts
 *     `InMemoryFreshnessIndex` and `checkFreshness` agree on random write
 *     sequences (500 runs), so a change to the rule that lands in only one of
 *     them fails the build.
 *
 * Deliberately NOT re-exported from the package barrel: it has no production
 * caller, and exporting it invites use where the incremental index belongs.
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
          conditionedOnWitness: e.conditionedOn,
          conflictingWrite: writeEntryOf(latest),
        });
      }

      // Record this write
      existingWrites.push(writeEntryOf(e));
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
 * For cross-process detection, see the Redis-backed or file-backed freshness
 * index adapters.
 *
 * Bounded in two dimensions:
 *   - Each resource retains at most `maxEntriesPerResource` write entries (default 1000).
 *   - The total number of tracked resources is capped at `maxResources` (default 10000).
 *   Oldest resources are evicted on overflow.
 */
export class InMemoryFreshnessIndex implements FreshnessIndex {
  private readonly writes = new Map<string, WriteEntry[]>();
  private readonly recordedWriteKeys = new Map<string, Set<string>>();
  private readonly latest = new Map<string, WriteEntry>();
  private readonly maxEntries: number;
  private readonly maxResources: number;
  /** Insertion-order tracking for LRU eviction of resources. */
  private readonly resourceOrder: string[] = [];
  /** O(1) membership check to prevent duplicate entries in resourceOrder. */
  private readonly resourceSet = new Set<string>();
  /** Cursor into resourceOrder for O(1) amortized eviction. */
  private evictCursor = 0;

  constructor(opts?: { maxEntriesPerResource?: number; maxResources?: number }) {
    this.maxEntries = opts?.maxEntriesPerResource ?? 1000;
    this.maxResources = opts?.maxResources ?? 10_000;
  }

  /**
   * Record a successful write. Evicts oldest entries per resource and oldest
   * resources globally.
   *
   * The in-memory implementation never fails (always returns `ok(undefined)`).
   * The `Result` return type satisfies the `FreshnessIndex` interface contract
   * required by the Redis adapter, which CAN fail on network issues. Callers
   * should still check `.ok` — switching to a Redis-backed index at runtime
   * would silently break code that assumes infallible writes.
   */
  async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
    const resource = event.newWitness.resource;
    const entry: WriteEntry = writeEntryOf(event);
    if (!this.writes.has(resource)) {
      // New resource — check global capacity before adding
      if (this.writes.size >= this.maxResources) {
        // Bounded scan: try up to 100 candidates before falling back to Map iteration order
        const MAX_SCAN = 100;
        let evicted = false;
        for (let i = 0; i < MAX_SCAN && this.evictCursor < this.resourceOrder.length; i++) {
          const candidate = this.resourceOrder[this.evictCursor]!;
          this.evictCursor++;
          if (this.writes.has(candidate)) {
            this.writes.delete(candidate);
            this.recordedWriteKeys.delete(candidate);
            this.latest.delete(candidate);
            this.resourceSet.delete(candidate);
            evicted = true;
            break;
          }
        }
        // Fallback: if scan budget exhausted, evict the first live key via Map iteration
        if (!evicted) {
          const firstKey = this.writes.keys().next().value;
          if (firstKey !== undefined) {
            this.writes.delete(firstKey);
            this.recordedWriteKeys.delete(firstKey);
            this.latest.delete(firstKey);
            this.resourceSet.delete(firstKey);
          }
        }
        // Compact: when cursor has consumed more than half the array, trim
        // the consumed prefix so resourceOrder does not grow unboundedly.
        if (this.evictCursor > this.resourceOrder.length / 2) {
          this.resourceOrder.splice(0, this.evictCursor);
          this.evictCursor = 0;
        }
      }
      if (!this.resourceSet.has(resource)) {
        this.resourceOrder.push(resource);
        this.resourceSet.add(resource);
      }
    }
    const entries = this.writes.get(resource) ?? [];
    entries.push(entry);
    // Stable timestamp order makes the tail authoritative even when completion
    // callbacks arrive out of order; equal timestamps retain arrival ordering.
    entries.sort((left, right) => left.succeededAtMs - right.succeededAtMs);
    // Retain the timestamp-newest bounded window for this resource.
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries);
    }
    this.writes.set(resource, entries);
    const recorded = this.recordedWriteKeys.get(resource) ?? new Set<string>();
    recorded.add(freshnessWriteKey(event));
    this.recordedWriteKeys.set(resource, recorded);
    this.latest.set(resource, entries[entries.length - 1]!);
    return ok(undefined);
  }

  async hasRecordedWrite(
    identity: FreshnessWriteIdentity,
  ): Promise<Result<boolean, FrameworkError>> {
    return ok(
      this.recordedWriteKeys
        .get(identity.newWitness.resource)
        ?.has(freshnessWriteKey(identity)) ?? false,
    );
  }

  /**
   * Check if a conditioned-on witness has been superseded by a more recent
   * write. Returns the conflicting write entry, or `null`.
   *
   * Both branches are O(1); the split is by QUESTION asked, not by cost.
   *   - `sinceMs === 0` — "any write ever": read the per-resource latest directly.
   *   - `sinceMs > 0`  — "any write since T": read the last entry, which
   *     `recordWrite` keeps monotonically ordered by `succeededAtMs`, so the
   *     latest is always the last element even when callbacks arrive out of
   *     order, and one comparison settles it.
   * (The second branch was historically labelled a "slow path"; it is a scan no
   * longer, and the name outlived the implementation.)
   */
  async findConflict(
    conditionedOn: import("../types/freshness.js").Witness,
    sinceMs: number,
  ): Promise<Result<WriteEntry | null, FrameworkError>> {
    const { resource, value: conditionedOnValue } = conditionedOn;
    // Fast path: sinceMs === 0 means "any write ever" — check latest directly
    if (sinceMs === 0) {
      const entry = this.latest.get(resource);
      if (entry && entry.newWitness.value !== conditionedOnValue) return ok(entry);
      return ok(null);
    }
    // Slow path: entries are timestamp-ordered; the latest is the last element.
    const entries = this.writes.get(resource) ?? [];
    if (entries.length === 0) return ok(null);
    const latest = entries[entries.length - 1]!;
    if (latest.succeededAtMs >= sinceMs && latest.newWitness.value !== conditionedOnValue) {
      return ok(latest);
    }
    return ok(null);
  }

  /** Clear all entries. Useful for testing. */
  clear(): void {
    this.writes.clear();
    this.recordedWriteKeys.clear();
    this.latest.clear();
    this.resourceOrder.length = 0;
    this.resourceSet.clear();
    this.evictCursor = 0;
  }
}
