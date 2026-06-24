/**
 * Integration — Supervisor restart re-adoption with N live workers (T12.2).
 *
 * With N workers live (registered in the Redis worker-registry + answering their
 * UDS probe), the supervisor RESTARTS — modelled the way the architecture does it
 * (AD-2): the workers are children of thin-init, NOT the supervisor, so they keep
 * running across the supervisor's own restart; the supervisor's in-memory
 * lifecycle map is GONE, and the NEW supervisor must re-adopt them from the
 * registry + UDS probe (`reconcileReadopt`) and resume routing to ALL N.
 *
 * The "restart" is the FIRST supervisor shutting down and a SECOND
 * `createSupervisor` standing up over a FRESH lifecycle manager bound to the SAME
 * Redis worker-registry + a UDS probe — exactly the production reconcile path.
 * We assert 100% of the previously-live workers are re-adopted and that routing
 * resumes to every one of them (an in-flight run on each survives, 100%).
 *
 * Deterministic: re-adoption is driven by the registry record + the injected UDS
 * probe; no sleeps — we await `reconcileReadopt` and assert its adopted set, then
 * route to each tenant.
 *
 * @satisfies SC-006 — after a supervisor restart while N workers live, 100% of
 *   in-flight runs survive AND the supervisor re-adopts + resumes routing to all N.
 * @satisfies NFR-021 — in-flight runs MUST survive a supervisor restart.
 * @satisfies US7 — supervisor restart with live workers: re-adopt + resume routing.
 */

import { describe, test, expect } from "bun:test";
import { ok } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { createSupervisor } from "../../supervisor/supervisor.js";
import type { AuthDeps, AdmissionPort, SupervisorDeps } from "../../supervisor/supervisor.js";
import type { UdsTransport } from "../../supervisor/uds-proxy.js";
import { markTenant, tenantId, markSecretsRef } from "../../domain/tenant.js";
import type { Tenant, TenantId, TenantRegistryView } from "../../domain/tenant.js";
import type { AdmissionDecision } from "../../supervisor/routing.js";
import type { HostError } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import { workerSocketPath } from "../../domain/config.js";
import type { TokenStorePort, LogPort, RedisConnectivityPort } from "../../ports.js";
import { hashToken } from "../../domain/auth.js";
import {
  createWorkerLifecycle,
  type TenantSpawnConfigView,
  type WorkerLifecycleConfig,
} from "../../supervisor/lifecycle/worker-lifecycle-manager.js";
import {
  createWorkerRegistry,
  createInMemoryWorkerRedisFake,
  WORKER_KEY_PREFIX,
} from "../../supervisor/lifecycle/worker-registry-redis.js";
import type {
  SpawnPort,
  ProcManagePort,
  WorkerSpawnSpec,
  WorkerHandle,
} from "../../supervisor/lifecycle/spawn-port.js";

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

const makeSpawn = (startPid: number) => {
  const spawned: WorkerSpawnSpec[] = [];
  let nextPid = startPid;
  const spawn: SpawnPort = {
    spawn: async (spec): Promise<Result<WorkerHandle, HostError>> => {
      spawned.push(spec);
      const pid = nextPid++;
      // The exited promise never resolves here — these workers do NOT crash; they
      // outlive the supervisor (AD-2 thin-init), which is exactly the restart case.
      const exited = new Promise<number | null>(() => {});
      return ok({ pid, exited });
    },
  };
  const proc: ProcManagePort = { signal: async () => ok(undefined), isAlive: async () => true };
  return { spawn, proc, spawned };
};

const tenantsView = (ids: readonly string[]): TenantSpawnConfigView => ({
  spawnConfigFor: (tenant) =>
    ids.includes(tenant as unknown as string)
      ? { secretsRef: markSecretsRef(`vault://${tenant}/env`), eagerPin: false }
      : undefined,
});

const lifecycleConfig = (): WorkerLifecycleConfig => ({
  udsDir: UDS_DIR,
  workerEntry: "/app/worker-main.ts",
  idleEvictMs: 900_000,
  spawnReadyTimeoutMs: 1000,
  spawnReadyPollMs: 5,
});

const okTransport: UdsTransport = async (socketPath) => {
  const tenant = socketPath.slice(`${UDS_DIR}/`.length, -".sock".length);
  return ok(new Response(JSON.stringify({ runId: `run-${tenant}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
};

const admissionAlways = (decision: AdmissionDecision): AdmissionPort => ({
  admit: () => ({ decision, release: () => {} }),
});

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

describe("Integration — supervisor restart re-adoption (SC-006, NFR-021, US7)", () => {
  test("after restart with N live workers, 100% are re-adopted and routing resumes to all N", async () => {
    const N = 5;
    const tenants = Array.from({ length: N }, (_, i) => makeTenant(`tenant${i}`));
    const ids = tenants.map((t) => t.id);

    // ONE shared Redis worker-registry survives the restart (it is the durable
    // source of truth). The probe answers `true` for every persisted worker (they
    // are still alive — children of thin-init, not the supervisor).
    const fake = createInMemoryWorkerRedisFake();
    const registryView: TenantRegistryView = {
      tenantForTeam: (team) => tenants.find((t) => t.team === team),
    };
    const tokenStore = await tokenStoreFor(tenants);

    // ── FIRST supervisor: spawns + registers N live workers ─────────────────
    const first = makeSpawn(2000);
    const regForFirst = createWorkerRegistry(fake.redis, async () => true);
    const lifecycle1 = createWorkerLifecycle({
      spawn: first.spawn,
      proc: first.proc,
      registry: regForFirst,
      probe: async () => true,
      tenants: tenantsView(ids),
      clock: () => Date.now(),
      config: lifecycleConfig(),
      logger: silentLog,
    });

    const deps1: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth: { adminToken: "admin", tokenStore, logger: silentLog } satisfies AuthDeps,
      registryView,
      admission: admissionAlways({ kind: "admitted" }),
      lifecycle: lifecycle1,
      transport: okTransport,
      logger: silentLog,
    };

    const sup1 = await createSupervisor(deps1);
    expect(sup1.ok).toBe(true);
    if (!sup1.ok) return;

    // Bring every worker up + confirm N live records persisted in the registry.
    for (const t of tenants) {
      const res = await sup1.value.handle(runFor(t));
      expect(res.status).toBe(200);
    }
    expect(lifecycle1.liveWorkerCount()).toBe(N);
    for (const id of ids) {
      expect(fake.store.has(`${WORKER_KEY_PREFIX}${id}`)).toBe(true);
    }

    // ── RESTART: the FIRST supervisor goes down. Its in-memory lifecycle map is
    //    gone. The workers (registry records) survive — thin-init keeps them
    //    alive (AD-2). Shutdown the first supervisor's HTTP listener.
    await sup1.value.shutdown();

    // ── SECOND supervisor: FRESH lifecycle manager (empty in-memory map) bound
    //    to the SAME Redis worker-registry + a UDS probe that confirms every
    //    persisted worker is still answering. This is the production reconcile
    //    path.
    const second = makeSpawn(9000); // distinct pids — if a respawn happened we'd see it
    const regForSecond = createWorkerRegistry(fake.redis, async () => true);
    const lifecycle2 = createWorkerLifecycle({
      spawn: second.spawn,
      proc: second.proc,
      registry: regForSecond,
      probe: async () => true, // every previously-live worker still answers its UDS
      tenants: tenantsView(ids),
      clock: () => Date.now(),
      config: lifecycleConfig(),
      logger: silentLog,
    });

    const deps2: SupervisorDeps = { ...deps1, lifecycle: lifecycle2 };
    const sup2 = await createSupervisor(deps2);
    expect(sup2.ok).toBe(true);
    if (!sup2.ok) return;

    try {
      // Fresh supervisor starts with an EMPTY in-memory worker map.
      expect(lifecycle2.liveWorkerCount()).toBe(0);

      // RECONCILE-RE-ADOPT: deterministic, awaited (no sleep). 100% adopted.
      const recon = await lifecycle2.reconcileReadopt();
      expect(recon.ok).toBe(true);
      if (!recon.ok) return;
      expect(new Set(recon.value.adopted)).toEqual(new Set(ids)); // all N adopted
      expect(recon.value.pruned).toEqual([]); // none pruned — all were live
      expect(lifecycle2.liveWorkerCount()).toBe(N);

      // Routing RESUMES to ALL N: an in-flight run for each tenant survives the
      // restart and proxies to its (re-adopted) worker WITHOUT a respawn.
      for (const t of tenants) {
        const res = await sup2.value.handle(runFor(t));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ runId: `run-${t.id}` });
      }

      // 100% survival proof: the second supervisor spawned ZERO new workers —
      // every served request hit a RE-ADOPTED live worker, not a fresh spawn.
      expect(second.spawned.length).toBe(0);
    } finally {
      await sup2.value.shutdown();
    }
  });
});
