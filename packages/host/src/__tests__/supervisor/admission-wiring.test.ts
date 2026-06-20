/**
 * Admission WIRING integration test (T9, FR-032 / FR-038, SC-011 / SC-012).
 *
 * Proves the gap is CLOSED through the REAL per-tenant admission ADT — NOT a
 * fake admission port. It builds the SAME stateful admit binding `main-supervisor.ts`
 * wires (resolveForNewRun → withTenantLimit → admitTenant → release), drives it
 * through `createSupervisor().handle`, and shows:
 *
 *   - a tenant AT its per-tenant ceiling gets a 429 + per-tenant Retry-After
 *     (FR-038) — over-quota is reachable in production, not just under a fake.
 *   - a DIFFERENT tenant is UNAFFECTED by the first tenant's saturation
 *     (SC-011 anti-starvation, SC-012 no cross-tenant bleed).
 *   - releasing an in-flight slot RE-OPENS the tenant's ceiling (acquire/release).
 *
 * The admit body holds an in-flight slot for the duration of the proxy, so to
 * saturate a ceiling-of-1 tenant we use a transport whose first call BLOCKS on a
 * gate we control, keeping the first run's slot held while the second request
 * races in and is refused 429.
 */

import { describe, it, expect } from "bun:test";
import { createSupervisor } from "../../supervisor/supervisor.js";
import type { AdmissionPort, AdmissionOutcome, AuthDeps, SupervisorDeps } from "../../supervisor/supervisor.js";
import type { WorkerLifecyclePort, EnsuredWorker } from "../../supervisor/lifecycle/spawn-port.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
import { ok } from "@fuguejs/framework";
import { markTenant, tenantId } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { HostError } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import {
  initTenantConcurrency,
  withTenantLimit,
  admitTenant,
  releaseTenant,
} from "../../supervisor/admission.js";
import type { TenantConcurrencyState } from "../../supervisor/admission.js";
import { createRedisTenantRegistry, createInMemoryRedisFake } from "../../supervisor/registry/redis-registry-adapter.js";
import { tenantConfig } from "../../supervisor/registry/tenant-registry.js";
import { markSecretsRef } from "../../domain/tenant.js";

const KEY = "internal-hmac-not-a-secret";
const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };
const aliveRedis: RedisConnectivityPort = { ping: async () => ok(undefined) };

const baseConfig = {
  PORT: 0,
  WORKER_UDS_DIR: "/run/fugue",
  FUGUE_SUPERVISOR_HMAC_KEY: KEY,
  REDIS_PROBE_INTERVAL_MS: 1_000_000,
} as unknown as HostConfig;

const fakeTokenStore = (teamByHash: Record<string, { team: string; label: string }>): TokenStorePort => ({
  resolve: async (hash) => {
    const g = teamByHash[hash as unknown as string];
    return ok(g ? { team: g.team, label: g.label } : null);
  },
  store: async () => ok(undefined),
  listTeams: async () => ok([]),
  revoke: async () => ok(undefined),
});

const lifecycleLiveByTenant = (sockOf: (t: TenantId) => string): WorkerLifecyclePort => ({
  ensureWorker: async (t) => ok<EnsuredWorker, HostError>({ udsPath: sockOf(t) }),
  drain: async () => ok(undefined),
  evict: async () => ok(undefined),
  onCrash: async () => ok(undefined),
  reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
  liveWorkerCount: () => 1,
  idleEvictSweep: async () => [],
  livenessSweep: async () => [],
});

/**
 * Build the SAME stateful admit binding `main-supervisor.ts` wires, over the REAL
 * `admitTenant` ADT. `releasedTokens`/`tenantConc` exposed so a test can inspect
 * state, but the binding itself is verbatim production logic.
 */
const buildRealAdmission = (registry: ReturnType<typeof createRedisTenantRegistry>): AdmissionPort => {
  let tenantConc: TenantConcurrencyState = initTenantConcurrency();
  const noopRelease = (): void => {};
  return {
    admit: (tenant: Tenant): AdmissionOutcome => {
      const resolved = registry.resolveForNewRun(tenant.id);
      if (!resolved.ok) return { decision: { kind: "unknown" }, release: noopRelease };
      const ceiling = resolved.value.admission.maxConcurrentRuns;
      tenantConc = withTenantLimit(tenantConc, tenant.id, ceiling);
      const r = admitTenant(tenantConc, tenant.id, Date.now());
      if (r.ok) {
        tenantConc = r.value.state;
        const token = r.value.token;
        return {
          decision: { kind: "admitted" },
          release: () => { tenantConc = releaseTenant(tenantConc, token); },
        };
      }
      if (r.error.kind === "tenant-over-quota") {
        return {
          decision: { kind: "over-quota", retryAfterSeconds: r.error.retryAfterSeconds },
          release: noopRelease,
        };
      }
      return { decision: { kind: "unavailable" }, release: noopRelease };
    },
  };
};

interface Gate {
  readonly wait: Promise<void>;
  readonly open: () => void;
}
const makeGate = (): Gate => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
};

describe("admission wiring — REAL admitTenant enforces per-tenant ceiling (T9)", () => {
  // Two tenants registered with explicit ceilings via the REAL registry:
  //   acme  → maxConcurrentRuns: 1  (will saturate)
  //   beta  → maxConcurrentRuns: 5  (must stay unaffected — SC-011/SC-012)
  const setup = async () => {
    const fake = createInMemoryRedisFake();
    const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
    const mkId = (s: string): TenantId => {
      const r = tenantId(s);
      if (!r.ok) throw new Error(`bad id ${s}`);
      return r.value;
    };
    const acmeId = mkId("acme");
    const betaId = mkId("beta");
    const register = async (id: TenantId, team: string, maxRuns: number) => {
      const cfg = tenantConfig({
        id,
        team,
        keycloakClientMapping: { realm: "r", clientId: "c", agentClientIdsByDag: {} },
        fsRoot: `/srv/${id}`,
        secretsRef: markSecretsRef(`vault://${id}/env`),
        admission: { maxConcurrentRuns: maxRuns, maxQueuedRuns: 10 },
        eagerPin: false,
      });
      if (!cfg.ok) throw new Error("bad cfg");
      await registry.register(cfg.value, 0);
    };
    await register(acmeId, "acme-team", 1);
    await register(betaId, "beta-team", 5);

    const { hashToken } = await import("../../domain/auth.js");
    const acmeHash = (await hashToken("fug_acme")) as unknown as string;
    const betaHash = (await hashToken("fug_beta")) as unknown as string;

    const registryView: TenantRegistryView = {
      tenantForTeam: (team) =>
        team === "acme-team" ? markTenant(acmeId, "acme-team")
        : team === "beta-team" ? markTenant(betaId, "beta-team")
        : undefined,
    };

    const sockOf = (t: TenantId): string => `/run/fugue/${t}.sock`;

    return { registry, registryView, acmeHash, betaHash, sockOf };
  };

  const mkReq = (token: string) =>
    new Request("http://host/runs/dag1", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });

  it("acme at ceiling=1 → 2nd concurrent run gets 429 + Retry-After; beta unaffected (SC-011/SC-012)", async () => {
    const { registry, registryView, acmeHash, betaHash, sockOf } = await setup();

    // The first acme run BLOCKS in the proxy (gate held), so its slot stays held
    // while the second acme request races in and must be refused 429.
    const gate = makeGate();
    let acmeInFlight = 0;
    const transport: UdsTransport = async (sock) => {
      if (sock === "/run/fugue/acme.sock") {
        acmeInFlight += 1;
        if (acmeInFlight === 1) await gate.wait; // hold the first run's slot
      }
      return ok(new Response(JSON.stringify({ runId: sock }), { status: 200, headers: { "Content-Type": "application/json" } }));
    };

    const deps: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth: {
        adminToken: "admin-secret",
        tokenStore: fakeTokenStore({
          [acmeHash]: { team: "acme-team", label: "acme" },
          [betaHash]: { team: "beta-team", label: "beta" },
        }),
        logger: silentLog,
      } satisfies AuthDeps,
      registryView,
      admission: buildRealAdmission(registry),
      lifecycle: lifecycleLiveByTenant(sockOf),
      transport,
      logger: silentLog,
    };

    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      // Kick off acme run #1 — it acquires acme's only slot and blocks in proxy.
      const run1 = sup.value.handle(mkReq("fug_acme"));
      // Yield so run1 reaches the blocking transport and holds the slot.
      await new Promise((r) => setTimeout(r, 10));

      // acme run #2 while #1 holds the slot → over its ceiling → 429.
      const run2 = await sup.value.handle(mkReq("fug_acme"));
      expect(run2.status).toBe(429);
      expect(run2.headers.get("Retry-After")).toBe("5"); // default per-tenant backoff
      const body = await run2.text();
      expect(body).not.toContain("beta"); // no cross-tenant leakage (FR-040)

      // beta is UNAFFECTED by acme's saturation (anti-starvation, no bleed).
      const betaRun = await sup.value.handle(mkReq("fug_beta"));
      expect(betaRun.status).toBe(200);

      // Release acme run #1 → its slot frees → a NEW acme run is admitted again.
      gate.open();
      expect((await run1).status).toBe(200);
      const run3 = await sup.value.handle(mkReq("fug_acme"));
      expect(run3.status).toBe(200);
    } finally {
      gate.open();
      await sup.value.shutdown();
    }
  });

  it("sequential acme runs (each completes before the next) never hit the ceiling", async () => {
    const { registry, registryView, acmeHash, sockOf } = await setup();
    const transport: UdsTransport = async (sock) =>
      ok(new Response(JSON.stringify({ runId: sock }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const deps: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth: {
        adminToken: "admin-secret",
        tokenStore: fakeTokenStore({ [acmeHash]: { team: "acme-team", label: "acme" } }),
        logger: silentLog,
      } satisfies AuthDeps,
      registryView,
      admission: buildRealAdmission(registry),
      lifecycle: lifecycleLiveByTenant(sockOf),
      transport,
      logger: silentLog,
    };
    const sup = await createSupervisor(deps);
    if (!sup.ok) throw new Error("supervisor boot failed");
    try {
      // Each completes (releasing the slot) before the next admits → all 200,
      // proving release-on-completion actually returns the slot.
      for (let i = 0; i < 5; i += 1) {
        const res = await sup.value.handle(mkReq("fug_acme"));
        expect(res.status).toBe(200);
      }
    } finally {
      await sup.value.shutdown();
    }
  });
});
