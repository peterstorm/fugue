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

/**
 * The resource-free part of a witness. Returned by the self-referential
 * extractors (`extractWitness` on reads, `extractNewWitness` on writes): those
 * always witness the node's *own* resource, so the author supplies only the
 * domain-specific `(kind, value)` and the framework stamps `sideEffects.resource`
 * at emission time (see `dag-runtime/freshness-emission.ts`). This makes a
 * resource mismatch between the profile and its witness unrepresentable.
 *
 * `extractConditionedOn` still returns a full `Witness` — a write may be
 * conditioned on a *different* resource it read upstream, so that resource is a
 * genuine free variable the author must name.
 *
 * `resource?: never` makes the mismatch a *compile-time* error, not merely a
 * runtime one: a full `Witness` (which carries `resource`) is not assignable to
 * a self-referential extractor slot, so an author cannot even name a resource
 * there.
 *
 * Deliberately *unbranded* (unlike `Witness`/`ResourceName`): a `WitnessValue`
 * has no swap hazard (its two fields are a `WitnessKind` enum and an opaque
 * `string`, not confusable), never crosses a serialization boundary or port,
 * and its sole invariant (non-empty value) is re-validated at the only place it
 * matters — `stampWitness`, which routes through `witness()`. Branding it would
 * add ceremony for no bug-prevention gain.
 */
export type WitnessValue = {
  readonly kind: WitnessKind;
  /** Opaque to the framework — never parsed or compared beyond string equality. */
  readonly value: string;
  /** Always absent — the framework stamps the resource. Makes a full `Witness` unassignable here. */
  readonly resource?: never;
};

/** Smart constructor for a resource-free witness value. Validates non-empty value. */
export const witnessValue = (kind: WitnessKind, value: string): WitnessValue => {
  if (!value) {
    throw new Error("Witness value must be non-empty");
  }
  return { kind, value };
};

/**
 * Smart constructor for a full `Witness`. Takes a branded `ResourceName`
 * (mint one with `resourceName(...)`), not a raw string — so the resource
 * cannot be silently swapped with `value` at the call site, and the
 * non-empty-resource invariant is enforced once, at the `ResourceName`
 * boundary. Validates non-empty value.
 */
export const witness = (
  kind: WitnessKind,
  resource: ResourceName,
  value: string,
): Witness => {
  if (!value) {
    throw new Error("Witness value must be non-empty");
  }
  return { kind, resource, value } as Witness;
};

/**
 * Stamp a `WitnessValue` with a resource to produce a full `Witness`.
 *
 * @internal — framework-internal; the only caller is
 * `dag-runtime/freshness-emission.ts`, which stamps the node's own
 * `sideEffects.resource` at emission time. Not exported from the package barrel;
 * DAG authors never stamp (they return a resource-free `witnessValue(...)`).
 */
export const stampWitness = (resource: ResourceName, wv: WitnessValue): Witness => {
  // An author extractor whose body falls through to an implicit `return`
  // (or returns a non-object) yields `undefined` here. Name the authoring
  // mistake before the property access throws an opaque TypeError — the
  // wave still fails closed, but with an actionable operator-facing message.
  if (!wv || typeof wv !== "object") {
    throw new Error("witness extractor returned no WitnessValue (expected { kind, value })");
  }
  // `resource` is stamped from the node's profile; any `resource` smuggled onto
  // `wv` at runtime (the `?: never` field is compile-time only) is ignored.
  return witness(wv.kind, resource, wv.value);
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
 * The FreshnessIndex port's 24-hour singleton-lifetime contract (FR-032) —
 * ONE encoding, owned by the port file that specifies the expiry semantics,
 * independent of the Checkpointer port's FR-027 TTL (`TTL_SECONDS` in
 * `checkpoint/checkpointer.ts`). The value currently matches that TTL —
 * ADR-0079's Redis `EXPIRE` parity target — and the parity pin in
 * `file-freshness-index.test.ts` proves the agreement while it is meant to
 * hold; a future FR-027 change must NOT silently redefine freshness expiry.
 */
export const FRESHNESS_TTL_SECONDS = 86_400;
