/**
 * The `X-Fugue-Tenant` header contract — the SHARED, single source of truth for
 * how the supervisor (T7) STAMPS a routed tenant onto a reverse-proxied request
 * and how a worker (T6) MAY defensively VERIFY it.
 *
 * ── Why this lives in one pure module ────────────────────────────────────────
 * The signer (supervisor, T7) and the verifier (worker, T6) MUST agree byte-for-
 * byte or every proxied request fails closed. Re-implementing HMAC on both sides
 * is how that drifts. So the canonical sign/verify pair lives here, in the
 * functional core: pure, deterministic, no I/O, no logging — trivially testable
 * and impossible to diverge because both sides import the SAME function.
 *
 * ── The contract (do not change without changing both sides) ──────────────────
 *   header name  : `X-Fugue-Tenant`
 *   header value : `<tenantId>.<hmacHex>`
 *   hmacHex      : hex( HMAC-SHA256( key = FUGUE_SUPERVISOR_HMAC_KEY,
 *                                    message = tenantId ) )
 *
 * ── Security posture (FR-007, defense-in-depth) ──────────────────────────────
 * The PRIMARY per-tenant boundary is socket isolation: each worker binds a
 * 0600 Unix-domain socket reachable only by the supervisor + worker (same uid),
 * so a request arriving on a worker's socket is, by construction, for that
 * worker's tenant. This header is a SECONDARY, defensive integrity check —
 * fail-CLOSED on mismatch, but OPTIONAL: when no HMAC key is configured the
 * worker relies on socket isolation alone (no verification performed).
 *
 * `verifyTenantHeader` returns a typed discriminated result rather than a bare
 * boolean so the worker can distinguish "absent" (no header) from "mismatch"
 * (present but wrong) and treat both as fail-closed without conflating them.
 * The comparison is CONSTANT-TIME (`timingSafeEqual`) so a mismatching signature
 * cannot be discovered byte-by-byte via timing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TenantId } from "./tenant.js";

/** The canonical header NAME. Both signer and verifier use this exact string. */
export const TENANT_HEADER_NAME = "X-Fugue-Tenant" as const;

/**
 * Compute the hex HMAC-SHA256 of a tenant id under the internal supervisor key.
 * Pure given its inputs. The SOLE place the algorithm is defined.
 */
const tenantHmacHex = (hmacKey: string, tenantId: TenantId): string =>
  createHmac("sha256", hmacKey).update(tenantId, "utf8").digest("hex");

/**
 * SUPERVISOR side (T7): build the `X-Fugue-Tenant` header value for a routed
 * tenant. `<tenantId>.<hmacHex>`.
 *
 * `tenantId` is a branded `TenantId` (the type, not just the name): the
 * `<tenantId>.<hmacHex>` wire format is parsed by the FIRST `.` on the verify
 * side, which is unambiguous ONLY because `TENANT_ID_REGEX` forbids `.`. Taking
 * the brand makes that parse-safety invariant a requirement of the type rather
 * than a convention a caller could violate with a raw string.
 */
export const signTenantHeader = (hmacKey: string, tenantId: TenantId): string =>
  `${tenantId}.${tenantHmacHex(hmacKey, tenantId)}`;

/**
 * The outcome of verifying a presented `X-Fugue-Tenant` header against the
 * worker's bound tenant. A discriminated union so the worker treats every
 * non-`ok` case as fail-closed without conflating the reasons.
 */
export type TenantHeaderVerification =
  | { readonly kind: "ok" }
  /** No header present. Fail-closed when verification is required. */
  | { readonly kind: "absent" }
  /** Header malformed (no `.` separator / empty parts). */
  | { readonly kind: "malformed" }
  /** Header names a DIFFERENT tenant than the worker is bound to. */
  | { readonly kind: "tenant-mismatch" }
  /** HMAC did not verify under the configured key. */
  | { readonly kind: "bad-signature" };

/**
 * WORKER side (T6): verify a presented header value against the tenant this
 * worker is bound to, using the shared HMAC key. PURE and fail-closed:
 *
 *   - `headerValue === undefined`      → `absent`
 *   - no `.` / empty id or hmac        → `malformed`
 *   - id ≠ boundTenantId               → `tenant-mismatch`
 *   - HMAC mismatch (constant-time)    → `bad-signature`
 *   - otherwise                        → `ok`
 *
 * The constant-time compare guards the signature; the explicit tenant-id check
 * guarantees a validly-signed header for tenant A can never be accepted by
 * tenant B's worker (the signer signs the id, so a forged id would also fail the
 * HMAC — the explicit check is belt-and-suspenders + a precise reason).
 */
export const verifyTenantHeader = (
  hmacKey: string,
  boundTenantId: TenantId,
  headerValue: string | undefined,
): TenantHeaderVerification => {
  if (headerValue === undefined) return { kind: "absent" };

  const dot = headerValue.indexOf(".");
  if (dot <= 0 || dot === headerValue.length - 1) return { kind: "malformed" };

  const presentedId = headerValue.slice(0, dot);
  const presentedHmac = headerValue.slice(dot + 1);
  if (presentedId === "" || presentedHmac === "") return { kind: "malformed" };

  if (presentedId !== boundTenantId) return { kind: "tenant-mismatch" };

  const expectedHmac = tenantHmacHex(hmacKey, boundTenantId);
  // Constant-time compare. Lengths must match for timingSafeEqual; a length
  // mismatch is itself a failed signature.
  const a = Buffer.from(presentedHmac, "utf8");
  const b = Buffer.from(expectedHmac, "utf8");
  if (a.length !== b.length) return { kind: "bad-signature" };
  return timingSafeEqual(a, b) ? { kind: "ok" } : { kind: "bad-signature" };
};
