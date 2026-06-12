/**
 * Tests for the pure realm JWT claim validator (host domain).
 *
 * @satisfies FR-W3-006 — iss/aud enforcement for fugue-platform OIDC tokens.
 * @satisfies FR-W3-007 — sub/azp extraction on success.
 *
 * The validator is PURE and assumes the signature was already verified by the
 * injected verifier in the imperative shell — these tests exercise the claim
 * policy only (no crypto, no network).
 */

import { describe, it, expect } from "bun:test";
import { validateRealmJwtClaims, describeAuthError } from "../jwt-validation.js";
import type { RealmJwtClaims, SignatureVerifiedClaims } from "../jwt-validation.js";

const EXPECTED_ISS = "https://kc.example.com/realms/fugue-platform";
const EXPECTED_AUD = "fugue-host";
const NOW = 1_700_000_000; // UNIX seconds

const baseClaims = (over: Partial<RealmJwtClaims> = {}): RealmJwtClaims => ({
  iss: EXPECTED_ISS,
  aud: EXPECTED_AUD,
  exp: NOW + 300,
  sub: "user-123",
  azp: "fugue-frontend",
  ...over,
});

// These tests probe the DEFENSIVE value-level parse, so they deliberately feed
// malformed inputs. The `validateRealmJwtClaims` signature now requires
// `SignatureVerifiedClaims` (C5) — the brand attests SIGNATURE verification, not
// value sanity — so the test casts past the brand to exercise the runtime checks
// that still guard the claim VALUES.
const validate = (claims: unknown) =>
  validateRealmJwtClaims(claims as unknown as SignatureVerifiedClaims, {
    expectedIss: EXPECTED_ISS,
    expectedAud: EXPECTED_AUD,
    now: NOW,
  });

describe("validateRealmJwtClaims", () => {
  describe("valid", () => {
    it("returns ok({sub, azp}) for valid claims (aud as string)", () => {
      const res = validate(baseClaims());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.sub).toBe("user-123");
        expect(res.value.azp).toBe("fugue-frontend");
      }
    });

    it("accepts aud as an array containing the expected audience", () => {
      const res = validate(baseClaims({ aud: ["account", EXPECTED_AUD, "other"] }));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.sub).toBe("user-123");
    });
  });

  describe("malformed", () => {
    it("rejects a non-object", () => {
      const res = validate("not-an-object");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects null", () => {
      const res = validate(null);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects missing sub", () => {
      const { sub: _omit, ...rest } = baseClaims();
      const res = validate(rest);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects missing azp", () => {
      const { azp: _omit, ...rest } = baseClaims();
      const res = validate(rest);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects non-numeric exp", () => {
      const res = validate({ ...baseClaims(), exp: "soon" as unknown as number });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects an empty aud array", () => {
      const res = validate(baseClaims({ aud: [] }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects an aud array with a non-string element", () => {
      const res = validate(baseClaims({ aud: [EXPECTED_AUD, 42 as unknown as string] }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });
  });

  describe("wrong-issuer", () => {
    it("rejects a token from a different issuer", () => {
      const res = validate(baseClaims({ iss: "https://evil.example.com/realms/fugue-platform" }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.kind).toBe("wrong-issuer");
        if (res.error.kind === "wrong-issuer") expect(res.error.expected).toBe(EXPECTED_ISS);
      }
    });
  });

  describe("wrong-audience", () => {
    it("rejects a token whose aud (string) is not fugue-host", () => {
      const res = validate(baseClaims({ aud: "some-other-service" }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("wrong-audience");
    });

    it("rejects a token whose aud array lacks fugue-host", () => {
      const res = validate(baseClaims({ aud: ["account", "other"] }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("wrong-audience");
    });
  });

  describe("expired (boundary)", () => {
    it("rejects when exp < now", () => {
      const res = validate(baseClaims({ exp: NOW - 1 }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("expired");
    });

    it("rejects when exp === now (expiring exactly now is expired, fail-closed)", () => {
      const res = validate(baseClaims({ exp: NOW }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("expired");
    });

    it("accepts when exp === now + 1 (strictly future)", () => {
      const res = validate(baseClaims({ exp: NOW + 1 }));
      expect(res.ok).toBe(true);
    });
  });

  describe("non-finite now (fail-closed clock guard)", () => {
    // A NaN/Infinity `now` would make `exp <= now` evaluate to `false` even for
    // a long-expired token (`exp <= NaN` is always false), silently reviving it.
    // The guard rejects the bad clock as `malformed` BEFORE the expiry check, so
    // an expired token can never read as valid no matter the injected clock.
    const validateAt = (claims: unknown, now: number) =>
      validateRealmJwtClaims(claims as unknown as SignatureVerifiedClaims, { expectedIss: EXPECTED_ISS, expectedAud: EXPECTED_AUD, now });

    it("rejects a NaN now on an otherwise-valid-but-expired claim set (not ok)", () => {
      const expired = baseClaims({ exp: NOW - 1 });
      const res = validateAt(expired, Number.NaN);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects an Infinity now on an otherwise-valid-but-expired claim set (not ok)", () => {
      const expired = baseClaims({ exp: NOW - 1 });
      const res = validateAt(expired, Number.POSITIVE_INFINITY);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects a -Infinity now as malformed too", () => {
      const res = validateAt(baseClaims(), Number.NEGATIVE_INFINITY);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });
  });

  describe("nbf (not-before) — optional, fail-closed when present (review suggestion)", () => {
    it("rejects a token whose nbf is strictly after now as not-yet-valid", () => {
      const res = validate(baseClaims({ nbf: NOW + 60 } as never));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("not-yet-valid");
    });

    it("accepts a token whose nbf is at or before now", () => {
      expect(validate(baseClaims({ nbf: NOW } as never)).ok).toBe(true);
      expect(validate(baseClaims({ nbf: NOW - 60 } as never)).ok).toBe(true);
    });

    it("ignores an ABSENT nbf (nbf is optional)", () => {
      expect(validate(baseClaims()).ok).toBe(true);
    });

    it("rejects a PRESENT but non-numeric nbf as malformed (fail closed, matching exp's strict parse — A7)", () => {
      const res = validate(baseClaims({ nbf: "soon" } as never));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });

    it("rejects a PRESENT but non-finite nbf (NaN) as malformed", () => {
      const res = validate(baseClaims({ nbf: Number.NaN } as never));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("malformed");
    });
  });

  describe("describeAuthError", () => {
    it("never leaks token internals and covers every kind", () => {
      expect(describeAuthError({ kind: "malformed", reason: "x" })).toContain("malformed");
      expect(describeAuthError({ kind: "wrong-issuer", expected: "a", actual: "b" })).toContain("issuer");
      expect(describeAuthError({ kind: "wrong-audience", expected: "a", actual: "b" })).toContain("audience");
      expect(describeAuthError({ kind: "expired", exp: 1, now: 2 })).toContain("expired");
      expect(describeAuthError({ kind: "not-yet-valid", nbf: 2, now: 1 })).toContain("not yet valid");
    });
  });
});
