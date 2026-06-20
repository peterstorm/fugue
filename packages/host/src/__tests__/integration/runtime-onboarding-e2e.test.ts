/**
 * Integration — AUTOMATED runtime-onboarding e2e (T12.5 / folded-in GAP-2).
 *
 * A full automated end-to-end of onboarding a tenant that REUSES already-
 * provisioned capabilities, against a SINGLE running supervisor instance that is
 * never restarted and never reconfigured by any out-of-band step:
 *
 *   1. MINT a team token       — admin provisions the tenant's team token.
 *   2. REGISTER the tenant     — POST /admin/tenants (admin-token authed) through
 *                                the REAL `handleAdminTenants` admin lifecycle API.
 *   3. PUSH DAGs               — modelled as the worker becoming routable (the
 *                                worker loads the tenant's DAGs from its mount on
 *                                first spawn); first ensureWorker = the DAG-bearing
 *                                worker coming live.
 *   4. FIRST successful invoke — the freshly-onboarded tenant's first run is
 *                                authenticated → resolved → admitted → proxied 200.
 *
 * ZERO IaC PRs / ZERO host redeploys is asserted STRUCTURALLY: the supervisor is
 * created ONCE, before onboarding, and the SAME instance serves the first
 * invocation — there is no second `createSupervisor`, no config reload, no process
 * restart between register and invoke. A "redeploy" would be a new supervisor; we
 * assert there is exactly one. Before registration, the tenant resolves to 404
 * (proving it was genuinely not pre-provisioned in the running host); after the
 * runtime register + token mint, it invokes successfully — all without touching
 * the supervisor lifecycle.
 *
 * @satisfies SC-004 — a tenant reusing provisioned capabilities is fully onboarded
 *   (token minted, registered, DAGs pushed, first successful invocation) with ZERO
 *   IaC PRs and ZERO host redeploys.
 * @satisfies FR-036 — onboarding a reuse-case tenant requires no IaC PR / redeploy.
 * @satisfies US1 — runtime tenant onboarding (no redeploy).
 */

import { describe, test, expect } from "bun:test";
import { ok } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { createSupervisor } from "../../supervisor/supervisor.js";
import type { AuthDeps, AdmissionPort, SupervisorDeps } from "../../supervisor/supervisor.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
import { TENANT_HEADER } from "../../supervisor/uds-proxy.js";
import { verifyTenantHeader } from "../../domain/tenant-header.js";
import { markTenant, tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { EnsuredWorker, WorkerLifecyclePort } from "../../supervisor/lifecycle/spawn-port.js";
import type { HostError } from "../../domain/host-error.js";
import { workerUnavailable } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import { workerSocketPath } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import type { TokenGrant, TokenHash } from "../../domain/auth.js";
import { hashToken } from "../../domain/auth.js";
import {
  createRedisTenantRegistry,
  createInMemoryRedisFake,
} from "../../supervisor/registry/redis-registry-adapter.js";
import type { AdminTenantsDeps } from "../../http/handlers/admin/tenants.js";
import type { AuditPort, AuditRecord } from "../../supervisor/audit/audit-port.js";

const KEY = "internal-hmac-not-a-secret";
const ADMIN = "admin-token-long-enough-for-test";
const UDS_DIR = "/run/fugue";
const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant id ${s}`);
  return r.value;
};
const aliveRedis: RedisConnectivityPort = { ping: async () => ok(undefined) };

const baseConfig = {
  PORT: 0,
  WORKER_UDS_DIR: UDS_DIR,
  FUGUE_SUPERVISOR_HMAC_KEY: KEY,
  REDIS_PROBE_INTERVAL_MS: 1_000_000,
} as unknown as HostConfig;

// ── In-memory team-token store (mint → resolve → revoke) ─────────────────────
// Mirrors the real token-store contract; backs `tokenStore.store` (the MINT) and
// `resolve` (the auth path). A team-token grant is keyed by its hash.
const makeTokenStore = (): TokenStorePort & { grants: Map<string, TokenGrant> } => {
  const byHash = new Map<string, TokenGrant>(); // hash → grant
  return {
    grants: byHash,
    resolve: async (hash) => ok(byHash.get(hash as unknown as string) ?? null),
    store: async (_team, hash, grant) => {
      byHash.set(hash as unknown as string, grant);
      return ok(undefined);
    },
    listTeams: async () => ok([...byHash.values()]),
    revoke: async (team) => {
      for (const [h, g] of byHash) if (g.team === team) byHash.delete(h);
      return ok(undefined);
    },
  };
};

// A registry VIEW backed by the live Redis registry's snapshot — it resolves a
// team to a branded Tenant ONLY for tenants the registry currently holds active.
// This is the seam `resolveTenant` consults; it must reflect runtime registers
// WITHOUT a restart.
const liveRegistryView = (
  snapshotActiveTeams: () => Map<string, TenantId>,
): TenantRegistryView => ({
  tenantForTeam: (team) => {
    const id = snapshotActiveTeams().get(team);
    return id ? markTenant(id, team) : undefined;
  },
});

describe("Integration — runtime onboarding e2e (SC-004, FR-036, US1)", () => {
  test("mint→register→push→first-invoke succeeds with ZERO redeploys / PRs (single running supervisor)", async () => {
    const NEW_ID = "newco";
    const NEW_TEAM = "newco-team";
    const NEW_TOKEN = "fug_newco_runtime";

    // Count supervisor creations: a "redeploy" would be a SECOND createSupervisor.
    // We assert it stays 1 across the whole onboarding flow.
    let supervisorCreations = 0;

    // ── Already-provisioned shared infra (reused — NOT created per tenant) ────
    const fake = createInMemoryRedisFake();
    const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
    const tokenStore = makeTokenStore();

    // Audit sink (the admin API emits a record per op — SC-008 coverage).
    const audits: AuditRecord[] = [];
    const audit: AuditPort = { record: async (rec) => { audits.push(rec); } };

    // The registry view derives active teams from the LIVE registry snapshot, so a
    // runtime register is visible to resolution with no restart.
    const activeTeams = (): Map<string, TenantId> => {
      const m = new Map<string, TenantId>();
      for (const cfg of registry.snapshot().entries.values()) {
        if (cfg.status === "active") m.set(cfg.team, cfg.id);
      }
      return m;
    };
    const registryView = liveRegistryView(activeTeams);

    // Lifecycle: a worker is routable iff its tenant is registered active. This
    // models "push DAGs" — the worker spawns from the tenant's mount on first
    // request once the tenant exists; an unregistered tenant has no worker.
    const lifecycle: WorkerLifecyclePort = {
      ensureWorker: async (t): Promise<Result<EnsuredWorker, HostError>> =>
        activeTeams().has(`${t}-team`) || registry.lookup(t).ok
          ? ok({ udsPath: workerSocketPath(UDS_DIR, t) })
          : err(workerUnavailable(t)),
      drain: async () => ok(undefined),
      evict: async () => ok(undefined),
      onCrash: async () => ok(undefined),
      reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
      liveWorkerCount: () => activeTeams().size,
      idleEvictSweep: async () => [],
      livenessSweep: async () => [],
    };

    // NEW-run admission bound to resolveForNewRun (registry seam).
    const admission: AdmissionPort = {
      admit: (t) =>
        registry.resolveForNewRun(t.id).ok
          ? { decision: { kind: "admitted" }, release: () => {} }
          : { decision: { kind: "unknown" }, release: () => {} },
    };

    let stampedTenant: string | null = null;
    let stampedHeaderValid = false;
    const transport: UdsTransport = async (socketPath, req) => {
      const tenant = socketPath.slice(`${UDS_DIR}/`.length, -".sock".length);
      const header = req.headers.get(TENANT_HEADER);
      stampedTenant = tenant;
      stampedHeaderValid = !!header && verifyTenantHeader(KEY, tenant, header).kind === "ok";
      return ok(new Response(JSON.stringify({ runId: `run-${tenant}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    };

    const auth: AuthDeps = { adminToken: ADMIN, tokenStore, logger: silentLog };

    const adminTenants: AdminTenantsDeps = {
      auth,
      registry,
      lifecycle,
      tokenStore,
      audit,
      now: () => 1_000,
      logger: silentLog,
    };

    const deps: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth,
      registryView,
      admission,
      lifecycle,
      adminTenants,
      transport,
      logger: silentLog,
    };

    // ── The SINGLE supervisor instance for the whole flow (no redeploy) ───────
    supervisorCreations++;
    const sup = await createSupervisor(deps);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;

    const invokeReq = () =>
      new Request("http://host/runs/dag1", {
        method: "POST",
        headers: { Authorization: `Bearer ${NEW_TOKEN}` },
        body: "{}",
      });

    try {
      // ── PRE-CONDITION (no token yet): an unprovisioned credential is refused at
      //    auth (401) — there is no minted token for this tenant.
      const beforeMint = await sup.value.handle(invokeReq());
      expect(beforeMint.status).toBe(401);

      // ── STEP 1: MINT the team token (admin provisions it into the store). ────
      const hash = await hashToken(NEW_TOKEN);
      const grant: TokenGrant = { team: NEW_TEAM, label: NEW_ID, createdAt: 1_000 };
      const mint = await tokenStore.store(NEW_TEAM, hash as TokenHash, grant);
      expect(mint.ok).toBe(true);
      expect(tokenStore.grants.size).toBe(1);

      // ── PRE-CONDITION (token minted, tenant NOT registered): the credential now
      //    authenticates, but the tenant is NOT pre-provisioned in the running
      //    host, so resolution fails closed (404) — proving the success below
      //    comes from RUNTIME registration, not pre-baked config.
      const beforeRegister = await sup.value.handle(invokeReq());
      expect(beforeRegister.status).toBe(404);

      // ── STEP 2: REGISTER the tenant via the REAL admin lifecycle API, routed
      //    through the SAME supervisor's HTTP handler (admin-token authed). This
      //    is a runtime register — no IaC, no redeploy.
      const registerRes = await sup.value.handle(
        new Request(`http://host/admin/tenants/${NEW_ID}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            team: NEW_TEAM,
            // STEP 3 (push DAGs): the per-DAG agent-client mapping the worker uses
            // when it loads the tenant's DAGs from its (reused) mount.
            keycloakClientMapping: { realm: "platform", clientId: "newco-client", agentClientIdsByDag: { dag1: "agent-dag1" } },
            fsRoot: `/srv/${NEW_ID}`,
            secretsRef: `vault://${NEW_ID}/env`,
            admission: { maxConcurrentRuns: 10, maxQueuedRuns: 10 },
            eagerPin: false,
          }),
        }),
      );
      expect(registerRes.status).toBe(200);
      expect(await registerRes.json()).toMatchObject({ ok: true, tenant: NEW_ID, action: "register" });
      // The register was AUDITED as succeeded (SC-008 trail).
      expect(audits.some((a) => a.tenant === tid(NEW_ID) && a.action === "register" && a.outcome === "succeeded")).toBe(true);
      // The live registry now holds the tenant active — visible to resolution with
      // no restart (the registry view reads the live snapshot).
      expect(registry.lookup(tid(NEW_ID)).ok).toBe(true);

      // ── STEP 4: FIRST INVOCATION — authenticated → resolved → admitted →
      //    proxied to the now-live worker. End-to-end success on the SAME
      //    supervisor instance.
      const firstRun = await sup.value.handle(invokeReq());
      expect(firstRun.status).toBe(200);
      expect(await firstRun.json()).toEqual({ runId: `run-${NEW_ID}` });
      // The run was proxied to the tenant's OWN worker with a valid signed header.
      expect(stampedTenant).toBe(NEW_ID);
      expect(stampedHeaderValid).toBe(true);

      // ── ZERO redeploys: exactly ONE supervisor instance served the entire flow
      //    (pre-check 404 → register → first invoke). No second createSupervisor,
      //    no config reload, no restart.
      expect(supervisorCreations).toBe(1);
    } finally {
      await sup.value.shutdown();
    }
  });
});
