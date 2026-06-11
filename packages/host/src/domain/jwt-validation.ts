/**
 * Pure JWT claim validation for fugue-platform realm OIDC tokens.
 *
 * SECURITY BOUNDARY — READ THIS:
 * This module validates *claims only*. It assumes the JWT SIGNATURE HAS ALREADY
 * BEEN VERIFIED by an injected verifier (a JWKS-backed port in the imperative
 * shell). It is NOT a full JWT verifier and MUST NOT be mistaken for one — never
 * feed it claims pulled from an unverified token. Calling it on unverified claims
 * would let an attacker forge `sub`/`azp` freely. The shell (auth middleware)
 * verifies the signature first, then hands the verified claims here for the
 * iss/aud/exp policy checks.
 *
 * Everything here is PURE: no I/O, no Date.now (the caller injects `now`), no
 * crypto. Errors are returned as a typed `AuthError` via `Result` — never thrown.
 *
 * @satisfies FR-W3-006 — validates fugue-platform OIDC JWTs (iss=realm, aud=fugue-host).
 * @satisfies FR-W3-007 — extracts user `sub` (and `azp`) from a valid token.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { match } from "ts-pattern";
import type { JwtAudience, RealmJwtClaims } from "./auth.js";

// ── AuthError ADT ──────────────────────────────────────────────────────────

/**
 * Why a realm JWT was rejected. Discriminated union so the imperative shell can
 * map each kind to the right HTTP status without string matching. All kinds are
 * client-facing 401-worthy (bad/expired/mis-targeted token); infra/verifier
 * failures are a SEPARATE concern handled in the shell (503), not modelled here.
 */
export type AuthError =
  /** Claims object is missing required fields or has the wrong shape/types. */
  | { readonly kind: "malformed"; readonly reason: string }
  /** `iss` did not equal the expected fugue-platform realm issuer. */
  | { readonly kind: "wrong-issuer"; readonly expected: string; readonly actual: string }
  /** `aud` did not contain/equal the expected audience (`fugue-host`). */
  | { readonly kind: "wrong-audience"; readonly expected: string; readonly actual: JwtAudience }
  /** `exp` is at or before `now` (token expired or expiring exactly now). */
  | { readonly kind: "expired"; readonly exp: number; readonly now: number };

/**
 * A human-readable, NON-SENSITIVE summary of an AuthError. Safe to log: it never
 * includes the raw token, only already-public claim values. Used to keep 401
 * responses generic while giving operators a discriminable reason server-side.
 */
export const describeAuthError = (e: AuthError): string =>
  match(e)
    .with({ kind: "malformed" }, (m) => `malformed token claims: ${m.reason}`)
    .with({ kind: "wrong-issuer" }, () => "token issuer not accepted")
    .with({ kind: "wrong-audience" }, () => "token audience not accepted")
    .with({ kind: "expired" }, () => "token expired")
    .exhaustive();

// ── Validation options ─────────────────────────────────────────────────────

export interface ValidateRealmJwtOptions {
  /** The fugue-platform realm issuer URL the token must declare in `iss`. */
  readonly expectedIss: string;
  /** The audience this host must appear in (`fugue-host`). */
  readonly expectedAud: string;
  /**
   * Current time, UNIX seconds, injected for purity/testability. Compared
   * against `exp` (also seconds per OIDC). `exp <= now` is rejected.
   */
  readonly now: number;
}

// ── Validator (pure) ───────────────────────────────────────────────────────

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const audienceMatches = (aud: JwtAudience, expected: string): boolean =>
  typeof aud === "string" ? aud === expected : aud.includes(expected);

/**
 * Validate the (signature-verified) claims of a fugue-platform realm JWT.
 *
 * Enforces, in order:
 *  1. structural well-formedness of the claims used (`iss`, `aud`, `exp`,
 *     `sub`, `azp` present and correctly typed) → `malformed`;
 *  2. `iss === expectedIss` → `wrong-issuer`;
 *  3. `aud` contains/equals `expectedAud` → `wrong-audience`;
 *  4. `exp > now` (strictly; `exp === now` is expired) → `expired`.
 *
 * On success returns `{ sub, azp }` — the only claims the run path needs. Never
 * throws; all failures are `err(AuthError)`.
 */
export const validateRealmJwtClaims = (
  claims: unknown,
  opts: ValidateRealmJwtOptions,
): Result<{ readonly sub: string; readonly azp: string }, AuthError> => {
  // Reject a non-finite clock UP FRONT: a `NaN`/`Infinity` `now` would poison
  // the `exp <= now` comparison (`exp <= NaN` is always `false`), letting an
  // expired token read as valid — a fail-OPEN bug. Fail closed instead so no
  // bad clock can ever resurrect an expired token.
  if (!Number.isFinite(opts.now)) {
    return err({ kind: "malformed", reason: "non-finite now" });
  }

  if (typeof claims !== "object" || claims === null) {
    return err({ kind: "malformed", reason: "claims is not an object" });
  }
  const c = claims as Record<string, unknown>;

  // ── 1. Structural validation (parse, don't trust) ────────────────────────
  if (!isNonEmptyString(c.iss)) {
    return err({ kind: "malformed", reason: "missing or non-string 'iss'" });
  }
  const audValid =
    isNonEmptyString(c.aud) ||
    (Array.isArray(c.aud) && c.aud.length > 0 && c.aud.every(isNonEmptyString));
  if (!audValid) {
    return err({ kind: "malformed", reason: "missing or invalid 'aud'" });
  }
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) {
    return err({ kind: "malformed", reason: "missing or non-numeric 'exp'" });
  }
  if (!isNonEmptyString(c.sub)) {
    return err({ kind: "malformed", reason: "missing or non-string 'sub'" });
  }
  if (!isNonEmptyString(c.azp)) {
    return err({ kind: "malformed", reason: "missing or non-string 'azp'" });
  }

  const iss = c.iss;
  const aud = c.aud as JwtAudience;
  const exp = c.exp;
  const sub = c.sub;
  const azp = c.azp;

  // ── 2. Issuer ────────────────────────────────────────────────────────────
  if (iss !== opts.expectedIss) {
    return err({ kind: "wrong-issuer", expected: opts.expectedIss, actual: iss });
  }

  // ── 3. Audience ──────────────────────────────────────────────────────────
  if (!audienceMatches(aud, opts.expectedAud)) {
    return err({ kind: "wrong-audience", expected: opts.expectedAud, actual: aud });
  }

  // ── 4. Expiry (fail-closed: exp must be strictly in the future) ──────────
  if (exp <= opts.now) {
    return err({ kind: "expired", exp, now: opts.now });
  }

  return ok({ sub, azp } satisfies { sub: string; azp: string });
};

/** Re-export for callers that want the validated claims shape by name. */
export type { RealmJwtClaims };
