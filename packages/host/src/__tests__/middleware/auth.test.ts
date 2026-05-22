/**
 * Tests for bearer token auth middleware.
 *
 * Covers:
 * - Auth disabled (no token configured) → passthrough
 * - Missing Authorization header → 401
 * - Wrong scheme (not Bearer) → 401
 * - Invalid token → 401
 * - Valid token → passthrough
 * - Constant-time comparison (length mismatch short-circuits but still rejects)
 * - WWW-Authenticate header present on 401s
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "../../http/middleware/auth.js";

// ── Test App Factory ───────────────────────────────────────────────────────

const createApp = (token: string | undefined) => {
  const app = new Hono();
  app.use("*", createAuthMiddleware({ token }));
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("auth middleware", () => {
  describe("when auth is disabled (no token configured)", () => {
    it("passes through without any Authorization header", async () => {
      const app = createApp(undefined);
      const res = await app.request("/protected");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("when auth is enabled", () => {
    const TOKEN = "super-secret-token-at-least-16-chars";
    const app = createApp(TOKEN);

    it("rejects requests with no Authorization header", async () => {
      const res = await app.request("/protected");
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("Missing");
    });

    it("includes WWW-Authenticate header on missing auth", async () => {
      const res = await app.request("/protected");
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("rejects requests with wrong scheme (Basic)", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: `Basic ${btoa("user:pass")}` },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("Bearer scheme");
    });

    it("rejects requests with invalid token", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("Invalid");
    });

    it("includes WWW-Authenticate with error on invalid token", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
    });

    it("accepts requests with valid token", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("rejects token with matching prefix but different length", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${TOKEN}extra` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects token that is a prefix of the real token", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects empty bearer value", async () => {
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer " },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("health routes are not affected (router-level concern)", () => {
    it("middleware itself doesn't know about routes — router must register health before auth", async () => {
      // This is a design validation test:
      // Auth middleware is registered AFTER health routes in the router.
      // Health routes match before the auth middleware runs.
      // This test documents the contract — actual integration is tested in router tests.
      const app = new Hono();
      app.get("/health", (c) => c.json({ status: "ok" }));
      app.use("*", createAuthMiddleware({ token: "test-token-16chars" }));
      app.get("/protected", (c) => c.json({ ok: true }));

      // Health is accessible without auth
      const healthRes = await app.request("/health");
      expect(healthRes.status).toBe(200);

      // Protected requires auth
      const protectedRes = await app.request("/protected");
      expect(protectedRes.status).toBe(401);
    });
  });
});
