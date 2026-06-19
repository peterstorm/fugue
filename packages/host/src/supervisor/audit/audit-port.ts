/**
 * AuditPort — the audit trail for tenant lifecycle operations (FR-028, SC-008).
 *
 * Every register / deregister / reconfigure operation MUST emit an audit record
 * carrying AT LEAST `actor`, `timestamp`, `tenant`, and `action` (FR-028). This
 * module is the PURE record type + its smart constructor + the port the admin
 * lifecycle handler writes through. The concrete sinks (structured log + Redis
 * stream) live in `audit-sink-log-redis.ts` (the imperative shell).
 *
 * PARSE-DON'T-VALIDATE: `AuditAction` is a closed discriminated union of the
 * three lifecycle verbs — there is no representable "audit record for some other
 * action", so the type itself guarantees SC-008's "100% of register/deregister/
 * reconfigure emit a record" cannot be undermined by a typo'd free-form string.
 *
 * NON-LEAKING: a record names exactly ONE tenant (the one the op acted on) and
 * carries no other tenant's id — mirroring the host's per-tenant error
 * non-leakage (FR-041). The `outcome` field records whether the op SUCCEEDED or
 * was REFUSED, so an audit trail captures denied attempts too (e.g. a non-admin
 * token rejected at the boundary — the authz refusal is itself auditable,
 * SC-008's "0% succeed under a non-admin token" is observable in the trail).
 *
 * INJECTABLE CLOCK: the record's `timestamp` is supplied by the CALLER (the
 * handler stamps it from an injected `now()`), never read from `Date.now()`
 * here, so audit emission is deterministic under test.
 */

import type { TenantId } from "../../domain/tenant.js";

// ── Record ADT ───────────────────────────────────────────────────────────────

/**
 * The lifecycle verb an audit record describes. Closed union — adding a verb is
 * a single edit here and a compile error at every exhaustive `match` site, so the
 * audit surface can never silently drift from the admin API surface.
 */
export type AuditAction = "register" | "deregister" | "reconfigure";

/**
 * Whether the audited operation took effect.
 *   - `succeeded`: the op completed in full.
 *   - `refused`: an authz denial (non-admin token) or a fail-closed rejection
 *     (e.g. reconfigure of an unknown tenant, an invalid body) — the op never
 *     took effect — so the audit trail records ATTEMPTS, not just successes
 *     (SC-008).
 *   - `partial`: the op PARTIALLY took effect — the primary state transition
 *     landed but a follow-on side-effect failed (e.g. deregister tombstoned the
 *     tenant, but the worker-evict or token-revoke half of FR-029 failed). The
 *     audit record must NOT claim `succeeded` when a half failed — `partial` +
 *     a `detail` naming which half is the TRUTHFUL outcome (FR-029, SC-008).
 */
export type AuditOutcome = "succeeded" | "refused" | "partial";

/**
 * Who performed the operation. The admin lifecycle API is admin-token only
 * (FR-026), so the actor is an admin principal; `label` is an optional,
 * non-secret operator hint (e.g. an `X-Fugue-Actor` header) for the human-
 * readable trail. NEVER carries a token or secret — only the principal KIND and
 * an opaque label.
 */
export interface AuditActor {
  readonly kind: "admin";
  /** Optional non-secret operator label (e.g. an ops username). Never a token. */
  readonly label?: string;
}

/**
 * An immutable audit record (FR-028). The four REQUIRED fields — `actor`,
 * `timestamp`, `tenant`, `action` — are non-optional in the type, so a record
 * that omits any of them is unrepresentable (SC-008 is enforced structurally,
 * not by a runtime check that could be forgotten).
 */
export interface AuditRecord {
  readonly actor: AuditActor;
  /** UNIX-millis instant the operation was performed (caller-stamped, FR-028). */
  readonly timestamp: number;
  /** The single tenant this operation acted on (names no other tenant). */
  readonly tenant: TenantId;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  /** Optional non-secret detail (e.g. "non-admin token", "tenant-unknown"). */
  readonly detail?: string;
}

/**
 * Smart constructor for an `AuditRecord`. The single seam where a lifecycle op
 * becomes an audit record — keeps the four required fields together and is the
 * only producer, so every emitted record is well-formed by construction.
 */
export const auditRecord = (input: {
  readonly actor: AuditActor;
  readonly timestamp: number;
  readonly tenant: TenantId;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly detail?: string;
}): AuditRecord => ({
  actor: input.actor,
  timestamp: input.timestamp,
  tenant: input.tenant,
  action: input.action,
  outcome: input.outcome,
  ...(input.detail !== undefined ? { detail: input.detail } : {}),
});

// ── Port ─────────────────────────────────────────────────────────────────────

/**
 * The audit sink the admin lifecycle handler writes through (FR-028). A single
 * method: record one `AuditRecord`. Returns `Promise<void>` and MUST NOT throw —
 * an audit sink that fails (e.g. Redis stream down) must not crash the request
 * path; sinks degrade by logging the failure (a best-effort trail), never by
 * propagating. The compound sink (`audit-sink-log-redis.ts`) implements that
 * contract.
 *
 * The record's `timestamp` is already stamped by the caller (injected clock), so
 * the port itself reads no clock — it only persists/emits.
 */
export interface AuditPort {
  readonly record: (rec: AuditRecord) => Promise<void>;
}
