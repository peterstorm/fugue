/**
 * Supervisor end-to-end-ish tests with fakes (US3, FR-001/002/004/005/022/023,
 * FR-040/041).
 *
 * Covers:
 *   - authenticated KNOWN tenant routes + proxies (signed header reaches worker).
 *   - unknown identity → 404, no cross-tenant leakage.
 *   - degraded registry → 404 for NEW runs (admission fails closed) while a
 *     separate in-flight/status path (lookup) is unaffected.
 *   - the supervisor holds NO tenant secret (deps carry only auth/registry/
 *     routing/lifecycle — assert no secrets channel).
 *
 * createSupervisor starts a Bun.serve listener, so these tests target the
 * exposed `handle` directly (the same function wired into `fetch`) to avoid
 * binding a real port, and stop the server immediately.
 */

import { describe, it, expect } from "bun:test";
import {
  authenticateIdentity,
  presenceFromEnsure,
  assertNoTenantSecrets,
  buildLivenessResponse,
  buildReadinessResponse,
} from "../../supervisor/supervisor.js";
import { booting, bootComplete, redisDied, beginDrain, drainComplete, syncStarted } from "../../domain/host-state.js";
import type { HostState } from "../../domain/host-state.js";
import { emptyRegistry } from "../../domain/registry.js";
import { gitSha } from "@fuguejs/framework";
import type { AuthDeps, AdmissionPort, SupervisorDeps } from "../../supervisor/supervisor.js";
import type { WorkerLifecyclePort, EnsuredWorker } from "../../supervisor/lifecycle/spawn-port.js";
import { createSupervisor } from "../../supervisor/supervisor.js";
import { TENANT_HEADER } from "../../supervisor/uds-proxy.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
// Canonical verifier (the proxy no longer re-implements one — it imports the
// shared signer; the worker side uses exactly this verifier).
import { verifyTenantHeader } from "../../domain/tenant-header.js";
import { ok, err } from "@fuguejs/framework";
import { markTenant, tenantId } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { AdmissionDecision } from "../../supervisor/routing.js";
import type { HostError } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import { workerUnavailable } from "../../domain/host-error.js";
import { markSignatureVerified } from "../../domain/auth.js";
import type { RealmJwtClaims, SignatureVerifiedClaims } from "../../domain/auth.js";
import type { RealmJwtDeps } from "../../http/middleware/auth.js";
import { createRedisTenantRegistry, createInMemoryRedisFake } from "../../supervisor/registry/redis-registry-adapter.js";
import { tenantConfig } from "../../supervisor/registry/tenant-registry.js";
import { markSecretsRef } from "../../domain/tenant.js";

const KEY = "internal-hmac-not-a-secret";

const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const makeTenant = (id: string, team = `${id}-team`): Tenant => {
  const r = tenantId(id);
  if (!r.ok) throw new Error(`bad id ${id}`);
  return markTenant(r.value, team);
};

// ── Fakes ─────────────────────────────────────────────────────────────────────

const fakeTokenStore = (teamByHash: Record<string, { team: string; label: string }>): TokenStorePort => ({
  resolve: async (hash) => {
    const g = teamByHash[hash as unknown as string];
    return ok(g ? { team: g.team, label: g.label } : null);
  },
  // The rest of the port is unused by the supervisor's auth path; stub minimally.
  store: async () => ok(undefined),
  listTeams: async () => ok([]),
  revoke: async () => ok(undefined),
});

const registryViewOf = (tenants: readonly Tenant[]): TenantRegistryView => ({
  tenantForTeam: (team) => tenants.find((t) => t.team === team),
});

// Fake admission port matching the acquire-on-admit / release-on-completion
// contract: a fixed decision plus a no-op release. `admissionAlwaysTracked`
// exposes a release-call counter so tests can prove the supervisor invokes
// release after proxying (and on the worker-down refuse path).
const admissionAlways = (decision: AdmissionDecision): AdmissionPort => ({
  admit: () => ({ decision, release: () => {} }),
});

const admissionAlwaysTracked = (
  decision: AdmissionDecision,
): { port: AdmissionPort; releases: () => number } => {
  let releaseCount = 0;
  // Mirror the real contract: only an `admitted` decision ACQUIRES a slot and so
  // returns a counting release; a refusal returns a genuine no-op (nothing
  // acquired → nothing to free), so its counter never moves.
  const release =
    decision.kind === "admitted" ? () => { releaseCount += 1; } : () => {};
  return {
    port: { admit: () => ({ decision, release }) },
    releases: () => releaseCount,
  };
};

const lifecycleLive = (udsPath: string): WorkerLifecyclePort => ({
  ensureWorker: async () => ok<EnsuredWorker, HostError>({ udsPath }),
  drain: async () => ok(undefined),
  evict: async () => ok(undefined),
  onCrash: async () => ok(undefined),
  reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
  liveWorkerCount: () => 1,
  idleEvictSweep: async () => [],
  livenessSweep: async () => [],
});

// Records every tenant id passed to `ensureWorker`, while delegating to a live
// lifecycle (always-ok spawn) so the admitted path still proxies. Lets a test
// prove the supervisor does NOT cold-spawn a worker on a refused admission
// (no spawn storm during a Redis outage where admission fails closed).
const lifecycleRecording = (
  udsPath: string,
): { port: WorkerLifecyclePort; ensureCalls: () => readonly TenantId[] } => {
  const base = lifecycleLive(udsPath);
  const calls: TenantId[] = [];
  return {
    port: {
      ...base,
      ensureWorker: async (t) => {
        calls.push(t);
        return base.ensureWorker(t);
      },
    },
    ensureCalls: () => calls,
  };
};

const lifecycleDown: WorkerLifecyclePort = {
  ensureWorker: async (t) => err(workerUnavailable(t)),
  drain: async () => ok(undefined),
  evict: async () => ok(undefined),
  onCrash: async () => ok(undefined),
  reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
  liveWorkerCount: () => 0,
  idleEvictSweep: async () => [],
  livenessSweep: async () => [],
};

const aliveRedis: RedisConnectivityPort = { ping: async () => ok(undefined) };

const baseConfig = {
  PORT: 0,
  WORKER_UDS_DIR: "/run/fugue",
  FUGUE_SUPERVISOR_HMAC_KEY: KEY,
  REDIS_PROBE_INTERVAL_MS: 1_000_000, // effectively never fires during the test
} as unknown as HostConfig;

const buildDeps = (over: Partial<SupervisorDeps>): SupervisorDeps => ({
  config: baseConfig,
  redis: aliveRedis,
  auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({}), logger: silentLog } satisfies AuthDeps,
  registryView: registryViewOf([]),
  admission: admissionAlways({ kind: "admitted" }),
  lifecycle: lifecycleDown,
  transport: async () => ok(new Response("unused", { status: 200 })),
  logger: silentLog,
  ...over,
});

// ── authenticateIdentity (framework-agnostic, reuses auth primitives) ──────────

describe("authenticateIdentity", () => {
  const auth: AuthDeps = {
    adminToken: "admin-secret",
    tokenStore: fakeTokenStore({}),
    logger: silentLog,
  };

  it("admin token → admin identity", async () => {
    const r = await authenticateIdentity(auth, "Bearer admin-secret");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe("admin");
  });

  it("missing header → unauthorized (401)", async () => {
    const r = await authenticateIdentity(auth, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unauthorized");
  });

  it("unknown team token → unauthorized (401), never falls through to a tenant", async () => {
    const r = await authenticateIdentity(auth, "Bearer fug_unknowntoken");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unauthorized");
  });
});

// ── authenticateIdentity — JWT (user) path + team-store unavailability ─────────

describe("authenticateIdentity — JWT user path (FR-W3-006) + auth-infra failures", () => {
  // A JWT-SHAPED token: three non-empty base64url segments. Content is irrelevant
  // (the injected verifier is authoritative); only the SHAPE selects the path.
  const JWT = "aaa.bbb.ccc";

  const baseClaims = (over: Partial<RealmJwtClaims> = {}): SignatureVerifiedClaims =>
    markSignatureVerified({
      iss: "https://issuer.example/realms/fugue",
      aud: "fugue-host",
      exp: 9_999_999_999,
      sub: "user-1",
      azp: "client-1",
      teams: ["acme-team"],
      ...over,
    });

  const realmJwtOf = (over: Partial<RealmJwtDeps>): RealmJwtDeps => ({
    verify: async () => ok(baseClaims()),
    expectedIss: "https://issuer.example/realms/fugue",
    expectedAud: "fugue-host",
    authorizeUserRun: () => true,
    ...over,
  });

  const authWith = (realmJwt: RealmJwtDeps): AuthDeps => ({
    adminToken: "admin-secret",
    tokenStore: fakeTokenStore({}),
    realmJwt,
    logger: silentLog,
    now: () => 1_000, // seconds — well before exp
  });

  it("verifier REJECTS (invalid signature) → 401, never falls through to team path", async () => {
    const auth = authWith(realmJwtOf({ verify: async () => err({ kind: "invalid", reason: "bad sig" }) }));
    const r = await authenticateIdentity(auth, `Bearer ${JWT}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unauthorized");
  });

  it("verifier THROWS (JWKS outage) → 503 (redis-unavailable), NOT 401", async () => {
    const auth = authWith(realmJwtOf({ verify: async () => { throw new Error("jwks fetch failed"); } }));
    const r = await authenticateIdentity(auth, `Bearer ${JWT}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("redis-unavailable");
  });

  it("verifier UNAVAILABLE result → 503 (redis-unavailable), NOT 401", async () => {
    const auth = authWith(realmJwtOf({ verify: async () => err({ kind: "unavailable", reason: "jwks 503" }) }));
    const r = await authenticateIdentity(auth, `Bearer ${JWT}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("redis-unavailable");
  });

  it("claim validation FAILS (wrong audience) → 401", async () => {
    const auth = authWith(realmJwtOf({ verify: async () => ok(baseClaims({ aud: "some-other-host" })) }));
    const r = await authenticateIdentity(auth, `Bearer ${JWT}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unauthorized");
  });

  it("verified + valid claims → user identity carrying sub/azp", async () => {
    const auth = authWith(realmJwtOf({}));
    const r = await authenticateIdentity(auth, `Bearer ${JWT}`);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "user") {
      expect(r.value.sub).toBe("user-1");
      expect(r.value.azp).toBe("client-1");
    } else {
      throw new Error("expected user identity");
    }
  });

  it("team-store UNAVAILABLE → 503 (redis-unavailable), NOT 401", async () => {
    // A `fug_`-shaped token takes the team path; a store outage must NOT 401.
    const unavailableStore: TokenStorePort = {
      resolve: async () => err({ kind: "redis-unavailable", operation: "token-resolve" }),
      store: async () => ok(undefined),
      listTeams: async () => ok([]),
      revoke: async () => ok(undefined),
    };
    const auth: AuthDeps = { adminToken: "admin-secret", tokenStore: unavailableStore, logger: silentLog };
    const r = await authenticateIdentity(auth, "Bearer fug_sometoken");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("redis-unavailable");
  });
});

// ── Pure health/readiness response builders (full HostState ADT coverage) ──────

describe("buildLivenessResponse / buildReadinessResponse (pure, all phases)", () => {
  const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`transition failed: ${JSON.stringify(r.error)}`);
    return r.value;
  };
  // Build one representative of every reachable phase via the pure transitions.
  const bootingState: HostState = booting(0);
  const ready = unwrap(bootComplete(bootingState, emptyRegistry(), gitSha("test"), 1));
  const degraded = unwrap(redisDied(ready, 2)); // ready → degraded (redis-disconnected)
  const syncing = unwrap(syncStarted(ready, 3)); // ready → syncing
  const draining = unwrap(beginDrain(ready, 0, 4)); // ready → draining
  const stopped = unwrap(drainComplete(draining)); // draining → stopped

  it("/health is ALWAYS 200 (liveness): degraded reports status:degraded, every other phase status:ok", async () => {
    // degraded must still be 200 — a Redis outage ALERTS via the body, it must NOT
    // trigger a restart (the restart-storm the design avoids).
    const degradedRes = buildLivenessResponse(degraded);
    expect(degradedRes.status).toBe(200);
    expect((await degradedRes.json()) as { status: string }).toEqual({ status: "degraded" });

    for (const s of [ready, syncing, bootingState, draining, stopped]) {
      const res = buildLivenessResponse(s);
      expect(res.status).toBe(200);
      expect((await res.json()) as { status: string }).toEqual({ status: "ok" });
    }
  });

  it("/readiness gates traffic: 200 when canServeRequests (ready/degraded/syncing), 503 otherwise (booting/draining/stopped)", async () => {
    for (const s of [ready, degraded, syncing]) {
      const res = buildReadinessResponse(s);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ready: boolean }).ready).toBe(true);
    }
    // The operationally critical negative branch: an unready pod is kept OUT of the LB.
    for (const s of [bootingState, draining, stopped]) {
      const res = buildReadinessResponse(s);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ready: boolean; phase: string };
      expect(body.ready).toBe(false);
      expect(body.phase).toBe(s.phase);
    }
  });
});

// ── End-to-end pipeline via createSupervisor().handle ──────────────────────────

describe("createSupervisor — unauthenticated health probes (Docker HEALTHCHECK / k8s)", () => {
  it("GET /health returns 200 with NO Authorization header (handled before auth)", async () => {
    const sup = await createSupervisor(buildDeps({}));
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    try {
      const res = await sup.value.handle(new Request("http://host/health", { method: "GET" }));
      expect(res.status).toBe(200);
      expect((await res.json()) as { status: string }).toEqual({ status: "ok" });
    } finally {
      await sup.value.shutdown();
    }
  });

  it("GET /readiness returns 200 when the supervisor can serve", async () => {
    const sup = await createSupervisor(buildDeps({}));
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    try {
      const res = await sup.value.handle(new Request("http://host/readiness", { method: "GET" }));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ready: boolean }).ready).toBe(true);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("a non-GET /health is NOT short-circuited (falls through to auth → 401)", async () => {
    const sup = await createSupervisor(buildDeps({}));
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    try {
      const res = await sup.value.handle(new Request("http://host/health", { method: "POST", body: "{}" }));
      expect(res.status).toBe(401);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("GET /readiness returns 503 once the supervisor is draining/stopped (kept OUT of the load-balancer)", async () => {
    const sup = await createSupervisor(buildDeps({}));
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    // Drive the REAL shutdown transition (ready → draining → stopped); the handle
    // closure still answers probes off the now-unready state. This exercises the 503
    // branch THROUGH `handle` (not just the pure builder), pinning the status wiring.
    await sup.value.shutdown();
    const res = await sup.value.handle(new Request("http://host/readiness", { method: "GET" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ready: boolean }).ready).toBe(false);
  });
});

describe("createSupervisor — routing + proxy with fakes", () => {
  it("authenticated KNOWN tenant routes + proxies, attaching a verifiable signed header", async () => {
    // team token 'fug_acme' → team 'acme-team' → tenant 'acme'
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    let proxiedHeader: string | null = null;
    const transport: UdsTransport = async (sock, req) => {
      expect(sock).toBe("/run/fugue/acme.sock");
      proxiedHeader = req.headers.get(TENANT_HEADER);
      return ok(new Response(JSON.stringify({ runId: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    };
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: admissionAlways({ kind: "admitted" }),
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
      transport,
    });
    const sup = await createSupervisor(deps);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runId: "r1" });
      expect(proxiedHeader).not.toBeNull();
      // The stamped header verifies under the canonical worker-side verifier as
      // bound to acme (proves supervisor↔worker agreement, no drift).
      expect(verifyTenantHeader(KEY, "acme", proxiedHeader!)).toEqual({ kind: "ok" });
    } finally {
      await sup.value.shutdown();
    }
  });

  it("unknown identity (unresolvable tenant) → 404 with NO cross-tenant leakage", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_ghost")) as unknown as string;
    const acme = makeTenant("acme");
    // token resolves to team 'ghost-team' which owns NO registered tenant
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "ghost-team", label: "ghost" } }), logger: silentLog },
      registryView: registryViewOf([acme]),
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_ghost" }, body: "{}" }));
      expect(res.status).toBe(404);
      const body = await res.text();
      // non-leaking: must not reveal any other tenant's id/existence
      expect(body).not.toContain("acme");
      expect(body).toContain("not found");
    } finally {
      await sup.value.shutdown();
    }
  });

  it("admission unknown (degraded registry, FR-022) → 404 for NEW runs", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      // resolveForNewRun fails closed while degraded → admission 'unknown'
      admission: admissionAlways({ kind: "unknown" }),
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(404); // tenant-unknown, non-leaking
    } finally {
      await sup.value.shutdown();
    }
  });

  it("worker down → 503 for THAT tenant only (contained, named only as own tenant)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: admissionAlways({ kind: "admitted" }),
      lifecycle: lifecycleDown,
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
    } finally {
      await sup.value.shutdown();
    }
  });

  it("defensively refuses (503) if lifecycle returns a NON-owning socket (FR-004)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    let transportCalled = false;
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: admissionAlways({ kind: "admitted" }),
      // lifecycle hands back a DIFFERENT tenant's socket — must be rejected
      lifecycle: lifecycleLive("/run/fugue/victim.sock"),
      transport: async () => { transportCalled = true; return ok(new Response("leak", { status: 200 })); },
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(503);
      expect(transportCalled).toBe(false); // never proxied to the wrong socket
    } finally {
      await sup.value.shutdown();
    }
  });

  it("missing Authorization → 401", async () => {
    const sup = await createSupervisor(buildDeps({}));
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", body: "{}" }));
      expect(res.status).toBe(401);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("over-quota admission → 429 + Retry-After (per-tenant backoff), end-to-end (SC-012)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    let transportCalled = false;
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      // Drive admission with a fake returning over-quota (the per-tenant ceiling
      // is T9/Wave-4; here we prove the routing/error path is reachable + tested).
      admission: admissionAlways({ kind: "over-quota", retryAfterSeconds: 12 }),
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
      transport: async () => { transportCalled = true; return ok(new Response("x", { status: 200 })); },
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("12"); // the per-tenant backoff
      expect(transportCalled).toBe(false); // refused before proxying
    } finally {
      await sup.value.shutdown();
    }
  });

  it("admitted request RELEASES the per-tenant slot after proxying (acquire-on-admit / release-on-completion)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const tracked = admissionAlwaysTracked({ kind: "admitted" });
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: tracked.port,
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
      transport: async () => ok(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(200);
      // The slot acquired on admit is freed exactly once after the proxy returns.
      expect(tracked.releases()).toBe(1);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("admitted request RELEASES the slot even when the proxy THROWS (finally guarantees release)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const tracked = admissionAlwaysTracked({ kind: "admitted" });
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: tracked.port,
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
      // Transport throws — proxyToWorker rejects — the supervisor's `finally` MUST
      // still release the per-tenant slot so a faulting proxy never leaks a slot.
      transport: async () => { throw new Error("transport blew up"); },
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      // The handler may resolve to a 5xx or reject; either way, release runs.
      await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" })).catch(() => {});
      expect(tracked.releases()).toBe(1);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("admitted-but-worker-down refuse path RELEASES the acquired slot (no leak on 503)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const tracked = admissionAlwaysTracked({ kind: "admitted" });
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: tracked.port, // admit SUCCEEDS (slot acquired)
      lifecycle: lifecycleDown, // but the worker is unavailable → routing refuses
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(503);
      // The slot acquired on admit MUST be released even though routing refused.
      expect(tracked.releases()).toBe(1);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("REFUSED admit (over-quota) does NOT call release (nothing acquired)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const tracked = admissionAlwaysTracked({ kind: "over-quota", retryAfterSeconds: 7 });
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: tracked.port,
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(429);
      // The over-quota refusal acquired NO slot, so its release is a genuine
      // no-op; the supervisor calling it on the refuse path frees nothing.
      expect(tracked.releases()).toBe(0);
    } finally {
      await sup.value.shutdown();
    }
  });

  // ── REGRESSION: refused admission MUST NOT cold-spawn a worker ────────────────
  // A spawn-on-refuse would, during a Redis outage (resolveForNewRun fails closed
  // to `unknown` for EVERY active tenant), cold-spawn one worker per request — each
  // unable to reach Redis at boot and SIGKILLed — amplifying the fault under the
  // exact condition the box is already stressed. The supervisor must call
  // `ensureWorker` ONLY for an ADMITTED request; a refused admit (unknown /
  // over-quota / unavailable) sets presence=unavailable and lets the pure router
  // produce the refusal WITHOUT spawning.

  it("admission unknown (degraded registry) → 404 WITHOUT cold-spawning a worker (no spawn storm)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const recording = lifecycleRecording("/run/fugue/acme.sock");
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      // resolveForNewRun fails closed while degraded → admission 'unknown'
      admission: admissionAlways({ kind: "unknown" }),
      lifecycle: recording.port,
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(404); // tenant-unknown, non-leaking
      // The pivotal assertion: a refused admit NEVER cold-spawns the worker.
      expect(recording.ensureCalls()).toEqual([]);
    } finally {
      await sup.value.shutdown();
    }
  });

  it("over-quota admission → 429 WITHOUT cold-spawning a worker", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const recording = lifecycleRecording("/run/fugue/acme.sock");
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: admissionAlways({ kind: "over-quota", retryAfterSeconds: 12 }),
      lifecycle: recording.port,
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(429);
      expect(recording.ensureCalls()).toEqual([]); // refused before any spawn
    } finally {
      await sup.value.shutdown();
    }
  });

  it("admission unavailable → refused WITHOUT cold-spawning a worker", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const recording = lifecycleRecording("/run/fugue/acme.sock");
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: admissionAlways({ kind: "unavailable" }),
      lifecycle: recording.port,
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).not.toBe(200); // a refusal, not a proxied success
      expect(recording.ensureCalls()).toEqual([]); // never spawned on refuse
    } finally {
      await sup.value.shutdown();
    }
  });

  it("ADMITTED request DOES cold-spawn the worker exactly once and routes (sanity for the refuse-path guard)", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;
    const tenant = makeTenant("acme");
    const recording = lifecycleRecording("/run/fugue/acme.sock");
    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView: registryViewOf([tenant]),
      admission: admissionAlways({ kind: "admitted" }),
      lifecycle: recording.port,
      transport: async () => ok(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      const res = await sup.value.handle(new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" }));
      expect(res.status).toBe(200);
      // Admitted → ensureWorker invoked exactly once, for THIS tenant only.
      expect(recording.ensureCalls()).toEqual([tenant.id]);
    } finally {
      await sup.value.shutdown();
    }
  });
});

// ── FR-022 — Redis-probe DOWN drives the registry's NEW-run gate closed ─────────

describe("FR-022 — probe→registry degraded gate (real registry + in-memory Redis)", () => {
  it("probe DOWN → NEW run refused (503/404) while in-flight lookup still resolves; recovery re-admits", async () => {
    const { hashToken } = await import("../../domain/auth.js");
    const hash = (await hashToken("fug_acme")) as unknown as string;

    // A REAL Redis-backed tenant registry over the in-memory fake, with 'acme'
    // registered + active. This is the registry whose `resolveForNewRun` gate the
    // probe must flip.
    const fake = createInMemoryRedisFake();
    const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
    const acmeId = tenantId("acme");
    if (!acmeId.ok) throw new Error("bad id");
    const cfgR = tenantConfig({
      id: acmeId.value,
      team: "acme-team",
      keycloakClientMapping: { realm: "r", clientId: "c", agentClientIdsByDag: {} },
      fsRoot: "/srv/acme",
      dagsRoot: "/dags/acme",
      secretsRef: markSecretsRef("vault://acme/env"),
      admission: { maxConcurrentRuns: 10, maxQueuedRuns: 10 },
      eagerPin: false,
    });
    if (!cfgR.ok) throw new Error("bad cfg");
    await registry.register(cfgR.value, 0);

    const registryView: TenantRegistryView = {
      tenantForTeam: (team) => team === "acme-team" ? markTenant(acmeId.value, "acme-team") : undefined,
    };
    // NEW-run admission gate bound to resolveForNewRun (exactly as main-supervisor).
    const admission: AdmissionPort = {
      admit: (t) =>
        registry.resolveForNewRun(t.id).ok
          ? { decision: { kind: "admitted" }, release: () => {} }
          : { decision: { kind: "unknown" }, release: () => {} },
    };

    const deps = buildDeps({
      auth: { adminToken: "admin-secret", tokenStore: fakeTokenStore({ [hash]: { team: "acme-team", label: "acme" } }), logger: silentLog },
      registryView,
      admission,
      lifecycle: lifecycleLive("/run/fugue/acme.sock"),
      transport: async () => ok(new Response(JSON.stringify({ runId: "r1" }), { status: 200, headers: { "Content-Type": "application/json" } })),
      // Wire the probe edge → registry gate (FR-022), exactly as main-supervisor.
      onRedisProbeEdge: (dead) => registry.markRedisDegraded(dead),
    });
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    const mkReq = () => new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: "Bearer fug_acme" }, body: "{}" });
    try {
      // Healthy: a NEW run is admitted + proxied (200).
      expect((await sup.value.handle(mkReq())).status).toBe(200);

      // Probe observes Redis DOWN → gate closes.
      deps.onRedisProbeEdge!(true);
      const downRes = await sup.value.handle(mkReq());
      expect(downRes.status).toBe(404); // tenant-unknown (fail-closed, non-leaking)
      // In-flight / status path (lookup, NOT resolveForNewRun) is unaffected (FR-023).
      expect(registry.lookup(acmeId.value).ok).toBe(true);
      // canServeRequests is intentionally NOT widened to block while degraded.

      // Probe sees Redis back → gate re-opens, NEW runs admitted again.
      deps.onRedisProbeEdge!(false);
      expect((await sup.value.handle(mkReq())).status).toBe(200);
    } finally {
      await sup.value.shutdown();
    }
  });
});

// ── FR-005: supervisor holds NO tenant secret ──────────────────────────────────

describe("FR-005 — supervisor deps carry no tenant-secret channel", () => {
  it("SupervisorDeps exposes only auth/registry/admission/lifecycle/routing — no secret value", () => {
    const deps = buildDeps({});
    // The registry view returns a Tenant (id + team) — no secret field.
    const t = deps.registryView.tenantForTeam("acme-team");
    expect(t).toBeUndefined(); // empty registry in base deps
    // Structural witness: assertNoTenantSecrets is a no-op (the guarantee is in
    // the shape). The deps' own-enumerable keys never include a secret channel.
    expect(() => assertNoTenantSecrets(deps)).not.toThrow();
    const keys = Object.keys(deps);
    expect(keys).not.toContain("secrets");
    expect(keys).not.toContain("secretsSource");
    expect(keys).not.toContain("tenantSecrets");
    // The HMAC key on config is the INTERNAL key, not a tenant secret.
    expect(deps.config.FUGUE_SUPERVISOR_HMAC_KEY).toBe(KEY);
  });
});

// ── presenceFromEnsure mapping ─────────────────────────────────────────────────

describe("presenceFromEnsure", () => {
  it("ok(EnsuredWorker) → live with its udsPath; err → unavailable", () => {
    expect(presenceFromEnsure(ok({ udsPath: "/run/fugue/acme.sock" }))).toEqual({ kind: "live", socketPath: "/run/fugue/acme.sock" });
    expect(presenceFromEnsure(err(workerUnavailable("acme" as TenantId)))).toEqual({ kind: "unavailable" });
  });
});
