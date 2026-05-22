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
import { createAuthMiddleware } from "../../http/middleware/auth.js";
import type { AuthMiddlewareDeps } from "../../http/middleware/auth.js";
import { createInMemoryTokenStore } from "../../adapters/token-store.js";
import { hashToken, formatToken } from "../../domain/auth.js";
import type { AuthIdentity, TokenHash } from "../../domain/auth.js";
import type { AuthEnv } from "../../http/middleware/auth.js";

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
