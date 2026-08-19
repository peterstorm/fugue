/**
 * Witness primitives — the branded resource identity and the witness values
 * built on it.
 *
 * These live in their own leaf because TWO modules need them: `freshness.ts`
 * (a witness conditions a write) and `side-effects.ts` (a node declares the
 * resource it touches). `ResourceName` says so itself — "branded resource
 * identifier shared between SideEffectProfile.resource and Witness.resource".
 * While they were declared inside `freshness.ts`, `side-effects.ts` had to
 * import from it, and `freshness.ts` imports event types that transitively
 * depend on side-effects — a three-module cycle held open by a primitive that
 * belongs beneath both of them.
 *
 * This module imports nothing at runtime (its only imports are type-only and
 * erased before emit).
 */

import type { RunId, NodeId } from "./ids.js";

export type WitnessKind =
  | "version"          // monotonic integer (Hibernate @Version, Mongo __v)
  | "etag"             // hash-based (HTTP, S3, DynamoDB)
  | "timestamp"        // ms-precision timestamp (poor man's version)
  | "lsn"              // log sequence number (Postgres WAL)
  | "idempotency-key"  // request-scoped (Stripe, Plaid)
  | "custom";

/** ONE encoding of the closed WitnessKind membership question. The smart
 *  constructors below enforce it at mint time, so a cast or plain-JS caller
 *  cannot mint an off-contract witness; the Redis adapter gates persisted
 *  bytes with the same predicate before they re-enter conflict decisions. */
const WITNESS_KIND_ALLOW_LIST = {
  version: true,
  etag: true,
  timestamp: true,
  lsn: true,
  "idempotency-key": true,
  custom: true,
} as const satisfies Readonly<Record<WitnessKind, true>>;

export const isWitnessKind = (value: unknown): value is WitnessKind =>
  typeof value === "string" && Object.hasOwn(WITNESS_KIND_ALLOW_LIST, value);

const assertWitnessKind = (kind: WitnessKind): void => {
  if (!isWitnessKind(kind)) {
    // Deterministic: an off-contract kind fails identically on every retry.
    throw new TypeError(
      `Witness kind must be one of ${Object.keys(WITNESS_KIND_ALLOW_LIST).join(", ")}; got ${typeof kind === "string" ? `"${kind}"` : typeof kind}`,
    );
  }
};

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

/** Smart constructor for a resource-free witness value. Validates non-empty value and closed kind. */
export const witnessValue = (kind: WitnessKind, value: string): WitnessValue => {
  assertWitnessKind(kind);
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
  assertWitnessKind(kind);
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

/**
 * One successful write to a resource — the conflicting-write record carried
 * by freshness conflicts and violations, and the lookup result of freshness
 * index reads. ONE encoding (round-23 tda-1): `FreshnessConflict`
 * (`types/freshness.ts`) and `FreshnessViolationEvent` (`types/events.ts`)
 * previously re-declared this shape structurally; both now reference this
 * type, so the three copies cannot drift. Lives here, below both consumers,
 * to keep `types/freshness.ts` ↔ `types/events.ts` free of cycles.
 */
export interface WriteEntry {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
}

