/**
 * Freshness witness contract types for state-transition observability.
 *
 * The framework cannot mint witness values (those are domain-specific), but it
 * defines the schema, requires the extractors at node definition time, and
 * detects skew during replay.
 *
 * A witness is an opaque token that captures the version/state of an external
 * resource at a point in time. Reads emit witnesses; writes declare which
 * witness they are conditioned on. The framework compares witnesses by
 * `(resource, value)` equality to detect stale-read → write hazards.
 *
 * @see docs/adr/0025-freshness-witness-contract.md
 */

export type WitnessKind =
  | "version"          // monotonic integer (Hibernate @Version, Mongo __v)
  | "etag"             // hash-based (HTTP, S3, DynamoDB)
  | "timestamp"        // ms-precision timestamp (poor man's version)
  | "lsn"              // log sequence number (Postgres WAL)
  | "idempotency-key"  // request-scoped (Stripe, Plaid)
  | "custom";

export interface Witness {
  readonly kind: WitnessKind;
  /** Must match `NodeDef.sideEffects.resource` for framework cross-referencing. */
  readonly resource: string;
  /** Opaque to the framework — never parsed or compared beyond string equality. */
  readonly value: string;
}

// ---------------------------------------------------------------------------
// FreshnessIndex port + supporting types
//
// Defines the contract for freshness-write tracking. Pure type-layer
// definitions; both the in-memory adapter (dag-runtime/freshness-check.ts) and
// the Redis adapter (checkpoint/redis-freshness-index.ts) implement this
// interface against the same shape.
// ---------------------------------------------------------------------------

import type { RunId, NodeId } from "./ids.js";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { WitnessCapturedEvent, WriteAttemptedEvent } from "./events.js";

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
