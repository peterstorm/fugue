/**
 * Tests for createWorkerLifecycle (worker-lifecycle-manager.ts) — the
 * orchestrator that composes the pure ADT + spawn/proc ports + Redis registry +
 * UDS probe + tenant registry into a WorkerLifecyclePort (FR-014/015/019/020,
 * SC-006, AD-7/AD-8).
 *
 * Drives everything with in-memory fakes + an injected clock (NO Date.now, NO
 * real process). Covers: lazy spawn → live + touch reuse, FR-004 socket derived
 * from TenantId, spawn-failure containment, probe-timeout fail-closed,
 * SUPERVISOR_MAX_LIVE_WORKERS admission, onCrash restart contained to one tenant,
 * reconcileReadopt sourcing eagerPin from the tenant registry (C3), and an
 * eager-pinned re-adopted worker NOT being idle-evictable (AD-7).
 */

import { describe, test, expect, mock } from "bun:test";
import * as lifecycleAdt from "../../../supervisor/lifecycle/worker-lifecycle.js";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { tenantId, markSecretsRef } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import type { HostError } from "../../../domain/host-error.js";
import type { LogPort } from "../../../ports.js";
import { workerSocketPath } from "../../../domain/config.js";
import {
  createWorkerLifecycle,
  type TenantSpawnConfigView,
  type WorkerLifecycleConfig,
} from "../../../supervisor/lifecycle/worker-lifecycle-manager.js";
import {
  createWorkerRegistry,
  createInMemoryWorkerRedisFake,
  WORKER_KEY_PREFIX,
  type WorkerRecord,
  type UdsLivenessProbe,
} from "../../../supervisor/lifecycle/worker-registry-redis.js";
import type { SpawnPort, ProcManagePort, WorkerSpawnSpec, WorkerHandle } from "../../../supervisor/lifecycle/spawn-port.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

const silentLog: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

interface LogLine {
  readonly msg: string;
  readonly ctx: Record<string, unknown> | undefined;
}

/** A LogPort that records every line so tests can assert on warn/error output. */
const recordingLog = (): LogPort & { warns: LogLine[]; errors: LogLine[] } => {
  const warns: LogLine[] = [];
  const errors: LogLine[] = [];
  return {
    warns,
    errors,
    info: () => {},
    warn: (msg, ctx) => { warns.push({ msg, ctx }); },
    error: (msg, ctx) => { errors.push({ msg, ctx }); },
  };
};

const signalErr: HostError = { kind: "internal-invariant-violated", message: "EPERM: kill denied", context: {} };

// ── Fakes ────────────────────────────────────────────────────────────────────

interface SpawnRecord {
  readonly spec: WorkerSpawnSpec;
  /** Resolve this incarnation's `handle.exited` (simulate the worker exiting). */
  readonly exit: (code: number | null) => void;
  readonly pid: number;
}

const makeSpawn = (opts: { fail?: boolean; pid?: number; signalFails?: boolean } = {}) => {
  const spawned: SpawnRecord[] = [];
  let nextPid = opts.pid ?? 100;
  const signalled: Array<{ pid: number; sig: string }> = [];
  const spawn: SpawnPort = {
    spawn: async (spec): Promise<Result<WorkerHandle, HostError>> => {
      if (opts.fail) {
        spawned.push({ spec, exit: () => {}, pid: -1 });
        return { ok: false, error: { kind: "internal-invariant-violated", message: "spawn failed", context: {} } };
      }
      const pid = nextPid++;
      // A controllable `exited` promise: tests resolve it to simulate a crash/exit.
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((res) => { resolveExit = res; });
      spawned.push({ spec, exit: resolveExit, pid });
      return ok({ pid, exited });
    },
  };
  const proc: ProcManagePort = {
    signal: async (pid, sig) => {
      signalled.push({ pid, sig });
      // The Bun adapter returns ok for ESRCH (already-dead); a !ok models a GENUINE
      // kill failure (EPERM / invalid signal / unexpected throw).
      return opts.signalFails ? { ok: false as const, error: signalErr } : ok(undefined);
    },
    isAlive: async () => true,
  };
  return { spawn, proc, spawned, signalled };
};

/** Let pending `.then()` callbacks on a resolved promise flush (microtask drain). */
const flushMicrotasks = async (): Promise<void> => {
  // Two awaits: one to let the exited-promise `.then` run, one to let onCrash's
  // own awaited I/O settle.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
};

const tenantsView = (entries: Record<string, { eagerPin: boolean }>): TenantSpawnConfigView => ({
  spawnConfigFor: (tenant) => {
    const e = entries[tenant as unknown as string];
    if (!e) return undefined;
    return { secretsRef: markSecretsRef(`vault://${tenant}/env`), eagerPin: e.eagerPin };
  },
});

const baseConfig = (over: Partial<WorkerLifecycleConfig> = {}): WorkerLifecycleConfig => ({
  udsDir: "/run/fugue",
  workerEntry: "/app/worker-main.ts",
  idleEvictMs: 900_000,
  spawnReadyTimeoutMs: 1000,
  spawnReadyPollMs: 10,
  maxRestartsPerWindow: 5,
  restartWindowMs: 60_000,
  ...over,
});

const fixedClock = (start = 0) => {
  let t = start;
  const clock = () => t;
  return { clock, advance: (ms: number) => { t += ms; } };
};

// ── ensureWorker: lazy spawn + reuse ───────────────────────────────────────────

describe("createWorkerLifecycle: ensureWorker (FR-014, AD-7, FR-004)", () => {
  test("lazy-spawns to live and returns the tenant's OWN socket (FR-004)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });

    const r = await lc.ensureWorker(tid("acme"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.udsPath).toBe(workerSocketPath("/run/fugue", "acme"));
    expect(spawned.length).toBe(1);
    // The spawn spec carries the tenant's secrets REFERENCE (FR-005) + derived socket.
    expect(spawned[0]!.spec.secretsRef as unknown as string).toBe("vault://acme/env");
    expect(spawned[0]!.spec.udsPath).toBe("/run/fugue/acme.sock");
    // Persisted as live in the registry (SC-006 readopt source).
    expect(fake.store.has(`${WORKER_KEY_PREFIX}acme`)).toBe(true);
    expect(lc.liveWorkerCount()).toBe(1);
  });

  test("reuses an existing live worker (no second spawn) and touches it", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    await lc.ensureWorker(tid("acme"));
    expect(spawned.length).toBe(1); // reused, not respawned
  });

  test("spawn failure is contained → worker-unavailable for THIS tenant", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn({ fail: true });
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    const r = await lc.ensureWorker(tid("acme"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("worker-unavailable");
    expect(lc.liveWorkerCount()).toBe(0); // no stale entry left
  });

  test("UDS never becomes ready → kill + worker-unavailable (fail-closed)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => false);
    const { spawn, proc, signalled } = makeSpawn();
    const clk = fixedClock();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => false,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: clk.clock, config: baseConfig({ spawnReadyTimeoutMs: 0 }), logger: silentLog,
    });
    const r = await lc.ensureWorker(tid("acme"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("worker-unavailable");
    // The spawned-but-unready process was SIGKILLed.
    expect(signalled.some((s) => s.sig === "SIGKILL")).toBe(true);
  });

  test("unknown tenant (no spawn config) → worker-unavailable, never spawned", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({}), // no config for anyone
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    const r = await lc.ensureWorker(tid("ghost"));
    expect(r.ok).toBe(false);
    expect(spawned.length).toBe(0);
  });

  test("SUPERVISOR_MAX_LIVE_WORKERS refuses a new worker at the cap", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ a: { eagerPin: false }, b: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig({ maxLiveWorkers: 1 }), logger: silentLog,
    });
    expect((await lc.ensureWorker(tid("a"))).ok).toBe(true);
    const second = await lc.ensureWorker(tid("b"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("worker-unavailable");
  });
});

// ── onCrash: contained restart (FR-015, AD-8) ──────────────────────────────────

describe("createWorkerLifecycle: onCrash (FR-015, AD-8 containment)", () => {
  test("crashing one tenant restarts ONLY that tenant; another stays live", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false }, globex: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    await lc.ensureWorker(tid("globex"));
    expect(spawned.length).toBe(2);

    const r = await lc.onCrash(tid("acme"), 137); // OOM-ish exit
    expect(r.ok).toBe(true);
    // acme respawned (3rd spawn), globex untouched (still 1 live each).
    expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === "acme").length).toBe(2);
    expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === "globex").length).toBe(1);
    expect(lc.liveWorkerCount()).toBe(2);
  });

  test("onCrash for an unknown tenant is an idempotent no-op success", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({}), clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    expect((await lc.onCrash(tid("nobody"), null)).ok).toBe(true);
  });

  test("crash-loop budget: auto-restart GIVES UP after maxRestartsPerWindow within the window", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const log = recordingLog();
    // Fixed clock → the window never slides, so the budget is purely count-based.
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock,
      config: baseConfig({ maxRestartsPerWindow: 2, restartWindowMs: 60_000 }),
      logger: log,
    });
    await lc.ensureWorker(tid("acme")); // spawn #1 (live)
    await lc.onCrash(tid("acme"), 1); // restart #1 → spawn #2
    await lc.onCrash(tid("acme"), 1); // restart #2 → spawn #3
    await lc.onCrash(tid("acme"), 1); // budget exhausted → GIVE UP, no spawn
    expect(spawned.length).toBe(3); // 1 initial + exactly 2 auto-restarts
    expect(lc.liveWorkerCount()).toBe(0); // gave up — tenant is unavailable
    expect(log.errors.some((l) => l.msg.includes("crash-loop budget exhausted"))).toBe(true);

    // Recovery: a REQUEST-driven spawn is NOT budgeted (rate-limited by arrival),
    // so the tenant can still come back on the next request.
    const back = await lc.ensureWorker(tid("acme"));
    expect(back.ok).toBe(true);
    expect(spawned.length).toBe(4);
    expect(lc.liveWorkerCount()).toBe(1);
  });

  test("crash-loop budget: a slid window resets the count (sustained low-rate restarts never give up)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const clk = fixedClock();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: clk.clock,
      config: baseConfig({ maxRestartsPerWindow: 2, restartWindowMs: 1000 }),
      logger: silentLog,
    });
    await lc.ensureWorker(tid("acme")); // spawn #1
    await lc.onCrash(tid("acme"), 1); // restart #1
    clk.advance(2000); // window slides past
    await lc.onCrash(tid("acme"), 1); // window reset → restart, not give-up
    clk.advance(2000);
    await lc.onCrash(tid("acme"), 1); // window reset again → restart
    expect(spawned.length).toBe(4); // every crash restarted; budget never exhausted
    expect(lc.liveWorkerCount()).toBe(1);
  });
});

// ── Per-tenant Redis ACL provisioning (ADR-0067, AD-6) ──────────────────────────

describe("createWorkerLifecycle: per-tenant Redis ACL provisioning (ADR-0067)", () => {
  test("injects the minted ACL credential into the worker spawn env (handoff)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const provisioned: TenantId[] = [];
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
      provisionRedisAcl: async (tenant) => {
        provisioned.push(tenant);
        return ok({ username: `fugue-tenant-${tenant}`, password: "minted-secret-256", tenant });
      },
    });
    const r = await lc.ensureWorker(tid("acme"));
    expect(r.ok).toBe(true);
    expect(provisioned).toEqual([tid("acme")]);
    // The minted credential reached the worker via the spawn env (the handoff).
    const spec = spawned[0]!.spec;
    expect(spec.extraEnv?.["FUGUE_REDIS_ACL_USERNAME"]).toBe("fugue-tenant-acme");
    expect(spec.extraEnv?.["FUGUE_REDIS_ACL_PASSWORD"]).toBe("minted-secret-256");
  });

  test("fails closed (worker-unavailable, NEVER spawns) when ACL provisioning errors", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
      provisionRedisAcl: async () => err({ kind: "redis-unavailable", operation: "acl-apply" }),
    });
    const r = await lc.ensureWorker(tid("acme"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("worker-unavailable");
    expect(spawned.length).toBe(0); // never spawned — no worker started without its scoped credential
    expect(lc.liveWorkerCount()).toBe(0);
  });

  test("no provisioner wired → no ACL env injected (zero-regression default)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    const spec = spawned[0]!.spec;
    expect(spec.extraEnv?.["FUGUE_REDIS_ACL_USERNAME"]).toBeUndefined();
  });
});

// ── reconcileReadopt: eagerPin from the registry (C3, AD-7, SC-006) ─────────────

describe("createWorkerLifecycle: reconcileReadopt (SC-006, C3 eager-pin)", () => {
  const seed = async (fake: ReturnType<typeof createInMemoryWorkerRedisFake>, rec: WorkerRecord) => {
    fake.store.set(`${WORKER_KEY_PREFIX}${rec.tenant}`, JSON.stringify({
      pid: rec.pid, udsPath: rec.udsPath, startedAt: rec.startedAt, health: rec.health, eagerPin: rec.eagerPin,
    }));
  };

  test("re-adopts a live worker and sources eagerPin from the TENANT REGISTRY (not the record)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    // The persisted record says eagerPin:false, but the live registry says TRUE —
    // the registry is authoritative (a pin toggled while the supervisor was down).
    await seed(fake, { tenant: tid("acme"), pid: 5, udsPath: "/run/fugue/acme.sock", startedAt: 1000, health: "live", eagerPin: false });
    const lc = createWorkerLifecycle({
      spawn: makeSpawn().spawn, proc: makeSpawn().proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: true } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    const r = await lc.reconcileReadopt();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.adopted).toEqual([tid("acme")]);
    expect(lc.liveWorkerCount()).toBe(1);
  });

  test("a re-adopted eager-pinned worker is NOT idle-evictable (AD-7)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    await seed(fake, { tenant: tid("acme"), pid: 5, udsPath: "/run/fugue/acme.sock", startedAt: 0, health: "live", eagerPin: false });
    const clk = fixedClock();
    const lc = createWorkerLifecycle({
      spawn: makeSpawn().spawn, proc: makeSpawn().proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: true } }), // authoritative pin = TRUE
      clock: clk.clock, config: baseConfig({ idleEvictMs: 1000 }), logger: silentLog,
    }) as ReturnType<typeof createWorkerLifecycle> & { idleEvictSweep: () => Promise<readonly TenantId[]> };
    await lc.reconcileReadopt();
    // Advance well past the idle TTL.
    clk.advance(10_000);
    const evicted = await lc.idleEvictSweep();
    expect(evicted).toEqual([]); // pinned → never idle-evicted
    expect(lc.liveWorkerCount()).toBe(1);
  });

  test("idle-evict sweep DOES evict an unpinned idle worker", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    await seed(fake, { tenant: tid("acme"), pid: 5, udsPath: "/run/fugue/acme.sock", startedAt: 0, health: "live", eagerPin: false });
    const clk = fixedClock();
    const lc = createWorkerLifecycle({
      spawn: makeSpawn().spawn, proc: makeSpawn().proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: clk.clock, config: baseConfig({ idleEvictMs: 1000 }), logger: silentLog,
    }) as ReturnType<typeof createWorkerLifecycle> & { idleEvictSweep: () => Promise<readonly TenantId[]> };
    await lc.reconcileReadopt();
    clk.advance(10_000);
    const evicted = await lc.idleEvictSweep();
    expect(evicted).toEqual([tid("acme")]);
    expect(lc.liveWorkerCount()).toBe(0);
  });
});

// ── crash-exit watcher: handle.exited drives onCrash (FR-014/FR-015, AD-8) ──────

describe("createWorkerLifecycle: crash-exit watcher (FR-014/FR-015, AD-8)", () => {
  test("a worker whose handle.exited resolves is respawned; another tenant is untouched (containment)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false }, globex: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    await lc.ensureWorker(tid("globex"));
    expect(spawned.length).toBe(2);

    // Simulate ONLY acme's worker crashing (its `handle.exited` resolves).
    const acmeRec = spawned.find((s) => (s.spec.tenant as unknown as string) === "acme")!;
    acmeRec.exit(137); // OOM-ish
    await flushMicrotasks();

    // The crash-exit watcher drove onCrash → acme respawned (2 acme spawns total).
    expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === "acme").length).toBe(2);
    // globex was never touched (containment): still exactly one spawn.
    expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === "globex").length).toBe(1);
    expect(lc.liveWorkerCount()).toBe(2);
  });

  test("a deliberate evict that resolves handle.exited does NOT trigger a respawn (pid/phase guard)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    expect(spawned.length).toBe(1);

    // Deliberately evict (removes the entry BEFORE signalling), THEN the worker's
    // process exits in response to the SIGKILL — resolving handle.exited.
    await lc.evict(tid("acme"));
    spawned[0]!.exit(null); // signal-kill → null exit code
    await flushMicrotasks();

    // No respawn: the guard saw the entry was no longer this live incarnation.
    expect(spawned.length).toBe(1);
    expect(lc.liveWorkerCount()).toBe(0);
  });

  test("a deliberate idle-evict that resolves handle.exited does NOT trigger a respawn", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const clk = fixedClock();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: clk.clock, config: baseConfig({ idleEvictMs: 1000 }), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    clk.advance(10_000);
    const evicted = await lc.idleEvictSweep();
    expect(evicted).toEqual([tid("acme")]);
    spawned[0]!.exit(null); // worker exits after the idle-evict SIGTERM
    await flushMicrotasks();
    expect(spawned.length).toBe(1); // no respawn
    expect(lc.liveWorkerCount()).toBe(0);
  });
});

// ── liveness sweep: crash-detection SAFETY NET for RE-ADOPTED workers ────────────
//
// A worker SPAWNED by this process carries a `handle.exited` crash watcher. A
// worker RE-ADOPTED across a supervisor restart (`adoptLive`) does NOT — its
// process was re-parented, so this process never owns its handle and has no
// `exited` promise to await. `livenessSweep` is its ONLY crash signal: it polls
// `proc.isAlive` for non-watcher-covered workers and drives `onCrash` for any that
// died, so a re-adopted worker that crashes is RESTARTED rather than wedging its
// tenant at 503 forever (an eager-pinned one is never idle-evicted either).

describe("createWorkerLifecycle: liveness sweep for re-adopted workers (SC-006, FR-014/FR-015)", () => {
  const seed = (fake: ReturnType<typeof createInMemoryWorkerRedisFake>, rec: WorkerRecord) => {
    fake.store.set(`${WORKER_KEY_PREFIX}${rec.tenant}`, JSON.stringify({
      pid: rec.pid, udsPath: rec.udsPath, startedAt: rec.startedAt, health: rec.health, eagerPin: rec.eagerPin,
    }));
  };

  /** Wrap a base proc so liveness is controllable per-pid (default: alive). */
  const controllableProc = (base: ProcManagePort) => {
    const dead = new Set<number>();
    const proc: ProcManagePort = {
      signal: base.signal,
      isAlive: async (pid) => !dead.has(pid),
    };
    return { proc, kill: (pid: number) => dead.add(pid) };
  };

  test("a re-adopted worker whose pid died is DETECTED and restarted (no permanent 503)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const base = makeSpawn();
    const { proc, kill } = controllableProc(base.proc);
    // Eager-pinned: also proves the never-idle-evicted wedge case recovers.
    seed(fake, { tenant: tid("acme"), pid: 5, udsPath: "/run/fugue/acme.sock", startedAt: 0, health: "live", eagerPin: true });
    const lc = createWorkerLifecycle({
      spawn: base.spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: true } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.reconcileReadopt();
    expect(lc.liveWorkerCount()).toBe(1);
    expect(base.spawned.length).toBe(0); // adopted — never spawned by THIS process

    // The re-parented worker dies. There is NO exited watcher for it.
    kill(5);
    const dead = await lc.livenessSweep();
    expect(dead).toEqual([tid("acme")]);
    // Detected → onCrash → respawned via the normal spawn path (now watcher-covered).
    expect(base.spawned.filter((s) => (s.spec.tenant as unknown as string) === "acme").length).toBe(1);
    expect(lc.liveWorkerCount()).toBe(1); // restored, not wedged at 503
  });

  test("a re-adopted worker that is still ALIVE is left untouched", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const base = makeSpawn();
    const { proc } = controllableProc(base.proc); // nothing killed → all alive
    seed(fake, { tenant: tid("acme"), pid: 5, udsPath: "/run/fugue/acme.sock", startedAt: 0, health: "live", eagerPin: false });
    const lc = createWorkerLifecycle({
      spawn: base.spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.reconcileReadopt();
    const dead = await lc.livenessSweep();
    expect(dead).toEqual([]);
    expect(base.spawned.length).toBe(0); // no respawn
    expect(lc.liveWorkerCount()).toBe(1);
  });

  test("a SPAWNED (watcher-covered) worker is NOT swept even if its pid reads dead (no double-fire)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const base = makeSpawn();
    const { proc, kill } = controllableProc(base.proc);
    const lc = createWorkerLifecycle({
      spawn: base.spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme")); // spawned → watcher-covered
    const pid = base.spawned[0]!.pid;
    kill(pid); // even if a poll WOULD read it dead...
    const dead = await lc.livenessSweep();
    expect(dead).toEqual([]); // ...the sweep skips watched tenants (the exited watcher owns crash detection)
    expect(base.spawned.length).toBe(1); // no sweep-driven respawn
    expect(lc.liveWorkerCount()).toBe(1);
  });
});

// ── restart-at-cap: a crashing tenant at the cap must respawn (FR-015) ───────────

describe("createWorkerLifecycle: restart at SUPERVISOR_MAX_LIVE_WORKERS (FR-015)", () => {
  test("at maxLiveWorkers=1 and AT the cap, crashing the sole tenant respawns it (no self-block)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig({ maxLiveWorkers: 1 }), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    expect(lc.liveWorkerCount()).toBe(1); // at the cap

    // Crash the one tenant. onCrash must NOT count the crashing tenant's own
    // restarting slot against the cap → it respawns rather than refusing.
    const r = await lc.onCrash(tid("acme"), 137);
    expect(r.ok).toBe(true);
    expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === "acme").length).toBe(2);
    expect(lc.liveWorkerCount()).toBe(1); // respawned, still exactly one live
  });

  test("crash-exit watcher path also respawns the sole tenant at the cap", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc, spawned } = makeSpawn();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig({ maxLiveWorkers: 1 }), logger: silentLog,
    });
    await lc.ensureWorker(tid("acme"));
    spawned[0]!.exit(137);
    await flushMicrotasks();
    expect(spawned.filter((s) => (s.spec.tenant as unknown as string) === "acme").length).toBe(2);
    expect(lc.liveWorkerCount()).toBe(1);
  });
});

// ── T9: failed kills SURFACE (Fix 1) — discarded proc.signal Results ─────────────
//
// proc.signal returns Result<void, HostError>; the Bun adapter maps ESRCH
// (already-dead) to ok, so a !ok is a GENUINE failure (EPERM / invalid signal /
// throw). In the evict / idle-evict paths the entry + registry record are removed
// BEFORE signalling, so a silently-failed kill leaves an orphan still bound to the
// UDS while the slot reads reclaimed — corrupting the FR-033 live-worker count.
// These tests prove the failure now SURFACES via the logger.

describe("createWorkerLifecycle: failed kills surface via the logger (T9 Fix 1)", () => {
  test("evict: a failed SIGKILL after slot reclaim is logged at ERROR (orphan risk)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn({ signalFails: true });
    const log = recordingLog();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: log,
    });
    await lc.ensureWorker(tid("acme"));
    await lc.evict(tid("acme"));
    // The SIGKILL (the slot-reclaiming kill) failed → ERROR with full context.
    const orphanLine = log.errors.find((l) => l.msg.includes("may be orphaned"));
    expect(orphanLine).toBeDefined();
    expect(orphanLine!.ctx).toMatchObject({ tenant: tid("acme"), sig: "SIGKILL" });
    expect((orphanLine!.ctx as { error: string }).error).toContain("EPERM");
  });

  test("idle-evict sweep: a failed SIGKILL after slot reclaim is logged at ERROR (orphan risk)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn({ signalFails: true });
    const clk = fixedClock();
    const log = recordingLog();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: clk.clock, config: baseConfig({ idleEvictMs: 1000 }), logger: log,
    }) as ReturnType<typeof createWorkerLifecycle> & { idleEvictSweep: () => Promise<readonly TenantId[]> };
    await lc.ensureWorker(tid("acme"));
    clk.advance(10_000);
    const evicted = await lc.idleEvictSweep();
    expect(evicted).toEqual([tid("acme")]); // the eviction itself still proceeds (best-effort)
    // Idle-evict now drains then force-stops (SIGTERM → SIGKILL). The SIGKILL is
    // the slot-reclaiming kill, so its failure is the orphan-risk ERROR.
    const orphanLine = log.errors.find((l) => l.msg.includes("may be orphaned"));
    expect(orphanLine).toBeDefined();
    expect(orphanLine!.ctx).toMatchObject({ tenant: tid("acme"), sig: "SIGKILL" });
  });

  test("drain: a failed SIGTERM (no slot reclaim) is logged at WARN", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn({ signalFails: true });
    const log = recordingLog();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: log,
    });
    await lc.ensureWorker(tid("acme"));
    const r = await lc.drain(tid("acme"));
    expect(r.ok).toBe(true); // best-effort: drain reports success
    const warnLine = log.warns.find((l) => l.msg.includes("signal failed (best-effort)"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.ctx).toMatchObject({ tenant: tid("acme"), sig: "SIGTERM" });
    // NOT escalated to error (the entry is still tracked as draining — no orphan).
    expect(log.errors.some((l) => l.msg.includes("may be orphaned"))).toBe(false);
  });

  test("spawn-readiness timeout: a failed cleanup SIGKILL is logged (warn, no orphan)", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => false);
    const { spawn, proc } = makeSpawn({ signalFails: true });
    const log = recordingLog();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => false,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig({ spawnReadyTimeoutMs: 0 }), logger: log,
    });
    const r = await lc.ensureWorker(tid("acme"));
    expect(r.ok).toBe(false);
    const warnLine = log.warns.find((l) => l.msg.includes("signal failed (best-effort)"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.ctx).toMatchObject({ tenant: tid("acme"), sig: "SIGKILL" });
  });
});

// ── T9: beginDrain invariant rejection is no longer swallowed (Fix 2) ────────────
//
// `drain` confirms phase === "live" before calling beginDrain. With the real ADT,
// beginDrain on a live state is total-success, so the rejection branch is defensive
// — but if it EVER rejects (a true ADT invariant violation) it must surface loudly
// and distinguishably, not collapse into the legitimate "nothing live" ok(undefined)
// no-op. We force the rejection by module-mocking beginDrain.

describe("createWorkerLifecycle: beginDrain invariant rejection surfaces (T9 Fix 2)", () => {
  test("a beginDrain rejection AFTER confirming the worker live is logged at ERROR and returns the error", async () => {
    // Override ONLY beginDrain to reject; everything else stays the real ADT.
    mock.module("../../../supervisor/lifecycle/worker-lifecycle.js", () => ({
      ...lifecycleAdt,
      beginDrain: () => err(signalErr),
    }));
    // Re-import the manager so it binds the mocked module.
    const { createWorkerLifecycle: createWithMock } = await import(
      "../../../supervisor/lifecycle/worker-lifecycle-manager.js"
    );

    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn();
    const log = recordingLog();
    const lc = createWithMock({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: log,
    });
    await lc.ensureWorker(tid("acme"));

    const r = await lc.drain(tid("acme"));
    // No longer silent success: the invariant violation propagates as an error...
    expect(r.ok).toBe(false);
    // ...and is logged LOUDLY + distinguishably from the no-op.
    const invariantLine = log.errors.find((l) => l.msg.includes("beginDrain rejected for a confirmed-live worker"));
    expect(invariantLine).toBeDefined();
    expect(invariantLine!.ctx).toMatchObject({ tenant: tid("acme") });

    // Restore the real module so later test files are unaffected.
    mock.module("../../../supervisor/lifecycle/worker-lifecycle.js", () => ({ ...lifecycleAdt }));
  });

  test("the legitimate 'nothing live to drain' path stays a quiet ok(undefined) no-op", async () => {
    const fake = createInMemoryWorkerRedisFake();
    const reg = createWorkerRegistry(fake.redis, async () => true);
    const { spawn, proc } = makeSpawn();
    const log = recordingLog();
    const lc = createWorkerLifecycle({
      spawn, proc, registry: reg, probe: async () => true,
      tenants: tenantsView({ acme: { eagerPin: false } }),
      clock: fixedClock().clock, config: baseConfig(), logger: log,
    });
    // Never spawned → nothing live.
    const r = await lc.drain(tid("acme"));
    expect(r.ok).toBe(true);
    expect(log.errors.length).toBe(0);
  });
});
