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
