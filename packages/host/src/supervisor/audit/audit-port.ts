/**
 * AuditPort — the audit trail for tenant lifecycle operations (multi-tenant spec FR-028, SC-008).
 *
 * Every register / deregister / reconfigure operation MUST emit an audit record
 * carrying AT LEAST `actor`, `timestamp`, `tenant`, and `action` (multi-tenant spec FR-028). This
 * module is the PURE record type + its smart constructor + the port the admin
 * lifecycle handler writes through. The concrete sinks (structured log + Redis
 * stream) live in `audit-sink-log-redis.ts` (the imperative shell).
 *
 * PARSE-DON'T-VALIDATE: `AuditAction` is a closed discriminated union of the
 * three lifecycle verbs — there is no representable "audit record for some other
 * action", so the type itself guarantees multi-tenant spec SC-008's "100% of register/deregister/
 * reconfigure emit a record" cannot be undermined by a typo'd free-form string.
 *
 * NON-LEAKING: a record names exactly ONE tenant (the one the op acted on) and
 * carries no other tenant's id — mirroring the host's per-tenant error
 * non-leakage (multi-tenant spec FR-041). The `outcome` field records whether the op SUCCEEDED or
 * was REFUSED, so an audit trail captures denied attempts too (e.g. a non-admin
 * token rejected at the boundary — the authz refusal is itself auditable,
 * multi-tenant spec SC-008's "0% succeed under a non-admin token" is observable in the trail).
 *
 * INJECTABLE CLOCK: the record's `timestamp` is supplied by the CALLER (the
 * handler stamps it from an injected `now()`), never read from `Date.now()`
 * here, so audit emission is deterministic under test.
 */

import type { TenantId } from "../../domain/tenant.js";

// ── Tenant reference (the audit trail's looser tenant shape) ──────────────────

declare const __rawAttemptedTenantIdBrand: unique symbol;

/**
 * A tenant id that was ATTEMPTED at the admin boundary but did NOT pass
 * `TENANT_ID_REGEX` (e.g. a malformed `POST /admin/tenants/<bad id>`, or no id at
 * all). It is recorded (bounded) for the trail and NEVER routes, keys, or becomes
 * an ACL pattern — so it deliberately does not satisfy the `TenantId` brand's
 * shape invariant. Hard-branded with a `unique symbol` (matching `TenantId` in
 * the `AuditTenantRef` union, so neither arm can be forged from a plain object
 * literal) so this looser shape is expressed in the type rather than smuggled
 * through a `string as TenantId` cast.
 */
export type RawAttemptedTenantId = string & { readonly [__rawAttemptedTenantIdBrand]: void };

/**
 * Max length of a recorded raw attempted id. The input is an attacker-influenced
 * URL segment / body field, so `rawAttemptedTenantId` BOUNDS it before it lands in
 * the audit trail — an unbounded id could bloat the trail or a structured log line.
 */
const MAX_RAW_ATTEMPTED_TENANT_ID_LEN = 128;

/**
 * The tenant a record names: either a shape-validated `TenantId` (every
 * succeeded/normal refusal record) OR a `RawAttemptedTenantId` (a refusal logged
 * before the id parsed). Keeping `TenantId` strictly "passed validation" while
 * still letting the trail capture rejected attempts truthfully.
 */
export type AuditTenantRef = TenantId | RawAttemptedTenantId;

/**
 * Record a raw, unvalidated tenant segment for the audit trail ONLY. The single
 * greppable producer of `RawAttemptedTenantId` — used where an id failed (or
 * never reached) `tenantId()` parsing but the refusal must still be audited.
 *
 * The value is CONTENT-SANITIZED before it is length-bounded (parse, don't just
 * tag) since it is attacker-influenced. Control characters (C0 U+0000-U+001F,
 * DEL/C1 U+007F-U+009F i.e. CR, LF, NUL, ANSI/terminal escapes) are each
 * replaced with U+FFFD so a crafted segment cannot inject a new line into the
 * audit trail / a structured log, nor smuggle terminal escape sequences. Each
 * control unit becomes exactly one U+FFFD, so the length math below is unaffected.
 *
 * The sanitized value is then BOUNDED to AT MOST `MAX_RAW_ATTEMPTED_TENANT_ID_LEN`
 * code units; an over-long segment is truncated with a trailing `…` that COUNTS
 * toward the bound (so the result length never exceeds the max — the `…` replaces
 * the final retained character).
 *
 * The cut is UTF-16-surrogate-safe: if the retained prefix would end on a lone
 * high surrogate (a `…` placed mid-emoji), that dangling code unit is dropped too,
 * so the trail never carries a lone surrogate. The result is then AT MOST the
 * bound (one shorter when a pair was split), so the length invariant still holds.
 */
export const rawAttemptedTenantId = (raw: string): RawAttemptedTenantId => {
  // Strip control/newline/escape characters first (each → one U+FFFD) so the
  // length invariant below operates on the sanitized form and is never widened.
  const sanitized = raw.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "\uFFFD");
  if (sanitized.length <= MAX_RAW_ATTEMPTED_TENANT_ID_LEN) {
    return sanitized as RawAttemptedTenantId;
  }
  // Reserve one code unit for the trailing `…`; retained indices are 0..end-1.
  let end = MAX_RAW_ATTEMPTED_TENANT_ID_LEN - 1;
  const lastRetained = sanitized.charCodeAt(end - 1);
  if (lastRetained >= 0xd800 && lastRetained <= 0xdbff) {
    // Last retained unit is a high surrogate whose low half is being cut — drop it.
    end -= 1;
  }
  return `${sanitized.slice(0, end)}…` as RawAttemptedTenantId;
};

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
 *     (multi-tenant spec SC-008).
 *   - `partial`: the op PARTIALLY took effect — the primary state transition
 *     landed but a follow-on side-effect failed (e.g. deregister tombstoned the
 *     tenant, but the worker-evict or token-revoke half of multi-tenant spec FR-029 failed). The
 *     audit record must NOT claim `succeeded` when a half failed — `partial` +
 *     a `detail` naming which half is the TRUTHFUL outcome (multi-tenant spec FR-029, SC-008).
 */
export type AuditOutcome = "succeeded" | "refused" | "partial";

/**
 * Who performed the operation. The admin lifecycle API is admin-token only
 * (multi-tenant spec FR-026), so the actor is an admin principal; `label` is an optional,
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
 * An immutable audit record (multi-tenant spec FR-028). The four REQUIRED fields — `actor`,
 * `timestamp`, `tenant`, `action` — are non-optional in the type, so a record
 * that omits any of them is unrepresentable (multi-tenant spec SC-008 is enforced structurally,
 * not by a runtime check that could be forgotten).
 */
export interface AuditRecord {
  readonly actor: AuditActor;
  /** UNIX-millis instant the operation was performed (caller-stamped, multi-tenant spec FR-028). */
  readonly timestamp: number;
  /**
   * The single tenant this operation acted on (names no other tenant). A
   * shape-validated `TenantId` for normal records, or a `RawAttemptedTenantId`
   * for a refusal logged before the id parsed — see `AuditTenantRef`.
   */
  readonly tenant: AuditTenantRef;
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
  readonly tenant: AuditTenantRef;
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
 * The audit sink the admin lifecycle handler writes through (multi-tenant spec FR-028). A single
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
