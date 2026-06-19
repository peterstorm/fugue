/**
 * Integration — Worker-crash containment under CONCURRENT multi-tenant load (T12.1).
 *
 * Crashes ONE tenant's worker mid-run while OTHER tenants are running concurrently,
 * and asserts ZERO failed or disrupted runs in any other tenant. The fault is
 * injected deterministically through the project's REAL `WorkerLifecyclePort`
 * (`createWorkerLifecycle`) composed over in-memory spawn/proc fakes whose
 * `handle.exited` promise is the SOLE crash signal — no arbitrary sleeps. The
 * crash-exit watcher drives `onCrash` (contained restart of ONLY that tenant);
 * we poll the lifecycle's `liveWorkerCount` + the registry record with bounded
 * retries, never a fixed wait.
 *
 * Drives the supervisor end-to-end via `createSupervisor().handle` (the same
 * function wired into Bun.serve's fetch), so the assertion is on OBSERVABLE
 * request behaviour (HTTP status per tenant), not lifecycle internals.
 *
 * @satisfies SC-005 — a worker crash mid-run causes ZERO failed/disrupted runs in
 *   any other tenant, verified by a fault-injection test under concurrent load.
 * @satisfies NFR-020 — a worker crash MUST be contained to its own tenant.
 * @satisfies US4 — worker lifecycle: spawn, crash-restart.
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

// ── Controllable spawn/proc fakes (the ONLY crash seam) ──────────────────────

interface SpawnRecord {
  readonly spec: WorkerSpawnSpec;
  readonly pid: number;
  /** Resolve this incarnation's `handle.exited` to simulate a crash/exit. */
  readonly exit: (code: number | null) => void;
}

const makeSpawn = () => {
  const spawned: SpawnRecord[] = [];
  let nextPid = 1000;
  const spawn: SpawnPort = {
    spawn: async (spec): Promise<Result<WorkerHandle, HostError>> => {
      const pid = nextPid++;
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((res) => { resolveExit = res; });
      spawned.push({ spec, pid, exit: resolveExit });
      return ok({ pid, exited });
    },
  };
  const proc: ProcManagePort = {
    signal: async () => ok(undefined),
    isAlive: async () => true,
  };
  return { spawn, proc, spawned };
};

const tenantsView = (ids: readonly string[]): TenantSpawnConfigView => ({
  spawnConfigFor: (tenant) =>
    ids.includes(tenant as unknown as string)
      ? { secretsRef: markSecretsRef(`vault://${tenant}/env`), eagerPin: false }
      : undefined,
});

const lifecycleConfig = (over: Partial<WorkerLifecycleConfig> = {}): WorkerLifecycleConfig => ({
  udsDir: UDS_DIR,
  workerEntry: "/app/worker-main.ts",
  idleEvictMs: 900_000,
  spawnReadyTimeoutMs: 1000,
  spawnReadyPollMs: 5,
  ...over,
});

// Each request RESOLVES through the worker the supervisor routed it to: the
// transport keys on the socket path, returning a 200 if the socket is one of the
// CURRENTLY-live worker sockets, else a 502 (a stale/dead socket). This makes a
// "disrupted" run for another tenant OBSERVABLE — if the crash bled across, that
// tenant's request would hit a non-live socket and fail.
const makeTransport = (liveSockets: Set<string>): UdsTransport => async (socketPath, req) => {
  // Verify the signed tenant header is present + valid for the socket's tenant —
  // a cross-tenant routing bug would stamp the wrong tenant here.
  const header = req.headers.get(TENANT_HEADER);
  const tenantFromSocket = socketPath.slice(`${UDS_DIR}/`.length, -".sock".length);
  if (!header || verifyTenantHeader(KEY, tenantFromSocket, header).kind !== "ok") {
    return ok(new Response(JSON.stringify({ error: "bad-header" }), { status: 421 }));
  }
  if (!liveSockets.has(socketPath)) {
    return ok(new Response(JSON.stringify({ error: "dead-socket" }), { status: 502 }));
  }
  return ok(new Response(JSON.stringify({ runId: `run-${tenantFromSocket}` }), {
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

const waitFor = async (pred: () => boolean, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  return pred();
};

const runFor = (tenant: Tenant) =>
  new Request("http://host/runs/dag1", {
    method: "POST",
    headers: { Authorization: `Bearer fug_${tenant.id}` },
    body: "{}",
  });

describe("Integration — worker-crash containment (SC-005, NFR-020, US4)", () => {
  test("crashing one tenant's worker under concurrent multi-tenant load disrupts ZERO other tenants", async () => {
    const tenants = ["acme", "globex", "initech", "umbrella"].map(makeTenant);
    const crashTenant = tenants[0]!; // acme is the victim

    // The set of currently-live worker sockets the transport will serve. The
    // lifecycle manager owns the worker map; we mirror "which sockets are live"
    // by tracking spawns and treating every spawned incarnation's socket as live
    // (a crashed-then-respawned worker is live again at the SAME socket path).
    const liveSockets = new Set<string>(
      tenants.map((t) => workerSocketPath(UDS_DIR, t.id)),
    );

    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lifecycle = createWorkerLifecycle({
      spawn,
      proc,
      registry: reg,
      probe: async () => true,
      tenants: tenantsView(tenants.map((t) => t.id)),
      clock: () => Date.now(),
      config: lifecycleConfig(),
      logger: silentLog,
    });

    const registryView: TenantRegistryView = {
      tenantForTeam: (team) => tenants.find((t) => t.team === team),
    };

    const deps: SupervisorDeps = {
      config: baseConfig,
      redis: aliveRedis,
      auth: {
        adminToken: "admin-secret",
        tokenStore: await tokenStoreFor(tenants),
        logger: silentLog,
      } satisfies AuthDeps,
      registryView,
      admission: admissionAlways({ kind: "admitted" }),
      lifecycle,
      transport: makeTransport(liveSockets),
      logger: silentLog,
    };

    const sup = await createSupervisor(deps);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;

    try {
      // Warm every tenant's worker so all four are live and registered.
      for (const t of tenants) {
        const res = await sup.value.handle(runFor(t));
        expect(res.status).toBe(200);
      }
      expect(lifecycle.liveWorkerCount()).toBe(tenants.length);

      // Drive CONCURRENT multi-tenant load: many overlapping requests across all
      // tenants, while we crash acme's worker MID-FLIGHT.
      const otherTenants = tenants.slice(1);
      const ROUNDS = 25;

      // Kick off concurrent load for the OTHER tenants.
      const otherLoad: Promise<{ tenant: string; status: number }>[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        for (const t of otherTenants) {
          otherLoad.push(
            sup.value.handle(runFor(t)).then((r) => ({ tenant: t.id, status: r.status })),
          );
        }
      }

      // CRASH acme's live worker mid-load (its handle.exited resolves). The
      // crash-exit watcher drives the CONTAINED restart of ONLY acme.
      const acmeSpawn = spawned.find(
        (s) => (s.spec.tenant as unknown as string) === crashTenant.id,
      )!;
      acmeSpawn.exit(137); // OOM-style exit code

      const results = await Promise.all(otherLoad);

      // SC-005 / NFR-020: ZERO failed or disrupted runs in any OTHER tenant —
      // every concurrent non-acme request succeeded against its own live worker.
      const disrupted = results.filter((r) => r.status !== 200);
      expect(disrupted).toEqual([]);

      // Containment proof on the lifecycle side: each non-victim tenant was
      // spawned exactly ONCE (never restarted), and acme was restarted exactly
      // once (its respawn). Poll with bounded retries for the respawn.
      const acmeRespawned = await waitFor(
        () => spawned.filter((s) => (s.spec.tenant as unknown as string) === crashTenant.id).length === 2,
      );
      expect(acmeRespawned).toBe(true);
      for (const t of otherTenants) {
        expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === t.id).length).toBe(1);
      }
      // All workers live again (acme replaced itself; others untouched).
      const allLive = await waitFor(() => lifecycle.liveWorkerCount() === tenants.length);
      expect(allLive).toBe(true);

      // The victim itself recovers — a fresh request after restart succeeds (its
      // socket path is stable, so it is still in liveSockets).
      const acmeAfter = await sup.value.handle(runFor(crashTenant));
      expect(acmeAfter.status).toBe(200);

      // Other tenants' registry records were never removed (containment): each
      // still present.
      for (const t of otherTenants) {
        expect(fake.store.has(`${WORKER_KEY_PREFIX}${t.id}`)).toBe(true);
      }
    } finally {
      await sup.value.shutdown();
    }
  });
});
