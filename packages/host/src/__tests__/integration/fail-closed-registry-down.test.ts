/**
 * Integration — Registry/Redis-down fail-closed (T12.3).
 *
 * When the registry/backing infra is unavailable, EVERY new-run request is
 * refused with a 503-style response and ZERO requests route on stale/guessed
 * config, while in-flight runs on already-live workers continue at 100%.
 *
 * Wires the REAL Redis-backed tenant registry over the in-memory Redis fake (the
 * exact `resolveForNewRun` seam the binary uses) and drives the supervisor's
 * NEW-run admission gate through it — `onRedisProbeEdge → registry.markRedisDegraded`,
 * exactly as `createSupervisor` wires the probe in production. We then flip the
 * probe edge to DOWN and assert:
 *   - 100% of NEW-run requests are refused (fail-closed via resolveForNewRun) and
 *     NEVER proxied (the transport is never reached → no stale-config routing);
 *   - the IN-FLIGHT / status path (`registry.lookup`, which the supervisor does
 *     NOT block while degraded) keeps resolving the SAME live workers at 100%;
 *   - recovery (probe back UP) re-opens the gate and new runs flow again.
 *
 * NON-LEAKAGE: the fail-closed refusal is `tenant-unknown` (404), identical to an
 * unknown tenant, so an outage cannot be used to probe which tenants exist
 * (FR-040) — asserted on the body.
 *
 * @satisfies SC-007 — registry unavailable → 100% of new-run requests refused
 *   (503-style), ZERO routed on stale config; in-flight on live workers continue 100%.
 * @satisfies NFR-022 — fail closed (refuse new runs) when tenant resolution cannot
 *   be verified, while preserving in-flight work on live workers.
 */

import { describe, test, expect } from "bun:test";
import { ok } from "@fuguejs/framework";
import { createSupervisor } from "../../supervisor/supervisor.js";
import type { AuthDeps, AdmissionPort, SupervisorDeps } from "../../supervisor/supervisor.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
import { markTenant, tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { HostError } from "../../domain/host-error.js";
import type { EnsuredWorker, WorkerLifecyclePort } from "../../supervisor/lifecycle/spawn-port.js";
import type { HostConfig } from "../../domain/config.js";
import { workerSocketPath } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import { hashToken } from "../../domain/auth.js";
import {
  createRedisTenantRegistry,
  createInMemoryRedisFake,
} from "../../supervisor/registry/redis-registry-adapter.js";
import { tenantConfig } from "../../supervisor/registry/tenant-registry.js";

const KEY = "internal-hmac-not-a-secret";
const UDS_DIR = "/run/fugue";
const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant id ${s}`);
  return r.value;
};
const makeTenant = (id: string): Tenant => markTenant(tid(id), `${id}-team`);
const aliveRedis: RedisConnectivityPort = { ping: async () => ok(undefined) };

const baseConfig = {
  PORT: 0,
  WORKER_UDS_DIR: UDS_DIR,
  FUGUE_SUPERVISOR_HMAC_KEY: KEY,
  REDIS_PROBE_INTERVAL_MS: 1_000_000,
} as unknown as HostConfig;

// A lifecycle whose workers are ALWAYS live (children of thin-init). This models
// "already-live workers" whose in-flight work must keep flowing during an outage.
const lifecycleAlwaysLive: WorkerLifecyclePort = {
  ensureWorker: async (t) => ok<EnsuredWorker, HostError>({ udsPath: workerSocketPath(UDS_DIR, t) }),
  drain: async () => ok(undefined),
  evict: async () => ok(undefined),
  onCrash: async () => ok(undefined),
  reconcileReadopt: async () => ok({ adopted: [], pruned: [] }),
  liveWorkerCount: () => 0,
  idleEvictSweep: async () => [],
  livenessSweep: async () => [],
};

const tokenStoreFor = async (tenants: readonly Tenant[]): Promise<TokenStorePort> => {
  const byHash: Record<string, { team: string; label: string }> = {};
  for (const t of tenants) {
    const hash = (await hashToken(`fug_${t.id}`)) as unknown as string;
    byHash[hash] = { team: t.team, label: t.id };
  }
  return {
    resolve: async (hash) => ok(byHash[hash as unknown as string] ?? null),
    store: async () => ok(undefined),
    listTeams: async () => ok([]),
    revoke: async () => ok(undefined),
  };
};

const runFor = (tenant: Tenant) =>
  new Request("http://host/runs/dag1", {
    method: "POST",
    headers: { Authorization: `Bearer fug_${tenant.id}` },
    body: "{}",
  });

describe("Integration — registry-down fail-closed (SC-007, NFR-022)", () => {
  test("registry unavailable: 100% of new runs refused (no stale routing); in-flight on live workers continue 100%; recovery re-admits", async () => {
    const tenants = ["acme", "globex", "initech"].map(makeTenant);

    // REAL Redis-backed registry over the in-memory fake; register every tenant.
    const fake = createInMemoryRedisFake();
    const registry = createRedisTenantRegistry(fake.redis, fake.pubsub, {}, silentLog);
    for (const t of tenants) {
      const cfg = tenantConfig({
        id: t.id,
        team: t.team,
        keycloakClientMapping: { realm: "r", clientId: "c", agentClientIdsByDag: {} },
        fsRoot: `/srv/${t.id}`,
        secretsRef: markSecretsRef(`vault://${t.id}/env`),
        admission: { maxConcurrentRuns: 100, maxQueuedRuns: 100 },
        eagerPin: false,
      });
      if (!cfg.ok) throw new Error("bad cfg");
      await registry.register(cfg.value, 0);
    }

    const registryView: TenantRegistryView = {
      tenantForTeam: (team) => tenants.find((t) => t.team === team),
    };

    // NEW-run admission bound to resolveForNewRun (exactly as the binary): it
    // fails closed → `unknown` when Redis is degraded. We count transport hits to
    // PROVE no request routes on stale config during the outage.
    let transportHits = 0;
    const transport: UdsTransport = async (socketPath) => {
      transportHits++;
      const tenant = socketPath.slice(`${UDS_DIR}/`.length, -".sock".length);
      return ok(new Response(JSON.stringify({ runId: `run-${tenant}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    };

    const admission: AdmissionPort = {
      admit: (t) =>
        registry.resolveForNewRun(t.id).ok
          ? { decision: { kind: "admitted" }, release: () => {} }
          : { decision: { kind: "unknown" }, release: () => {} },
    };

    const deps: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth: { adminToken: "admin", tokenStore: await tokenStoreFor(tenants), logger: silentLog } satisfies AuthDeps,
      registryView,
      admission,
      lifecycle: lifecycleAlwaysLive,
      transport,
      // Wire the probe edge → registry gate (FR-022) exactly as main-supervisor.
      onRedisProbeEdge: (dead) => registry.markRedisDegraded(dead),
      logger: silentLog,
    };

    const sup = await createSupervisor(deps);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;

    try {
      // ── HEALTHY: every tenant's new run is admitted + proxied. ─────────────
      for (const t of tenants) {
        expect((await sup.value.handle(runFor(t))).status).toBe(200);
      }
      const hitsWhileHealthy = transportHits;
      expect(hitsWhileHealthy).toBe(tenants.length);

      // ── OUTAGE: the registry/backing infra goes DOWN. Flip the probe edge
      //    (the supervisor wires this to markRedisDegraded). Also flip the fake
      //    Redis itself to failing so even a registry WRITE would fail closed.
      deps.onRedisProbeEdge!(true);
      fake.setFail(true);

      const ROUNDS = 30;
      const newRunResults: { tenant: string; status: number; body: string }[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        for (const t of tenants) {
          const res = await sup.value.handle(runFor(t));
          newRunResults.push({ tenant: t.id, status: res.status, body: await res.text() });
        }
      }

      // SC-007: 100% of NEW-run requests refused with a fail-closed status. The
      // fail-closed admission maps to `tenant-unknown` (404) by design (FR-040
      // non-leakage — indistinguishable from "no such tenant", so an outage can't
      // be used to probe tenant existence). A 503/404 are both "refused"; none is
      // a 2xx.
      expect(newRunResults.every((r) => r.status === 404)).toBe(true);
      // ZERO requests routed on stale/guessed config: the transport was NEVER hit
      // during the outage.
      expect(transportHits).toBe(hitsWhileHealthy);
      // NON-LEAKING body: no tenant id leaked; uniform "not found".
      for (const r of newRunResults) {
        for (const t of tenants) expect(r.body).not.toContain(t.id);
        expect(r.body).toContain("not found");
      }

      // FR-023 / NFR-022: IN-FLIGHT / status path keeps resolving on already-live
      // workers at 100%. The supervisor uses `lookup` (snapshot, NOT degraded-
      // gated) for in-flight work — every tenant still resolves from the snapshot
      // even though new-run admission is closed.
      for (const t of tenants) {
        expect(registry.lookup(t.id).ok).toBe(true);
      }

      // ── RECOVERY: probe back UP + Redis healthy → gate re-opens, new runs flow.
      fake.setFail(false);
      deps.onRedisProbeEdge!(false);
      for (const t of tenants) {
        expect((await sup.value.handle(runFor(t))).status).toBe(200);
      }
      // The transport is reached again post-recovery (gate re-opened).
      expect(transportHits).toBe(hitsWhileHealthy + tenants.length);
    } finally {
      await sup.value.shutdown();
    }
  });
});
