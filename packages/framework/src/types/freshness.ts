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

// ---------------------------------------------------------------------------
// ResourceName — branded type shared by Witness and SideEffectProfile
// ---------------------------------------------------------------------------

declare const __resourceNameBrand: unique symbol;

/**
 * Branded resource identifier shared between `SideEffectProfile.resource`
 * and `Witness.resource`. Ensures compile-time cross-referencing: a Witness
 * produced by `extractWitness` must name the same resource as the node's
 * `sideEffects.resource`.
 *
 * Valid resource names are non-empty strings following the convention
 * `system:entity[:id]` (e.g. `"postgres:orders"`, `"stripe:charges:ch_123"`).
 */
export type ResourceName = string & { readonly [__resourceNameBrand]: void };

/** Smart constructor for ResourceName. Validates non-empty. */
export const resourceName = (name: string): ResourceName => {
  if (!name) {
    throw new Error("ResourceName must be non-empty");
  }
  return name as ResourceName;
};

/** @internal — bypass validation for deserialization/test fixtures. */
export const __brandResourceName = (name: string): ResourceName => name as ResourceName;

declare const __witnessBrand: unique symbol;

export type Witness = {
  readonly kind: WitnessKind;
  /** Must match `NodeDef.sideEffects.resource` for framework cross-referencing. */
  readonly resource: ResourceName;
  /** Opaque to the framework — never parsed or compared beyond string equality. */
  readonly value: string;
} & { readonly [__witnessBrand]: void };

/** Smart constructor — validates non-empty resource and value. */
export const witness = (
  kind: WitnessKind,
  resource: string,
  value: string,
): Witness => {
  if (!resource) {
    throw new Error("Witness resource must be non-empty");
  }
  if (!value) {
    throw new Error("Witness value must be non-empty");
  }
  return { kind, resource: resource as ResourceName, value } as Witness;
};

/**
 * @internal — Bypass validation for trusted internal code (deserialization,
 * replay, test fixtures). NOT part of the public API.
 */
export const __brandWitness = (w: {
  kind: WitnessKind;
  resource: string;
  value: string;
}): Witness => w as Witness;

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
