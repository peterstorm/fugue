/**
 * Supervisor → admin-tenants DISPATCH integration (C1, FR-025).
 *
 * Drives the supervisor's `handle` (the SAME function wired into `Bun.serve`'s
 * fetch) — NOT `handleAdminTenants` directly — against `/admin/tenants(/:id)`
 * requests, asserting the admin API is REACHABLE at runtime and that:
 *   - an ADMIN token routes to the admin handler and the mutation lands;
 *   - a NON-admin token is refused (401/403) at the admin handler, NOT proxied;
 *   - a non-admin-tenants path falls through to the normal proxy path.
 *
 * This closes the integration gap: `handleAdminTenants` was unreachable because
 * nothing in `handle` dispatched to it.
 */

import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import { createSupervisor } from "../../supervisor/supervisor.js";
import type { SupervisorDeps, AuthDeps, AdmissionPort } from "../../supervisor/supervisor.js";
import type { AdminTenantsDeps } from "../../http/handlers/admin/tenants.js";
import type { WorkerLifecyclePort } from "../../supervisor/lifecycle/spawn-port.js";
import { markTenant, tenantId } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { AdmissionDecision } from "../../supervisor/routing.js";
import type { HostConfig } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import { workerUnavailable } from "../../domain/host-error.js";
import { createRedisTenantRegistry, createInMemoryRedisFake } from "../../supervisor/registry/redis-registry-adapter.js";
import { createFakeAuditSink } from "../../supervisor/audit/audit-sink-log-redis.js";
import type { FakeAuditSink } from "../../supervisor/audit/audit-sink-log-redis.js";
import type { RedisTenantRegistry } from "../../supervisor/registry/redis-registry-adapter.js";

const ADMIN_TOKEN = "admin-secret";
const KEY = "internal-hmac-not-a-secret";
const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad id ${s}`);
  return r.value;
};

const fakeTokenStore: TokenStorePort = {
  resolve: async () => ok(null),
  store: async () => ok(undefined),
  listTeams: async () => ok([]),
  revoke: async () => ok(undefined),
};

const registryViewOf = (tenants: readonly Tenant[]): TenantRegistryView => ({
  tenantForTeam: (team) => tenants.find((t) => t.team === team),
});

const admissionAlways = (decision: AdmissionDecision): AdmissionPort => ({ admit: () => decision });

// A lifecycle that records every ensureWorker — used to PROVE an admin request is
// never routed/proxied as a tenant (ensureWorker must NOT be called for it).
interface RecordingLifecycle extends WorkerLifecyclePort {
  readonly ensured: readonly TenantId[];
}
const recordingLifecycle = (): RecordingLifecycle => {
  const ensured: TenantId[] = [];
  return {
    get ensured() { return ensured as readonly TenantId[]; },
    ensureWorker: async (t) => { ensured.push(t); return err(workerUnavailable(t)); },
    drain: async () => ok(undefined),
    evict: async () => ok(undefined),
    onCrash: async () => ok(undefined),
    reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
    liveWorkerCount: () => 0,
  };
};

const aliveRedis: RedisConnectivityPort = { ping: async () => ok(undefined) };

const baseConfig = {
  PORT: 0,
  WORKER_UDS_DIR: "/run/fugue",
  FUGUE_SUPERVISOR_HMAC_KEY: KEY,
  REDIS_PROBE_INTERVAL_MS: 1_000_000,
} as unknown as HostConfig;

const validBody = (id: string) => ({
  team: `${id}-team`,
  keycloakClientMapping: { realm: "fugue", clientId: `${id}-c`, agentClientIdsByDag: {} },
  fsRoot: `/srv/${id}`,
  secretsRef: `vault://${id}`,
  admission: { maxConcurrentRuns: 2, maxQueuedRuns: 4 },
  eagerPin: false,
});

interface Built {
  readonly supervisor: Awaited<ReturnType<typeof createSupervisor>>;
  readonly registry: RedisTenantRegistry;
  readonly audit: FakeAuditSink;
  readonly lifecycle: RecordingLifecycle;
}

const build = async (): Promise<Built> => {
  const fake = createInMemoryRedisFake();
  const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
  const audit = createFakeAuditSink();
  const lifecycle = recordingLifecycle();
  const auth: AuthDeps = { adminToken: ADMIN_TOKEN, tokenStore: fakeTokenStore, logger: silentLog };
  const adminTenants: AdminTenantsDeps = {
    auth,
    registry,
    lifecycle,
    tokenStore: fakeTokenStore,
    audit,
    now: () => 1_000,
    logger: silentLog,
  };
  const deps: SupervisorDeps = {
    config: baseConfig,
    redis: aliveRedis,
    auth,
    registryView: registryViewOf([markTenant(tid("acme"), "acme-team")]),
    admission: admissionAlways({ kind: "admitted" }),
    lifecycle,
    adminTenants,
    transport: async () => ok(new Response("PROXIED", { status: 200 })),
    logger: silentLog,
  };
  const supervisor = await createSupervisor(deps);
  if (!supervisor.ok) throw new Error("supervisor failed to start");
  return { supervisor, registry, audit, lifecycle };
};

const adminReq = (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request => {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["Authorization"] = `Bearer ${opts.token}`;
  return new Request(`http://supervisor${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
};

describe("supervisor dispatch → admin-tenants (C1, FR-025)", () => {
  it("routes an admin-token POST /admin/tenants/:id to the admin handler — the mutation lands", async () => {
    const b = await build();
    const res = await b.supervisor.value!.handle(adminReq("POST", "/admin/tenants/zeta", { token: ADMIN_TOKEN, body: validBody("zeta") }));
    expect(res.status).toBe(200);
    expect(b.registry.snapshot().entries.size).toBe(1);
    expect(b.registry.snapshot().entries.has(tid("zeta"))).toBe(true);
    // It was NOT proxied as a tenant — ensureWorker was never consulted.
    expect(b.lifecycle.ensured).toHaveLength(0);
    await b.supervisor.value!.shutdown();
  });

  it("refuses a NON-admin (unknown) token at /admin/tenants — 401, never proxied", async () => {
    const b = await build();
    const res = await b.supervisor.value!.handle(adminReq("POST", "/admin/tenants/zeta", { token: "not-admin", body: validBody("zeta") }));
    expect(res.status).toBe(401);
    expect(b.registry.snapshot().entries.size).toBe(0);
    expect(b.lifecycle.ensured).toHaveLength(0);
    await b.supervisor.value!.shutdown();
  });

  it("refuses an unauthenticated /admin/tenants request — 401, never proxied", async () => {
    const b = await build();
    const res = await b.supervisor.value!.handle(adminReq("DELETE", "/admin/tenants/zeta"));
    expect(res.status).toBe(401);
    expect(b.lifecycle.ensured).toHaveLength(0);
    await b.supervisor.value!.shutdown();
  });

  it("a non-admin-tenants path falls through to the normal proxy path", async () => {
    const b = await build();
    // A team-shaped path with an admin token resolves a tenant and proxies.
    const res = await b.supervisor.value!.handle(
      new Request("http://supervisor/dags/foo/run", { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }),
    );
    // Admin identity resolves to no tenant → 404 (tenant-unknown) at the proxy path —
    // NOT a 405/200 from the admin handler. The key assertion: it did NOT 200 from
    // the admin handler and the admin handler did not mutate.
    expect(res.status).toBe(404);
    expect(b.registry.snapshot().entries.size).toBe(0);
    await b.supervisor.value!.shutdown();
  });
});
