/**
 * Freshness index — the write-side of the witness contract (ADR-0025).
 *
 * The witness primitives themselves live in `witness.ts`, a leaf both this
 * module and `side-effects.ts` sit above. They are re-exported here so every
 * existing `from "./freshness.js"` import site is unchanged.
 */
export type { WitnessKind, ResourceName, Witness, WitnessValue } from "./witness.js";
export { resourceName, __brandResourceName, witnessValue, witness, stampWitness, __brandWitness, isWitnessKind } from "./witness.js";
import type { ResourceName, Witness, WitnessKind } from "./witness.js";
// ---------------------------------------------------------------------------
// FreshnessIndex port + supporting types
//
// Defines the contract for freshness-write tracking. Pure type-layer
// definitions; the in-memory adapter (dag-runtime/freshness-check.ts), the
// Redis adapter (checkpoint/redis-freshness-index.ts), and the file adapter
// (file/freshness-index.ts) all implement this interface against the same
// shape.
// ---------------------------------------------------------------------------

import type { RunId, NodeId } from "./ids.js";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { WitnessCapturedEvent, WriteAttemptedEvent } from "./events.js";

export interface FreshnessConflict {
  /** The write node that is conditioned on a stale witness. */
  readonly writeNodeId: NodeId;
  readonly writeRunId: RunId;
  /** Branded — derived from `conditionedOnWitness.resource`, cannot drift from it. */
  readonly resource: ResourceName;
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

export interface FreshnessIndex {
  /** Record a successful write for future conflict detection. */
  recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>>;
  /**
   * Check if `conditionedOn` has been superseded by a write that completed
   * after `sinceMs`. Returns the first conflicting write, or `null`.
   *
   * Takes a `Witness` directly (not `resource, value` strings) so the
   * resource ↔ value pair stays bonded at the call site — no risk of
   * swapping the two raw strings.
   */
  findConflict(
    conditionedOn: Witness,
    sinceMs: number,
  ): Promise<Result<WriteEntry | null, FrameworkError>>;
}

// Re-export the public event types used in this contract so consumers
// importing `types/freshness.js` get the full surface without cross-import.
export type { WitnessCapturedEvent, WriteAttemptedEvent };

/**
 * Port-level ZSET member grammar for the FreshnessIndex port (ADR-0079).
 * Redis stores `[runId, nodeId, witnessKind, witnessValue]` as the member of
 * the per-resource ZSET; the file backend compares equal-score conflict
 * winners byte-for-byte against these SAME bytes. ONE encoding, owned by the
 * port that specifies the tie-break: both adapters consume it, so a change
 * to the member tuple (order, fields, representation) can no longer silently
 * diverge the file backend's conflict winners from the Redis adapter's.
 */
export const freshnessMemberKey = (
  runId: RunId,
  nodeId: NodeId,
  // The CLOSED `WitnessKind` union, not `string`: a misspelled kind would
  // otherwise compile into member bytes that can never match a real member,
  // silently skewing the equal-score winner comparison (ONE encoding of the
  // tie-break grammar — round-22 tda-2).
  witnessKind: WitnessKind,
  witnessValue: string,
): string => JSON.stringify([runId, nodeId, witnessKind, witnessValue]);

/**
 * Redis compares equal-score ZSET members as unsigned byte strings; the
 * conflict-winner rule must agree across adapters, so the comparator is
 * port-owned alongside the member grammar it orders.
 */
export const compareFreshnessMemberKeys = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

/**
 * The FreshnessIndex port's 24-hour singleton-lifetime contract (FR-032) —
 * ONE encoding, owned by the port file that specifies the expiry semantics,
 * independent of the Checkpointer port's FR-027 TTL (`TTL_SECONDS` in
 * `checkpoint/checkpointer.ts`). The value currently matches that TTL —
 * ADR-0079's Redis `EXPIRE` parity target — and the parity pin in
 * `file-freshness-index.test.ts` proves the agreement while it is meant to
 * hold; a future FR-027 change must NOT silently redefine freshness expiry.
 */
export const FRESHNESS_TTL_SECONDS = 86_400;
