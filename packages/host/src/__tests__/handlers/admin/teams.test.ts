/**
 * Tests for admin team handlers (POST/GET/DELETE /admin/teams).
 *
 * Uses in-memory token store — no Redis.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createCreateTeamHandler, createListTeamsHandler, createRevokeTeamHandler } from "../../../http/handlers/admin/teams.js";
import type { AdminHandlerDeps } from "../../../http/handlers/admin/teams.js";
import { createInMemoryTokenStore } from "../../../adapters/token-store.js";
import { createAuthMiddleware } from "../../../http/middleware/auth.js";
import type { AuthEnv } from "../../../http/middleware/auth.js";
import { hashToken } from "../../../domain/auth.js";

// ── Test Helpers ───────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-secret-token-long-enough";
const FIXED_RANDOM = new Uint8Array(32).fill(7);

const createTestApp = () => {
  const tokenStore = createInMemoryTokenStore();
  const deps: AdminHandlerDeps = {
    tokenStore,
    clock: () => 1_000_000,
    generateRandomBytes: () => FIXED_RANDOM,
  };

  const app = new Hono<AuthEnv>();
  // Wire auth middleware so handlers can check identity
  app.use("*", createAuthMiddleware({ adminToken: ADMIN_TOKEN, tokenStore }));
  app.post("/admin/teams", createCreateTeamHandler(deps));
  app.get("/admin/teams", createListTeamsHandler(deps));
  app.delete("/admin/teams/:team", createRevokeTeamHandler(deps));

  return { app, tokenStore };
};

const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /admin/teams", () => {
  it("creates a team and returns the raw token", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-a", label: "Team A prod" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.team).toBe("team-a");
    expect(body.label).toBe("Team A prod");
    expect(body.token).toBeDefined();
    expect(body.token.startsWith("fug_")).toBe(true);
  });

  it("rejects duplicate team creation with 409", async () => {
    const { app } = createTestApp();

    // Create first
    await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-a" }),
    });

    // Try to create again
    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-a" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("team-already-exists");
  });

  it("rejects missing team field with 400", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "no team field" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects invalid team name format", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "UPPER_CASE" }),
    });

    expect(res.status).toBe(400);
  });

  it("normalizes team name to lowercase", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "Team-B" }),
    });

    // "Team-B" lowercased → "team-b" which is valid
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.team).toBe("team-b");
  });

  it("rejects requests without admin token", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-a" }),
    });

    expect(res.status).toBe(401);
  });

  it("uses default label when none provided", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-c" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.label).toBe("team-c token");
  });
});

describe("GET /admin/teams", () => {
  it("returns empty list when no teams provisioned", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams", { headers: adminHeaders });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.teams).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("returns provisioned teams after creation", async () => {
    const { app } = createTestApp();

    // Create a team first
    await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-x", label: "Team X" }),
    });

    const res = await app.request("/admin/teams", { headers: adminHeaders });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.teams[0].team).toBe("team-x");
    expect(body.teams[0].label).toBe("Team X");
  });

  it("rejects requests without admin token", async () => {
    const { app } = createTestApp();
    const res = await app.request("/admin/teams");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /admin/teams/:team", () => {
  it("revokes a team's token", async () => {
    const { app, tokenStore } = createTestApp();

    // Create team
    const createRes = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-revoke" }),
    });
    const { token } = await createRes.json();

    // Verify token works
    const hash = await hashToken(token);
    const grantResult = await tokenStore.resolve(hash);
    expect(grantResult.ok).toBe(true);
    expect(grantResult.ok && grantResult.value).not.toBeNull();
    const revokeRes = await app.request("/admin/teams/team-revoke", {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(revokeRes.status).toBe(200);

    const body = await revokeRes.json();
    expect(body.revoked).toBe(true);

    // Verify token no longer resolves
    const afterRevoke = await tokenStore.resolve(hash);
    expect(afterRevoke.ok && afterRevoke.value).toBeNull();
  });

  it("is idempotent — revoking non-existent team returns 200", async () => {
    const { app } = createTestApp();

    const res = await app.request("/admin/teams/non-existent", {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
  });

  it("rejects requests without admin token", async () => {
    const { app } = createTestApp();
    const res = await app.request("/admin/teams/team-a", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe("team token used for DAG access after provisioning", () => {
  it("provisioned token can be resolved from the store", async () => {
    const { app, tokenStore } = createTestApp();

    // Create team
    const res = await app.request("/admin/teams", {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ team: "team-verify" }),
    });
    const { token } = await res.json();

    // Hash the raw token and resolve — simulates what auth middleware does
    const hash = await hashToken(token);
    const grantResult = await tokenStore.resolve(hash);

    expect(grantResult.ok).toBe(true);
    const grant = grantResult.ok ? grantResult.value : null;
    expect(grant).not.toBeNull();
    expect(grant!.team).toBe("team-verify");
  });
});
