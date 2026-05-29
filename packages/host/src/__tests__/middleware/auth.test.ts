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
import { err } from "@fugue/framework";
import { createAuthMiddleware } from "../../http/middleware/auth.js";
import type { AuthMiddlewareDeps } from "../../http/middleware/auth.js";
import { createInMemoryTokenStore } from "../../adapters/token-store.js";
import { hashToken, formatToken } from "../../domain/auth.js";
import type { AuthIdentity, TokenHash } from "../../domain/auth.js";
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
