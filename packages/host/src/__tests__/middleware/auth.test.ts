/**
 * Tests for bearer token auth middleware — team-scoped.
 *
 * Covers:
 * - Missing/malformed Authorization header → 401
 * - Admin token → sets admin identity
 * - Valid team token → resolves from store, sets team identity
 * - Invalid/unknown token → 401
 * - Health routes unaffected (router-level concern)
 * - WWW-Authenticate headers on 401s
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { ok, err } from "@fuguejs/framework";
import { createAuthMiddleware, isJwtShape } from "../../http/middleware/auth.js";
import type { AuthMiddlewareDeps, VerifyRealmJwt } from "../../http/middleware/auth.js";
import { createInMemoryTokenStore } from "../../adapters/token-store.js";
import { hashToken, formatToken, isTeamTokenShape } from "../../domain/auth.js";
import type { AuthIdentity, TokenHash, RealmJwtClaims } from "../../domain/auth.js";
import { markSignatureVerified } from "../../domain/auth.js";
import type { AuthEnv } from "../../http/middleware/auth.js";
import type { TokenStorePort } from "../../ports.js";

// ── Test Fixtures ──────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-secret-token-long-enough";

const createDeps = (
  seed: Array<{ team: string; hash: TokenHash; grant: { team: string; label: string; createdAt: number } }> = [],
): AuthMiddlewareDeps => ({
  adminToken: ADMIN_TOKEN,
  tokenStore: createInMemoryTokenStore(seed),
});

const createApp = (deps: AuthMiddlewareDeps) => {
  const app = new Hono<AuthEnv>();
  app.use("*", createAuthMiddleware(deps));
  app.get("/protected", (c) => {
    const identity = c.get("authIdentity");
    return c.json({ ok: true, identity });
  });
  return app;
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("auth middleware", () => {
  describe("missing/malformed header", () => {
    it("rejects with 401 when no Authorization header", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected");
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("Missing");
    });

    it("includes WWW-Authenticate header on missing auth", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected");
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("rejects with 401 when wrong scheme (Basic)", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: `Basic ${btoa("user:pass")}` },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("Bearer scheme");
    });

    it("rejects empty bearer value", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer " },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("admin token", () => {
    it("accepts admin token and sets admin identity", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.identity).toEqual({ kind: "admin" });
    });

    it("rejects token that is close to admin token but not exact", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}x` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("team token", () => {
    it("resolves valid team token and sets team identity", async () => {
      const rawToken = formatToken(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await hashToken(rawToken);
      const grant = { team: "team-a", label: "Team A", createdAt: 1000 };

      const deps = createDeps([{ team: "team-a", hash, grant }]);
      const app = createApp(deps);

      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.identity).toEqual({ kind: "team", team: "team-a", label: "Team A" });
    });

    it("rejects unknown token with 401", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer fug_unknown-token-that-does-not-exist-in-store" },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("Invalid");
    });

    it("includes WWW-Authenticate with error on invalid team token", async () => {
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer fug_invalid-token-not-in-store-at-all!" },
      });
      expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
    });
  });

  describe("fail-closed on infrastructure failure", () => {
    // A well-formed, non-admin bearer token that reaches Path 2 (hash → store lookup).
    const teamToken = "fug_well-formed-team-token-not-the-admin-secret";

    const buildApp = (
      tokenStore: TokenStorePort,
      logger?: AuthMiddlewareDeps["logger"],
    ) => {
      const app = new Hono<AuthEnv>();
      app.use("*", createAuthMiddleware({ adminToken: ADMIN_TOKEN, tokenStore, logger }));
      // If this handler ever runs, the request fell THROUGH the failing middleware — a bug.
      app.get("/protected", (c) => c.json({ ok: true, reached: true }));
      return app;
    };

    it("returns 503 (not 401, not fall-through) when the token store reports an err", async () => {
      const failingStore: TokenStorePort = {
        resolve: async () => err({ kind: "redis-unavailable", operation: "resolve" }),
        store: async () => err({ kind: "redis-unavailable", operation: "store" }),
        listTeams: async () => err({ kind: "redis-unavailable", operation: "listTeams" }),
        revoke: async () => err({ kind: "redis-unavailable", operation: "revoke" }),
      };
      const res = await buildApp(failingStore).request("/protected", {
        headers: { Authorization: `Bearer ${teamToken}` },
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("auth-service-unavailable");
      // The protected handler must NOT have run — fail closed, never through.
      expect(body.reached).toBeUndefined();
    });

    it("returns 503 and logs server-side when token resolution throws unexpectedly", async () => {
      const loggedErrors: string[] = [];
      const throwingStore: TokenStorePort = {
        resolve: async () => { throw new Error("redis socket exploded"); },
        store: async () => err({ kind: "redis-unavailable", operation: "store" }),
        listTeams: async () => err({ kind: "redis-unavailable", operation: "listTeams" }),
        revoke: async () => err({ kind: "redis-unavailable", operation: "revoke" }),
      };
      const res = await buildApp(throwingStore, {
        info: () => {},
        warn: () => {},
        error: (msg) => { loggedErrors.push(msg); },
      }).request("/protected", {
        headers: { Authorization: `Bearer ${teamToken}` },
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("auth-service-unavailable");
      expect(body.reached).toBeUndefined();
      // The unexpected error is logged server-side for diagnostics (never leaked to the client).
      expect(loggedErrors.some((m) => m.includes("Token resolution failed"))).toBe(true);
      expect(body.message).not.toContain("socket exploded");
    });
  });

  describe("fugue-platform JWT (user) path", () => {
    // A structurally-valid JWT compact serialization: three non-empty base64url
    // segments. The bytes are irrelevant — the FAKE verifier decides the outcome,
    // never real crypto/JWKS. This keeps the test hermetic.
    const FAKE_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJl";
    const EXPECTED_ISS = "https://kc.example.com/realms/fugue-platform";
    const EXPECTED_AUD = "fugue-host";
    const NOW_SECONDS = 1_700_000_000;

    const validClaims: RealmJwtClaims = {
      iss: EXPECTED_ISS,
      aud: EXPECTED_AUD,
      exp: NOW_SECONDS + 300,
      sub: "user-123",
      azp: "fugue-frontend",
    };

    const jwtDeps = (
      verify: VerifyRealmJwt,
      over: Partial<AuthMiddlewareDeps> = {},
    ): AuthMiddlewareDeps => ({
      adminToken: ADMIN_TOKEN,
      tokenStore: createInMemoryTokenStore([]),
      realmJwt: { verify, expectedIss: EXPECTED_ISS, expectedAud: EXPECTED_AUD },
      now: () => NOW_SECONDS,
      ...over,
    });

    it("accepts a valid fugue-platform JWT and sets a user identity", async () => {
      const verify: VerifyRealmJwt = async () => ok(markSignatureVerified(validClaims));
      const app = createApp(jwtDeps(verify));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.identity).toEqual({ kind: "user", sub: "user-123", azp: "fugue-frontend" });
    });

    it("rejects a wrong-aud JWT with 401 (does not fall through to team path)", async () => {
      const verify: VerifyRealmJwt = async () =>
        ok(markSignatureVerified({ ...validClaims, aud: "some-other-service" }));
      const app = createApp(jwtDeps(verify));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("unauthorized");
    });

    it("rejects an expired JWT with 401", async () => {
      const verify: VerifyRealmJwt = async () =>
        ok(markSignatureVerified({ ...validClaims, exp: NOW_SECONDS - 1 }));
      const app = createApp(jwtDeps(verify));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects a JWT with an invalid signature (verifier 'invalid') with 401", async () => {
      const verify: VerifyRealmJwt = async () =>
        err({ kind: "invalid", reason: "signature mismatch" });
      const app = createApp(jwtDeps(verify));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      // The internal reason must never leak to the client.
      expect(JSON.stringify(body)).not.toContain("signature mismatch");
    });

    it("returns 503 when the verifier reports infrastructure 'unavailable'", async () => {
      const verify: VerifyRealmJwt = async () =>
        err({ kind: "unavailable", reason: "JWKS fetch failed" });
      const app = createApp(jwtDeps(verify));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("auth-service-unavailable");
    });

    it("returns 503 (fail closed) when the verifier throws unexpectedly", async () => {
      const verify: VerifyRealmJwt = async () => { throw new Error("boom in verifier"); };
      const app = createApp(jwtDeps(verify));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("boom in verifier");
    });

    it("rejects a JWT-shaped token when NO verifier is configured (falls through to 401)", async () => {
      // No verifyRealmJwt → JWT path disabled → token is unknown to the team
      // store → 401. A JWT must never be accepted without signature verification.
      const app = createApp(createDeps());
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${FAKE_JWT}` },
      });
      expect(res.status).toBe(401);
    });

    // NOTE: there is deliberately NO "verifier wired without iss/aud policy"
    // test any more — `RealmJwtDeps` groups verifier + policy as one optional
    // unit, so that half-wired state is unrepresentable at the type level (the
    // former runtime 503 misconfig branch deleted itself with it).
  });

  describe("regression: admin + fug_ paths unchanged when JWT verifier is present", () => {
    // Even with a JWT verifier wired, the opaque paths must resolve exactly as
    // before — neither the admin token nor a `fug_` token is JWT-shaped.
    const verify: VerifyRealmJwt = async () => err({ kind: "invalid", reason: "should not be called" });
    const depsWithJwt = (
      seed: Array<{ team: string; hash: TokenHash; grant: { team: string; label: string; createdAt: number } }> = [],
    ): AuthMiddlewareDeps => ({
      adminToken: ADMIN_TOKEN,
      tokenStore: createInMemoryTokenStore(seed),
      realmJwt: {
        verify,
        expectedIss: "https://kc.example.com/realms/fugue-platform",
        expectedAud: "fugue-host",
      },
    });

    it("admin token still yields admin identity", async () => {
      const app = createApp(depsWithJwt());
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).identity).toEqual({ kind: "admin" });
    });

    it("fug_ team token still resolves to team identity", async () => {
      const rawToken = formatToken(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await hashToken(rawToken);
      const grant = { team: "team-a", label: "Team A", createdAt: 1000 };
      const app = createApp(depsWithJwt([{ team: "team-a", hash, grant }]));
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).identity).toEqual({ kind: "team", team: "team-a", label: "Team A" });
    });

    it("a token that is BOTH fug_-shaped AND JWT-shaped resolves via the TEAM path; the verifier records ZERO calls (review I5/A9)", async () => {
      // base64url admits 'f','u','g','_', so a `fug_` token CAN be JWT-shaped:
      // three dot-separated base64url segments whose first segment starts with
      // the team prefix. The `!isTeamTokenShape` guard must route it to the team
      // store — never the JWT path.
      const ambiguous = `fug_${"A".repeat(50)}.eyJzdWIiOiJ4In0.c2lnbmF0dXJl`;
      // Premise: the token genuinely satisfies BOTH structural predicates.
      expect(isTeamTokenShape(ambiguous)).toBe(true);
      expect(isJwtShape(ambiguous)).toBe(true);

      const verifierCalls: string[] = [];
      const recordingVerify: VerifyRealmJwt = async (t) => {
        verifierCalls.push(t);
        return err({ kind: "invalid", reason: "must never be called" });
      };
      const app = createApp({
        adminToken: ADMIN_TOKEN,
        tokenStore: createInMemoryTokenStore([]),
        realmJwt: {
          verify: recordingVerify,
          expectedIss: "https://kc.example.com/realms/fugue-platform",
          expectedAud: "fugue-host",
        },
      });
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${ambiguous}` },
      });

      // TEAM-path outcome: no grant exists for it → 401 invalid_token …
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
      const body = await res.json();
      expect(body.message).toContain("Invalid");
      // … and the JWT verifier was NEVER consulted.
      expect(verifierCalls).toEqual([]);
    });
  });

  describe("health routes excluded (router-level concern)", () => {
    it("health routes registered before auth middleware bypass auth", async () => {
      const app = new Hono();
      // Health registered before auth (same as router.ts does)
      app.get("/health", (c) => c.json({ status: "ok" }));
      app.use("*", createAuthMiddleware(createDeps()));
      app.get("/protected", (c) => c.json({ ok: true }));

      const healthRes = await app.request("/health");
      expect(healthRes.status).toBe(200);

      const protectedRes = await app.request("/protected");
      expect(protectedRes.status).toBe(401);
    });
  });
});
