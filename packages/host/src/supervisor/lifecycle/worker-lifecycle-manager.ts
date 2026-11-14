/**
 * Worker lifecycle MANAGER — the imperative-shell ORCHESTRATOR that composes the
 * pure lifecycle ADT (`worker-lifecycle.ts`), the `SpawnPort` / `ProcManagePort`
 * (`bun-spawn-adapter.ts`), the Redis `WorkerRegistry` (`worker-registry-redis.ts`),
 * a UDS liveness probe, and the tenant registry into a single
 * `WorkerLifecyclePort` the supervisor injects (multi-tenant spec FR-014/015/019/020, SC-006).
 *
 * DESIGN (functional core / imperative shell):
 *   - ALL state-transition DECISIONS live in the pure ADT (`requestWorker`,
 *     `workerLive`, `touch`, `idleEvict`, `beginDrain`, `crash`,
 *     `adoptLive`, the `isIdleEvictable` / `occupiesSlot` queries). This module
 *     only performs the I/O (spawn / signal / probe / Redis write) and threads the
 *     resulting pure states through a per-tenant `Map<TenantId, WorkerState>`.
 *     (NOTE: the ADT's `restart` transition EXISTS but is deliberately NOT used
 *     here — see RESTART-AT-CAP in `onCrash` below: we delete the crashed entry
 *     and re-enter via `requestWorker` so the cap admission check runs first.)
 *   - It NEVER calls `Date.now()` (repo ban) — every transition is fed the
 *     injected `clock()`.
 *   - It is FAIL-CLOSED + per-tenant CONTAINED: any spawn/probe/registry failure
 *     for one tenant surfaces as that tenant's `worker-unavailable` (503) and
 *     never touches another tenant's entry (multi-tenant spec FR-015, AD-8).
 *
 * SECURITY (multi-tenant spec FR-004 one-tenant-one-socket): the udsPath a worker binds is a PURE
 * function of its `TenantId` (`workerSocketPath(udsDir, tenant)`), derived HERE —
 * never taken from arbitrary input — so a worker can only ever own its own socket.
 *
 * SECURITY (multi-tenant spec FR-005 reference-only): the spawn forwards the tenant's `secretsRef`
 * REFERENCE only; this module never dereferences a secret.
 */

import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { workerUnavailable, formatHostError } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import type { TenantId, SecretsRef } from "../../domain/tenant.js";
import type { LogPort } from "../../ports.js";
import { workerSocketPath } from "../../domain/config.js";
import * as lifecycleAdt from "./worker-lifecycle.js";
import type { WorkerState } from "./worker-lifecycle.js";
import { initialRestartBudget, decideSupervisorRestart } from "./thin-init.js";
import type { RestartBudget } from "./thin-init.js";
import type { AppliedAclCredential } from "../secrets/redis-acl-provisioner.js";
import { WORKER_REDIS_ACL_USERNAME_ENV, WORKER_REDIS_ACL_PASSWORD_ENV } from "../secrets/redis-acl.js";
import type { SpawnPort, ProcManagePort, WorkerLifecyclePort, WorkerHandle, EnsuredWorker } from "./spawn-port.js";
import type { WorkerRegistry, WorkerRecord, UdsLivenessProbe } from "./worker-registry-redis.js";

// ── Tenant config view the lifecycle needs ──────────────────────────────────

/**
 * The per-tenant spawn inputs the lifecycle sources from the tenant registry.
 * This is the AUTHORITATIVE source of `eagerPin` (AD-7, C3) — never defaulted.
 * Kept as a narrow injected view so the manager depends only on what it needs
 * (and can be faked without the whole Redis registry).
 */
export interface TenantSpawnConfig {
  readonly secretsRef: SecretsRef;
  readonly eagerPin: boolean;
  /**
   * The tenant's DAG root (`TenantConfigBase.dagsRoot`). Injected into the worker's
   * spawn env as `DAGS_LOCAL_PATH` so the worker runs the LocalGitAdapter rooted
   * HERE and discovers ONLY this team's DAGs — the at-rest DAG-isolation boundary
   * for a multi-tenant pod (ADR-0061). Applied via `extraEnv`, which `buildWorkerSpawn`
   * merges OVER the inherited env, so it deterministically overrides any pod-wide
   * `DAGS_LOCAL_PATH` the supervisor itself may carry. Sourced from the active
   * tenant registry (authoritative, like `eagerPin`); unset only on paths that do
   * not spawn from the registry.
   */
  readonly dagsRoot?: string;
  /**
   * Per-tenant ceiling on outstanding HITL runs (ADR-0074, `admission.maxQueuedRuns`).
   * Injected into the worker's spawn env as `FUGUE_MAX_QUEUED_RUNS` so the worker's
   * `HitlRunService` enforces it at `startRun`. Sourced from the active tenant
   * registry config (authoritative, like `eagerPin`); unset only on the
   * single-tenant path.
   */
  readonly maxQueuedRuns?: number;
  /**
   * Optional per-tenant extra env forwarded to the worker.
   *
   * NOTE (A1): platform-wide config (REDIS_URL, REALM_JWT_ISSUER, …) is NOT
   * carried here — the Bun spawn adapter is constructed with the supervisor's
   * `process.env` as its `inheritedEnv`, and `buildWorkerSpawn` merges that whole
   * inherited env into every child, so workers inherit REDIS_URL / issuer / etc.
   * AUTOMATICALLY. `extraEnv` is reserved for genuinely PER-TENANT overrides (it
   * is applied before — and so cannot override — the mandatory TENANT_ID /
   * FUGUE_SECRETS_REF / WORKER_UDS_DIR bindings). Today no per-tenant override is
   * sourced, so `spawnConfigFor` leaves it unset.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Read-only view over the tenant registry the lifecycle consults for spawn config
 * + the authoritative `eagerPin`. Returns `undefined` for an unknown/deregistered
 * tenant (fail-closed: the lifecycle refuses to spawn one it cannot configure).
 */
export interface TenantSpawnConfigView {
  readonly spawnConfigFor: (tenant: TenantId) => TenantSpawnConfig | undefined;
}

// ── Manager config + deps ────────────────────────────────────────────────────

export interface WorkerLifecycleConfig {
  /** Directory under which `<tenant>.sock` lives (`WORKER_UDS_DIR`). */
  readonly udsDir: string;
  /** Absolute path to the worker entrypoint (`worker-main.ts`). */
  readonly workerEntry: string;
  /** Idle TTL (ms) after which a non-pinned live worker is idle-evictable. */
  readonly idleEvictMs: number;
  /** Per-worker V8 heap cap (MB), AD-9. Unset → no explicit cap. */
  readonly heapCapMb?: number;
  /** Upper bound on simultaneously-slotted workers (spawning/live/draining). Unset → no cap. */
  readonly maxLiveWorkers?: number;
  /** Bounded wait (ms) for a freshly-spawned worker's UDS to become reachable. */
  readonly spawnReadyTimeoutMs: number;
  /** Poll interval (ms) while waiting for UDS readiness. */
  readonly spawnReadyPollMs: number;
  /**
   * Per-tenant crash-loop budget: max AUTOMATIC respawns (driven by `onCrash`)
   * for one tenant within `restartWindowMs` before the manager gives up the
   * auto-restart. Mirrors the supervisor-process budget (`thin-init`). A tenant
   * whose worker boots-then-crashes-fast cannot pin a core. The budget is
   * WINDOW-based (NOT reset when the worker reaches `live`): a worker that reaches
   * `live` briefly each cycle still counts toward the budget — recovery happens by
   * the sliding window expiring (a tenant healthy for > `restartWindowMs` resets on
   * its next crash). Request-driven spawns are not budgeted (rate-limited by arrival).
   */
  readonly maxRestartsPerWindow: number;
  /** Sliding window (ms) for `maxRestartsPerWindow`. */
  readonly restartWindowMs: number;
}

interface WorkerLifecycleDeps {
  readonly spawn: SpawnPort;
  readonly proc: ProcManagePort;
  readonly registry: WorkerRegistry;
  /** UDS liveness probe — "is the worker bound to `udsPath` answering?". */
  readonly probe: UdsLivenessProbe;
  /** Authoritative tenant spawn config (secretsRef + eagerPin). */
  readonly tenants: TenantSpawnConfigView;
  /**
   * The pure worker-lifecycle ADT, injectable so tests can force an ADT
   * invariant violation (e.g. a `beginDrain` rejection on a confirmed-live
   * worker) WITHOUT a process-global `mock.module` — bun 1.3.x module mocks
   * are not reliably restorable and leak into other test files sharing the
   * worker process (worker-lifecycle.test.ts failed intermittently with the
   * manager test's fixture error). Production callers omit it: the real ADT
   * is bound.
   */
  readonly lifecycle?: WorkerLifecycleAdt;
  /**
   * OPTIONAL per-tenant Redis-ACL provisioner (ADR-0067, AD-6). When wired (gated
   * by `SUPERVISOR_REDIS_ACL_ENABLED`), `lazySpawn` mints a FRESH scoped ACL
   * credential per spawn and injects it into the worker's env so the worker
   * authenticates to Redis as its OWN per-tenant user (`~fugue:<tenant>:*`,
   * NOPERM-enforced) instead of the shared default user. Fail-closed: a
   * provisioning error refuses the spawn (`worker-unavailable`). The minted
   * password transits ONLY the spawn env — the supervisor keeps no copy and never
   * logs it. Unset → no provisioning (worker uses the shared `REDIS_URL`
   * credential; today's behaviour, zero regression).
   */
  readonly provisionRedisAcl?: (tenant: TenantId) => Promise<Result<AppliedAclCredential, HostError>>;
  /** Injected clock — NEVER Date.now (repo ban). */
  readonly clock: () => number;
  readonly config: WorkerLifecycleConfig;
  readonly logger: LogPort;
}

/** The pure worker-lifecycle ADT module shape (`worker-lifecycle.ts`). */
export type WorkerLifecycleAdt = typeof import("./worker-lifecycle.js");

// ── Manager ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One manager's collaborators plus its per-instance mutable state. Every
 * lifecycle step below takes this context explicitly; the only mutable state is
 * the four containers (and `livenessSweepRunning`), and every `workers` entry is
 * an immutable pure `WorkerState` we replace, never mutate.
 */
interface LifecycleCtx {
  readonly spawn: SpawnPort;
  readonly proc: ProcManagePort;
  readonly registry: WorkerRegistry;
  readonly probe: UdsLivenessProbe;
  readonly tenants: TenantSpawnConfigView;
  readonly clock: () => number;
  readonly config: WorkerLifecycleConfig;
  readonly logger: LogPort;
  readonly provisionRedisAcl: WorkerLifecycleDeps["provisionRedisAcl"];
  readonly lifecycle: WorkerLifecycleAdt;
  /** Per-tenant pure ADT state. */
  readonly workers: Map<TenantId, WorkerState>;
  /**
   * In-flight cold-spawn coalescing (single-flight per tenant). `lazySpawn` sets
   * the `spawning` entry synchronously but then `await`s the spawn; two concurrent
   * first-requests for the same cold tenant would BOTH pass the no-live-worker
   * check and BOTH spawn a process onto the same `workerSocketPath` (UDS bind
   * contention, double-charged slot, an orphaned process). `ensureWorker` dedupes
   * concurrent callers onto ONE shared promise keyed by `TenantId`, cleared on
   * settle, so a cold tenant is spawned exactly once even under a request burst.
   */
  readonly inFlightSpawns: Map<TenantId, Promise<Result<EnsuredWorker, HostError>>>;
  /**
   * Tenants whose CURRENT incarnation was SPAWNED by this manager and therefore
   * carries a `handle.exited` crash watcher (attached in `lazySpawn`). Crash
   * detection for these tenants flows through that watcher.
   *
   * RE-ADOPTED workers (`reconcileReadopt` → `adoptLive`) are NOT in this set: the
   * worker was re-parented across a supervisor restart, so this process never owns
   * its `WorkerHandle` and has no `exited` promise to await. Their ONLY crash
   * signal is `livenessSweep` (poll `proc.isAlive`). The set is what lets the sweep
   * skip watched tenants so it never double-fires `onCrash` against a worker the
   * exited-watcher already covers. Membership is sticky: once a tenant is spawned
   * by this process, every later incarnation is also spawned (respawn re-enters
   * `lazySpawn`), so it stays watcher-covered for this process's lifetime.
   */
  readonly watchedTenants: Set<TenantId>;
  /**
   * Per-tenant crash-loop budget (mirrors the supervisor-process budget in
   * thin-init). Tracks AUTOMATIC `onCrash` respawns within a SLIDING window; an
   * exhausted budget stops the auto-restart so a boots-then-crashes-fast worker
   * cannot pin a core. Window-based (NOT reset on `live`): a worker that reaches
   * `live` briefly each cycle still counts toward the budget — the window sliding
   * is the recovery path (a tenant healthy for > windowMs resets on its next crash).
   */
  readonly restartBudgets: Map<TenantId, RestartBudget>;
  /**
   * Single-flight guard for `livenessSweep`: serialize sweeps so two overlapping
   * ticks cannot both detect the same dead adopted worker and drive `onCrash`
   * twice (the second `crash` from a `spawning`/`crashed` phase would drop the
   * respawning entry). One sweep at a time; a tick that overlaps a slow sweep is
   * skipped (liveness detection is not latency-critical).
   */
  livenessSweepRunning: boolean;
}

/** Count of workers occupying a slot (spawning/live/draining) — T9 reads this. */
const liveWorkerCount = (ctx: LifecycleCtx): number => {
  let n = 0;
  for (const s of ctx.workers.values()) if (ctx.lifecycle.occupiesSlot(s)) n++;
  return n;
};

/**
 * Best-effort signal a worker pid, surfacing GENUINE kill failures.
 *
 * `proc.signal` returns `ok` for ESRCH (already-dead) — the Bun adapter treats a
 * vanished pid as success — so a `!ok` here is a REAL failure (EPERM, invalid
 * signal, unexpected throw). The kill itself stays best-effort (we never abort
 * control flow), but a failure MUST be observable:
 *  - `orphanRisk: true` → the caller has already removed the map entry + registry
 *    record, so a failed SIGKILL leaves an orphaned worker still bound to its UDS
 *    while the supervisor believes the slot is reclaimed (corrupts the multi-tenant spec FR-033
 *    live-worker count). Logged at `error`.
 *  - `orphanRisk: false` → the slot is not yet considered reclaimed (e.g. SIGTERM
 *    during drain); logged at `warn`.
 */
const signalWorker = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  pid: number,
  sig: "SIGTERM" | "SIGKILL",
  orphanRisk: boolean,
): Promise<void> => {
  const r = await ctx.proc.signal(pid, sig);
  if (r.ok) return;
  const logCtx = { tenant, pid, sig, error: formatHostError(r.error) };
  if (orphanRisk) {
    ctx.logger.error(
      "[worker-lifecycle] kill failed AFTER slot reclaim — worker may be orphaned (still bound to its UDS); live-worker count may be inaccurate",
      logCtx,
    );
  } else {
    ctx.logger.warn("[worker-lifecycle] signal failed (best-effort)", logCtx);
  }
};

/**
 * Persist a record derived from a live/draining pure state.
 *
 * Returns the write outcome instead of swallowing it: the registry record is
 * the ONLY channel through which a restarted supervisor can rediscover a
 * worker. `reconcileReadopt` rebuilds the in-memory map exclusively from
 * `registry.reconcileReadopt()` — there is no independent scan of live pids or
 * bound sockets — so a record that never lands makes its worker invisible to
 * BOTH readoption and `evict` while it stays alive and bound to the tenant's
 * UDS, still holding that tenant's credentials. The two call sites have
 * genuinely different obligations here, so the decision belongs to them, not
 * to a `warn` inside this helper.
 *
 * A phase with no durable record (anything but live/draining) is a no-op success.
 */
const persistRecord = async (ctx: LifecycleCtx, state: WorkerState): Promise<Result<void, HostError>> => {
  let record: WorkerRecord | undefined;
  if (state.phase === "live") {
    record = { tenant: state.tenant, pid: state.pid, udsPath: state.udsPath, startedAt: state.startedAt, health: "live", eagerPin: state.eagerPin };
  } else if (state.phase === "draining") {
    record = { tenant: state.tenant, pid: state.pid, udsPath: state.udsPath, startedAt: state.drainStartedAt, health: "draining", eagerPin: state.eagerPin };
  }
  if (record === undefined) return ok(undefined);
  return ctx.registry.put(record);
};

/** Remove a tenant's registry record (best-effort). */
const removeRecord = async (ctx: LifecycleCtx, tenant: TenantId): Promise<void> => {
  const r = await ctx.registry.remove(tenant);
  if (!r.ok) ctx.logger.warn("[worker-lifecycle] registry remove failed (continuing)", { tenant });
};

/**
 * Abandon a spawn in progress: forget the map entry, then SIGKILL the process
 * we started.
 *
 * ONE definition for `lazySpawn`'s abort branches (UDS never came up, the
 * `spawning` entry vanished under us, the `workerLive` transition was rejected,
 * the registry write failed). Deleting the entry BEFORE signalling is
 * load-bearing: the crash-exit watcher keys on "is the map entry still THIS
 * incarnation?", so a deliberate abort SIGKILL must not be readable as a crash
 * and trigger a respawn.
 *
 * `orphanRisk` says whether a FAILED kill would leave a process still bound to
 * the tenant's UDS while the slot already reads as reclaimed — true once a
 * registry record existed, false while the spawn was never announced.
 */
const abortSpawn = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  pid: number,
  orphanRisk: boolean,
): Promise<Result<never, HostError>> => {
  ctx.workers.delete(tenant);
  await signalWorker(ctx, tenant, pid, "SIGKILL", orphanRisk);
  return err(workerUnavailable(tenant));
};

/**
 * Immediate revoke of a running worker: forget it, drop its registry record,
 * then SIGTERM+SIGKILL back-to-back with NO intervening wait.
 *
 * ONE definition for `evict` (multi-tenant spec FR-029 / NFR-012) and
 * `idleEvictSweep` (AD-7), which are the same teardown with different triggers.
 * This is deliberately NOT graceful — that is `drain()`'s job (SIGTERM only,
 * terminal cleanup deferred to `drainComplete` on actual exit). SIGTERM is the
 * polite first signal; SIGKILL guarantees the slot is reclaimed even if the
 * worker ignores it, so the live-worker count (FR-033) cannot under-count.
 * Both are idempotent on a dead pid.
 *
 * Entry and record are removed FIRST (same crash-watcher reason as
 * `abortSpawn`), which is exactly why a failed SIGKILL is orphan-risk: the slot
 * reads as reclaimed while a process may still hold the UDS.
 */
const hardStopAndForget = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  pid: number | undefined,
): Promise<void> => {
  ctx.workers.delete(tenant);
  await removeRecord(ctx, tenant);
  if (pid === undefined) return;
  await signalWorker(ctx, tenant, pid, "SIGTERM", false);
  await signalWorker(ctx, tenant, pid, "SIGKILL", true);
};

/** Wait, bounded, for a worker's UDS to become reachable via the probe. */
const waitForUds = async (ctx: LifecycleCtx, record: WorkerRecord): Promise<boolean> => {
  const deadline = ctx.clock() + ctx.config.spawnReadyTimeoutMs;
  // Always probe at least once.
  for (;;) {
    let alive = false;
    try {
      alive = await ctx.probe(record);
    } catch (e) {
      ctx.logger.warn("[worker-lifecycle] UDS probe threw during spawn-wait — treating as not-ready", {
        tenant: record.tenant,
        error: e instanceof Error ? e.message : String(e),
      });
      alive = false;
    }
    if (alive) return true;
    if (ctx.clock() >= deadline) return false;
    await sleep(ctx.config.spawnReadyPollMs);
  }
};

// ── Spawn path ───────────────────────────────────────────────────────────────

/**
 * Spawn admission: refuse if at the live-worker ceiling (T9 count primitive),
 * and refuse a tenant with no active spawn config (fail closed).
 */
const admitSpawn = (ctx: LifecycleCtx, tenant: TenantId): Result<TenantSpawnConfig, HostError> => {
  const { config, logger } = ctx;
  if (config.maxLiveWorkers !== undefined && liveWorkerCount(ctx) >= config.maxLiveWorkers) {
    logger.warn("[worker-lifecycle] at SUPERVISOR_MAX_LIVE_WORKERS — refusing new worker", { tenant, cap: config.maxLiveWorkers });
    return err(workerUnavailable(tenant));
  }

  const spawnCfg = ctx.tenants.spawnConfigFor(tenant);
  if (spawnCfg === undefined) {
    // No active config → cannot configure a worker. Fail closed.
    logger.warn("[worker-lifecycle] no spawn config for tenant — refusing", { tenant });
    return err(workerUnavailable(tenant));
  }
  return ok(spawnCfg);
};

/**
 * Build the worker's per-tenant spawn env overrides. Everything is applied via
 * `extraEnv` (which `buildWorkerSpawn` merges OVER the inherited env), so a stray
 * pod-wide inherited value can never override this tenant's configuration.
 *
 * Per-tenant Redis ACL (ADR-0067): when provisioning is wired, mint a FRESH
 * scoped credential and inject it so the worker connects to Redis as its own
 * `~fugue:<tenant>:*` user. The password is local to this call (and the spawn
 * env) — never retained or logged here. On a provisioning failure we RELEASE the
 * reserved slot and fail closed (no worker spawned).
 */
const buildSpawnEnv = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  spawnCfg: TenantSpawnConfig,
): Promise<Result<Readonly<Record<string, string>> | undefined, HostError>> => {
  let extraEnv = spawnCfg.extraEnv;
  if (ctx.provisionRedisAcl !== undefined) {
    const cred = await ctx.provisionRedisAcl(tenant);
    if (!cred.ok) {
      ctx.logger.error("[worker-lifecycle] redis ACL provisioning failed — refusing spawn (fail-closed)", {
        tenant,
        error: formatHostError(cred.error),
      });
      ctx.workers.delete(tenant);
      return err(workerUnavailable(tenant));
    }
    extraEnv = {
      ...(extraEnv ?? {}),
      [WORKER_REDIS_ACL_USERNAME_ENV]: cred.value.username,
      [WORKER_REDIS_ACL_PASSWORD_ENV]: cred.value.password,
    };
  }

  // Per-tenant HITL queue-depth ceiling (ADR-0074): forward the registry's
  // `maxQueuedRuns` so the worker's HITL service gates `startRun`.
  if (spawnCfg.maxQueuedRuns !== undefined) {
    extraEnv = { ...(extraEnv ?? {}), FUGUE_MAX_QUEUED_RUNS: String(spawnCfg.maxQueuedRuns) };
  }

  // Per-tenant DAG root (ADR-0061 at-rest isolation): forward the registry's
  // `dagsRoot` as DAGS_LOCAL_PATH so THIS worker globs `dags/**/dag.ts` under its
  // own team's staged bundle alone — never the whole multi-team tree.
  if (spawnCfg.dagsRoot !== undefined) {
    extraEnv = { ...(extraEnv ?? {}), DAGS_LOCAL_PATH: spawnCfg.dagsRoot };
  }
  return ok(extraEnv);
};

/** Start the worker process; a failure releases the reserved slot and fails closed. */
const spawnWorkerProcess = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  spawnCfg: TenantSpawnConfig,
  udsPath: string,
  extraEnv: Readonly<Record<string, string>> | undefined,
): Promise<Result<WorkerHandle, HostError>> => {
  const { config } = ctx;
  const spawnResult = await ctx.spawn.spawn({
    tenant,
    secretsRef: spawnCfg.secretsRef, // REFERENCE only (multi-tenant spec FR-005).
    workerEntry: config.workerEntry,
    udsPath,
    ...(config.heapCapMb !== undefined ? { heapCapMb: config.heapCapMb } : {}),
    ...(extraEnv !== undefined ? { extraEnv } : {}),
  });
  if (!spawnResult.ok) {
    // Surface the UNDERLYING spawn cause (ENOMEM/ENOENT/fork-limit, in the
    // adapter's HostError) so an operator can see WHY a worker won't start —
    // the returned worker-unavailable (503) mapping is unchanged.
    ctx.logger.error("[worker-lifecycle] spawn failed — worker-unavailable (contained)", {
      tenant,
      error: formatHostError(spawnResult.error),
    });
    ctx.workers.delete(tenant);
    return err(workerUnavailable(tenant));
  }
  return spawnResult;
};

/**
 * Wait (bounded) for the worker's UDS to come up, then land the pure
 * spawning → live transition. Any failure aborts the spawn (kills the process).
 */
const markWorkerLive = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  handle: WorkerHandle,
  udsPath: string,
  eagerPin: boolean,
): Promise<Result<WorkerState, HostError>> => {
  const { logger, clock } = ctx;
  const probeRecord: WorkerRecord = {
    tenant,
    pid: handle.pid,
    udsPath,
    startedAt: clock(),
    health: "live",
    eagerPin,
  };
  const ready = await waitForUds(ctx, probeRecord);
  if (!ready) {
    logger.warn("[worker-lifecycle] worker UDS did not become ready in time — killing + worker-unavailable", { tenant, pid: handle.pid });
    // No live slot/registry record was ever taken for this incarnation.
    return abortSpawn(ctx, tenant, handle.pid, false);
  }

  // Pure transition spawning → live.
  const current = ctx.workers.get(tenant);
  if (current === undefined || current.phase !== "spawning") {
    // The entry was concurrently replaced (e.g. an evict) — fail closed for
    // this request rather than resurrect a stale spawn.
    logger.warn("[worker-lifecycle] spawning state vanished before workerLive — refusing", { tenant });
    return abortSpawn(ctx, tenant, handle.pid, false);
  }
  const liveResult = ctx.lifecycle.workerLive(current, handle.pid, udsPath, clock());
  if (!liveResult.ok) {
    logger.error("[worker-lifecycle] workerLive transition rejected (invariant)", { tenant });
    return abortSpawn(ctx, tenant, handle.pid, false);
  }
  ctx.workers.set(tenant, liveResult.value);
  return ok(liveResult.value);
};

/**
 * FAIL CLOSED: a live worker with no durable registry record is a permanent
 * split-brain — a supervisor restart could neither readopt nor evict it,
 * while it keeps holding the tenant's UDS and credentials. Since the record
 * is unwritable, the only state we can still guarantee is "no worker": tear
 * this incarnation down and surface worker-unavailable, so the next request
 * retries a clean spawn instead of routing to an unrecoverable orphan.
 */
const persistLiveOrAbort = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  pid: number,
  live: WorkerState,
): Promise<Result<void, HostError>> => {
  const persisted = await persistRecord(ctx, live);
  if (persisted.ok) return ok(undefined);
  ctx.logger.error(
    "[worker-lifecycle] registry put failed for a live worker — killing it rather than leaving an unreadoptable orphan",
    { tenant, pid, error: formatHostError(persisted.error) },
  );
  // A registry record may exist, so a failed kill is orphan-risk (error).
  return abortSpawn(ctx, tenant, pid, true);
};

/**
 * React to a spawned worker's exit, ONLY if the map entry is still THIS
 * incarnation (same pid), then branch on phase:
 *   - `live`     → an UNEXPECTED exit is a crash; drive `onCrash` (respawn, AD-8).
 *   - `draining` → the worker was SIGTERM'd by `drain` and has now stopped; that
 *     is the EXPECTED end of a graceful drain (multi-tenant spec FR-017), NOT a crash — drive the
 *     pure `drainComplete` transition (→ terminal `evicted`), free the slot and
 *     remove the record. It must NOT be misread as a crash and respawned.
 * The pid+phase guard is REQUIRED so a deliberate evict/idle-evict (which DELETES
 * the entry BEFORE its SIGKILL) is seen here as `undefined`/non-matching and so
 * triggers NEITHER path (no spurious restart).
 */
const handleSpawnedWorkerExit = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  pid: number,
  code: number | null,
): Promise<void> => {
  const cur = ctx.workers.get(tenant);
  if (cur === undefined) return;
  if (cur.phase === "draining" && cur.pid === pid) {
    // Graceful drain completed (multi-tenant spec FR-017): land the pure draining → evicted
    // transition, then drop the entry + record to release the slot. No respawn.
    const done = ctx.lifecycle.drainComplete(cur, ctx.clock());
    if (!done.ok) {
      ctx.logger.error("[worker-lifecycle] drainComplete rejected on draining exit (invariant)", { tenant });
    }
    ctx.workers.delete(tenant);
    await removeRecord(ctx, tenant);
    return;
  }
  if (cur.phase === "live" && cur.pid === pid) {
    await onCrash(ctx, tenant, code);
  }
};

/**
 * EXIT WATCHER (multi-tenant spec FR-014/FR-015/FR-017/AD-8): `handle.exited` is the ONLY exit
 * signal for a worker THIS process spawned. NOTE: `drain` (unlike evict) keeps
 * the entry as `draining` so the slot stays counted until the worker truly exits;
 * the drainComplete branch in `handleSpawnedWorkerExit` is what frees it.
 */
const watchWorkerExit = (ctx: LifecycleCtx, tenant: TenantId, handle: WorkerHandle): void => {
  ctx.watchedTenants.add(tenant); // this incarnation is watcher-covered (see set docs).
  void handle.exited.then((code) => handleSpawnedWorkerExit(ctx, tenant, handle.pid, code)).catch((error) => {
    // This is the terminal promise boundary for every watcher effect,
    // including graceful-drain registry removal. It must not throw even when
    // the logger is broken, or the catch itself would create an unhandled
    // rejection and lose the tenant attribution it exists to preserve.
    try {
      ctx.logger.error("[worker-lifecycle] exit watcher threw", {
        tenant,
        error: safeErrorMessage(error),
      });
    } catch {
      // No further diagnostic seam is available here.
    }
  });
};

/**
 * Lazy-spawn a tenant's worker to `live` (AD-7). Fail-closed + contained:
 * returns a `worker-unavailable(tenant)` HostError on any failure and leaves
 * the map either empty or with a terminal entry for THIS tenant only.
 */
const lazySpawn = async (ctx: LifecycleCtx, tenant: TenantId): Promise<Result<EnsuredWorker, HostError>> => {
  const admitted = admitSpawn(ctx, tenant);
  if (!admitted.ok) return admitted;
  const spawnCfg = admitted.value;

  // multi-tenant spec FR-004: the socket is a PURE function of the TenantId, derived here.
  const udsPath = workerSocketPath(ctx.config.udsDir, tenant);

  // CLAIM THE `spawning` SLOT NOW (multi-tenant spec FR-033) — synchronously, AFTER the admission
  // check above and BEFORE any `await`. `requestWorker` yields a `spawning` state
  // that `occupiesSlot` counts, so the check-then-reserve pair is atomic on Bun's
  // single thread. The single-flight only dedupes the SAME tenant; concurrent
  // FIRST requests for DISTINCT cold tenants each run their own `lazySpawn`, so if
  // the slot were claimed only AFTER the awaited ACL provisioning in `buildSpawnEnv`,
  // all of them would read the same pre-commit `liveWorkerCount()`, all pass the cap
  // and all overshoot it (`liveWorkerCount()` is the SOLE multi-tenant spec FR-033
  // enforcer). Reserving here closes that TOCTOU; every failure path below unwinds
  // this entry (`workers.delete`) so the slot is released fail-closed.
  ctx.workers.set(tenant, ctx.lifecycle.requestWorker(tenant, spawnCfg.eagerPin, ctx.clock()));

  const extraEnv = await buildSpawnEnv(ctx, tenant, spawnCfg);
  if (!extraEnv.ok) return extraEnv;

  const spawned = await spawnWorkerProcess(ctx, tenant, spawnCfg, udsPath, extraEnv.value);
  if (!spawned.ok) return spawned;
  const handle = spawned.value;

  const live = await markWorkerLive(ctx, tenant, handle, udsPath, spawnCfg.eagerPin);
  if (!live.ok) return live;
  const persisted = await persistLiveOrAbort(ctx, tenant, handle.pid, live.value);
  if (!persisted.ok) return persisted;

  watchWorkerExit(ctx, tenant, handle);
  return ok({ udsPath });
};

/**
 * SINGLE-FLIGHT spawn: coalesce concurrent spawn intents for the SAME tenant
 * onto one in-flight `lazySpawn` so the worker is started exactly once (no
 * double-spawn on the shared UDS — bind contention, double-charged slot, an
 * orphan). The single-flight lives at the SPAWN SEAM (not in one caller) so EVERY
 * spawn source shares it: a cold first request (`ensureWorker`) and a crash
 * auto-restart (`onCrash`) racing for the same tenant collapse to one spawn. The
 * synchronous read-then-set has no `await` between the lookup and the
 * `inFlightSpawns.set`, so on Bun's single thread it is atomic per tenant.
 */
const spawnSingleFlight = (ctx: LifecycleCtx, tenant: TenantId): Promise<Result<EnsuredWorker, HostError>> => {
  const pending = ctx.inFlightSpawns.get(tenant);
  if (pending !== undefined) return pending;
  const spawnPromise = lazySpawn(ctx, tenant).finally(() => {
    ctx.inFlightSpawns.delete(tenant);
  });
  ctx.inFlightSpawns.set(tenant, spawnPromise);
  return spawnPromise;
};

const ensureWorker = async (ctx: LifecycleCtx, tenant: TenantId): Promise<Result<EnsuredWorker, HostError>> => {
  const existing = ctx.workers.get(tenant);
  if (existing !== undefined && existing.phase === "live") {
    // Touch (refresh idle clock) and route to the existing socket.
    const touched = ctx.lifecycle.touch(existing, ctx.clock());
    if (touched.ok) ctx.workers.set(tenant, touched.value);
    return ok({ udsPath: existing.udsPath });
  }
  // No live worker → lazy spawn (a draining/crashed/evicted/spawning entry is
  // not routable; lazySpawn re-enters spawning for it), coalesced single-flight.
  return spawnSingleFlight(ctx, tenant);
};

// ── Crash handling ───────────────────────────────────────────────────────────

/**
 * CRASH-LOOP BUDGET (resilience): before auto-respawning, charge this tenant's
 * restart budget within a SLIDING window. If exhausted, GIVE UP the automatic
 * restart — a worker that boots-then-crashes-fast would otherwise hot-loop
 * onCrash→lazySpawn and pin a core. The tenant stays unavailable; the budget is
 * request-independent, so a future request can still lazy-spawn (rate-limited by
 * arrival), and the window resets once the tenant stops crashing for windowMs.
 */
const chargeRestartBudget = (ctx: LifecycleCtx, tenant: TenantId): "restart" | "give-up" => {
  const { config } = ctx;
  const now = ctx.clock();
  const budget = ctx.restartBudgets.get(tenant) ?? initialRestartBudget(config.maxRestartsPerWindow, config.restartWindowMs, now);
  const decision = decideSupervisorRestart(budget, now);
  ctx.restartBudgets.set(tenant, decision.budget);
  if (decision.action === "give-up") {
    ctx.logger.error("[worker-lifecycle] worker crash-loop budget exhausted — NOT auto-restarting (tenant unavailable until next request)", {
      tenant,
      restartsInWindow: decision.budget.restartsInWindow,
      windowMs: config.restartWindowMs,
    });
    return "give-up";
  }
  return "restart";
};

const onCrash = async (
  ctx: LifecycleCtx,
  tenant: TenantId,
  exitCode: number | null,
): Promise<Result<void, HostError>> => {
  const { logger } = ctx;
  const current = ctx.workers.get(tenant);
  if (current === undefined) {
    // Nothing to crash (already gone). Idempotent no-op success — contained.
    return ok(undefined);
  }
  // Pure crash transition (valid from live/draining). Contained to THIS tenant.
  const crashed = ctx.lifecycle.crash(current, exitCode, ctx.clock());
  if (!crashed.ok) {
    // Not in a crashable phase (spawning/crashed/evicted) — drop the entry so a
    // fresh request lazy-spawns. Still contained to this tenant.
    logger.warn("[worker-lifecycle] crash from non-crashable phase — dropping entry", { tenant, phase: current.phase });
    ctx.workers.delete(tenant);
    await removeRecord(ctx, tenant);
    return ok(undefined);
  }
  ctx.workers.set(tenant, crashed.value);
  await removeRecord(ctx, tenant);

  // Restart ONLY this tenant's worker (AD-8/multi-tenant spec FR-015): re-run the spawn
  // path. Sync runs fail-fast (the crash already surfaced as 503 to in-flight callers);
  // HITL durability is handled by existing checkpoint machinery (AD-8).
  if (chargeRestartBudget(ctx, tenant) === "give-up") {
    // Leave the entry deleted; no auto-respawn.
    ctx.workers.delete(tenant);
    return ok(undefined);
  }

  // RESTART-AT-CAP (multi-tenant spec FR-015): we DELETE the crashed entry before respawning
  // rather than pre-setting `spawning` via `restart(...)`. lazySpawn's admission
  // check counts `spawning` (occupiesSlot) against SUPERVISOR_MAX_LIVE_WORKERS,
  // so a pre-set `spawning` would make the crashing tenant count its OWN
  // restarting slot and get refused at the cap — exactly when containment
  // matters. By removing the record first, lazySpawn re-enters `spawning` via
  // `requestWorker` AFTER the admission check passes. The crashed tenant is
  // replacing itself, so its restart must not be blocked by the cap.
  ctx.workers.delete(tenant);
  // Respawn via the SAME single-flight as `ensureWorker`: a crash racing an inbound
  // request for this tenant collapses to ONE spawn (no double-spawn on the shared UDS).
  const respawn = await spawnSingleFlight(ctx, tenant);
  if (!respawn.ok) {
    logger.warn("[worker-lifecycle] restart respawn failed — tenant remains unavailable until next request", { tenant });
    // lazySpawn already cleaned up the entry; a subsequent request retries.
  }
  return ok(undefined);
};

// ── Drain / evict ────────────────────────────────────────────────────────────

const drain = async (ctx: LifecycleCtx, tenant: TenantId): Promise<Result<void, HostError>> => {
  const { logger } = ctx;
  const current = ctx.workers.get(tenant);
  if (current === undefined || current.phase !== "live") {
    // Nothing live to drain — idempotent no-op success.
    return ok(undefined);
  }
  // `current` was just confirmed `phase === "live"`, so `beginDrain` MUST yield a
  // `draining` state — its ok value hardcodes `phase: "draining"` (worker-lifecycle.ts),
  // so a non-`draining` ok is unrepresentable and the guard collapses to the
  // `!draining.ok` arm. A rejection here is a real ADT INVARIANT VIOLATION — NOT
  // the legitimate "nothing live to drain" no-op above — so it must surface loudly
  // rather than masquerade as success (mirrors the `workerLive` "transition
  // rejected (invariant)" logging).
  const draining = ctx.lifecycle.beginDrain(current, ctx.clock());
  if (!draining.ok) {
    logger.error("[worker-lifecycle] beginDrain rejected for a confirmed-live worker (invariant)", {
      tenant,
      error: draining.error.message,
    });
    // A confirmed-live worker that cannot begin draining is a real invariant
    // violation — surface it as a worker-unavailable rather than silent success.
    return err(workerUnavailable(tenant));
  }
  const next = draining.value;
  ctx.workers.set(tenant, next);
  // Best-effort by design, unlike the spawn path: the draining record is
  // TRANSITIONAL. The worker has already been SIGTERM'd, and its exit drives
  // `drainComplete` → `removeRecord`. A failed write leaves the prior `live`
  // record behind; a restart re-adopts it as live and the liveness probe
  // prunes it once the worker is gone. Killing the worker here to force
  // consistency would discard the in-flight work `drain` exists to preserve.
  const persistedDrain = await persistRecord(ctx, next);
  if (!persistedDrain.ok) {
    logger.warn(
      "[worker-lifecycle] registry put failed for a draining worker (continuing — the drain exit path removes the record)",
      { tenant, error: formatHostError(persistedDrain.error) },
    );
  }
  // Signal the worker to stop accepting new work (SIGTERM). In-flight work
  // finishes; the crash/exit path drives the terminal transition.
  await signalWorker(ctx, tenant, next.pid, "SIGTERM", false);
  return ok(undefined);
};

const evict = async (ctx: LifecycleCtx, tenant: TenantId): Promise<Result<void, HostError>> => {
  const current = ctx.workers.get(tenant);
  if (current === undefined) return ok(undefined);
  // Capture the pid (in the narrowed branch so the union widening never loses
  // the field) for the deliberate stop signals.
  let pid: number | undefined;
  if (current.phase === "live" || current.phase === "draining") pid = current.pid;
  await hardStopAndForget(ctx, tenant, pid);
  return ok(undefined);
};

// ── Re-adoption ──────────────────────────────────────────────────────────────

/**
 * Rebuild one tenant's pure state from a re-adopted registry record.
 *
 * C3 / AD-7: source eagerPin from the AUTHORITATIVE tenant registry config;
 * fall back to the persisted record value (belt-and-suspenders), NEVER default
 * to false.
 *
 * multi-tenant spec FR-017 fidelity: a record persisted as `draining` (it had been SIGTERM'd to
 * drain) that still answers its UDS MUST be re-adopted as `draining`, NOT
 * forced to `live`. `adoptLive` would set `canServe` true and `ensureWorker`
 * would route NEW traffic to a worker we deliberately drained. `adoptDraining`
 * keeps `canServe` false (no new routing) while still counting the slot
 * (`occupiesSlot`) and letting the liveness sweep finalise it via
 * `drainComplete` when it exits. `record.startedAt` is the drain-start instant
 * for a draining record (see `persistRecord`).
 */
const adoptRecord = (ctx: LifecycleCtx, record: WorkerRecord): WorkerState => {
  const spawnCfg = ctx.tenants.spawnConfigFor(record.tenant);
  const eagerPin = spawnCfg !== undefined ? spawnCfg.eagerPin : record.eagerPin;
  return record.health === "draining"
    ? ctx.lifecycle.adoptDraining(record.tenant, eagerPin, record.pid, record.udsPath, record.startedAt)
    : ctx.lifecycle.adoptLive(record.tenant, eagerPin, record.pid, record.udsPath, record.startedAt, ctx.clock());
};

const reconcileReadopt = async (
  ctx: LifecycleCtx,
): Promise<Result<{ readonly adopted: readonly TenantId[]; readonly pruned: readonly TenantId[] }, HostError>> => {
  const result = await ctx.registry.reconcileReadopt();
  if (!result.ok) return err(result.error);
  const adoptedTenants: TenantId[] = [];
  for (const { record } of result.value.adopted) {
    ctx.workers.set(record.tenant, adoptRecord(ctx, record));
    adoptedTenants.push(record.tenant);
  }
  // Prune dead in-memory entries the registry pruned (defensive — the map is
  // freshly empty on a supervisor restart, but a re-run must drop stale ones).
  for (const tenant of result.value.pruned) {
    const cur = ctx.workers.get(tenant);
    if (cur !== undefined && cur.phase !== "live" && cur.phase !== "draining") ctx.workers.delete(tenant);
  }
  return ok({ adopted: adoptedTenants, pruned: result.value.pruned });
};

// ── Sweeps ───────────────────────────────────────────────────────────────────

/**
 * Idle-evict sweep (AD-7): evict every idle-evictable live worker, RESPECTING
 * eager-pin (the pure `isIdleEvictable` query is false for pinned workers).
 * Exposed for the supervisor to call on a timer. Returns the evicted tenants.
 */
const idleEvictSweep = async (ctx: LifecycleCtx): Promise<readonly TenantId[]> => {
  const { lifecycle, config } = ctx;
  const now = ctx.clock();
  const candidates = [...ctx.workers]
    .filter(([, state]) => lifecycle.isIdleEvictable(state, config.idleEvictMs, now))
    .map(([tenant]) => tenant);
  const evicted: TenantId[] = [];
  for (const tenant of candidates) {
    const state = ctx.workers.get(tenant);
    if (state === undefined || state.phase !== "live") continue;
    // Re-confirm via the pure transition (it re-checks eager-pin + TTL); a
    // pinned worker returns err here and is skipped (AD-7).
    const result = lifecycle.idleEvict(state, config.idleEvictMs, ctx.clock());
    if (!result.ok) continue;
    await hardStopAndForget(ctx, tenant, state.pid);
    evicted.push(tenant);
  }
  return evicted;
};

/**
 * Probe a candidate pid. `undefined` means INCONCLUSIVE: a probe that throws must
 * NOT synthesize a crash off a failed liveness check (that could kill a healthy
 * worker) — the caller skips it and the next tick re-checks.
 */
const probeAlive = async (ctx: LifecycleCtx, tenant: TenantId, pid: number): Promise<boolean | undefined> => {
  try {
    return await ctx.proc.isAlive(pid);
  } catch (e) {
    ctx.logger.warn("[worker-lifecycle] liveness probe threw — skipping this tick", {
      tenant,
      pid,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
};

/**
 * Finalise one RE-ADOPTED worker the sweep found dead. Re-fetches the CURRENT
 * state to branch on phase AND guard against a concurrent transition/replacement:
 * only THIS dead incarnation is finalised. Returns whether it was handled.
 */
const finalizeDeadAdoptedWorker = async (ctx: LifecycleCtx, tenant: TenantId, pid: number): Promise<boolean> => {
  const { logger } = ctx;
  const cur = ctx.workers.get(tenant);
  if (cur === undefined || (cur.phase !== "live" && cur.phase !== "draining") || cur.pid !== pid) return false;
  if (cur.phase === "draining") {
    // A RE-ADOPTED draining worker (no exited watcher) has now exited — that
    // is the EXPECTED end of a graceful drain (multi-tenant spec FR-017), NOT a crash. Mirror
    // the spawned-worker exit watcher: land the pure `drainComplete` (→
    // terminal `evicted`), free the slot + record, and DO NOT restart it
    // (a worker SIGTERM'd to drain must not be resurrected).
    logger.info("[worker-lifecycle] re-adopted draining worker has exited — drain complete (no restart)", { tenant, pid });
    const done = ctx.lifecycle.drainComplete(cur, ctx.clock());
    if (!done.ok) {
      logger.error("[worker-lifecycle] drainComplete rejected on draining liveness-death (invariant)", { tenant });
    }
    ctx.workers.delete(tenant);
    await removeRecord(ctx, tenant);
    return true;
  }
  logger.warn("[worker-lifecycle] re-adopted worker is dead (no exited watcher) — driving crash/restart", { tenant, pid });
  // `null` exit code: a re-parented worker has no observable exit code.
  const r = await onCrash(ctx, tenant, null);
  if (!r.ok) {
    logger.error("[worker-lifecycle] onCrash for dead re-adopted worker failed", { tenant, error: formatHostError(r.error) });
  }
  return true;
};

const sweepAdoptedWorkers = async (ctx: LifecycleCtx): Promise<readonly TenantId[]> => {
  // Snapshot candidates first: only adopted (non-watched) live/draining workers.
  const candidates: Array<{ tenant: TenantId; pid: number }> = [];
  for (const [tenant, state] of ctx.workers) {
    if (ctx.watchedTenants.has(tenant)) continue;
    if (state.phase === "live" || state.phase === "draining") candidates.push({ tenant, pid: state.pid });
  }
  const dead: TenantId[] = [];
  for (const { tenant, pid } of candidates) {
    const alive = await probeAlive(ctx, tenant, pid);
    if (alive === undefined || alive) continue;
    if (await finalizeDeadAdoptedWorker(ctx, tenant, pid)) dead.push(tenant);
  }
  return dead;
};

/**
 * Liveness sweep (multi-tenant spec FR-014/FR-015, SC-006): the crash-detection SAFETY NET for
 * RE-ADOPTED workers. A worker spawned by THIS process carries a `handle.exited`
 * crash watcher (`watchedTenants`); a worker re-adopted across a supervisor
 * restart (`adoptLive`) does NOT — its process was re-parented, so we never own
 * its handle and have no `exited` promise to await. Without this sweep a
 * re-adopted worker that later crashes (OOM, AD-9) would go undetected: the entry
 * stays `live`, `ensureWorker` keeps routing to the dead socket, and the tenant
 * is wedged at 503 forever (an eager-pinned re-adopted worker is never
 * idle-evicted either, so it never recovers).
 *
 * For every `live`/`draining` worker NOT covered by an exited watcher, probe
 * `proc.isAlive(pid)`; a dead pid drives the normal `onCrash` path (contained
 * crash → budgeted auto-restart). Watched tenants are skipped so this never
 * double-fires `onCrash` against a crash the watcher already handles. Serialized
 * via `livenessSweepRunning` so overlapping ticks cannot both drive `onCrash`.
 * Exposed for the supervisor to drive on a timer (the binary owns the schedule).
 * Returns the tenants detected dead (and handed to `onCrash`) this sweep.
 */
const livenessSweep = async (ctx: LifecycleCtx): Promise<readonly TenantId[]> => {
  if (ctx.livenessSweepRunning) return [];
  ctx.livenessSweepRunning = true;
  try {
    return await sweepAdoptedWorkers(ctx);
  } finally {
    ctx.livenessSweepRunning = false;
  }
};

export const createWorkerLifecycle = (deps: WorkerLifecycleDeps): WorkerLifecyclePort => {
  const ctx: LifecycleCtx = {
    spawn: deps.spawn,
    proc: deps.proc,
    registry: deps.registry,
    probe: deps.probe,
    tenants: deps.tenants,
    clock: deps.clock,
    config: deps.config,
    logger: deps.logger,
    provisionRedisAcl: deps.provisionRedisAcl,
    lifecycle: deps.lifecycle ?? lifecycleAdt,
    workers: new Map(),
    inFlightSpawns: new Map(),
    watchedTenants: new Set(),
    restartBudgets: new Map(),
    livenessSweepRunning: false,
  };

  return {
    ensureWorker: (tenant) => ensureWorker(ctx, tenant),
    drain: (tenant) => drain(ctx, tenant),
    evict: (tenant) => evict(ctx, tenant),
    onCrash: (tenant, exitCode) => onCrash(ctx, tenant, exitCode),
    reconcileReadopt: () => reconcileReadopt(ctx),
    liveWorkerCount: () => liveWorkerCount(ctx),
    // `idleEvictSweep` / `livenessSweep` are part of the typed WorkerLifecyclePort
    // (spawn-port.ts) — the supervisor binary drives each on a timer. No cast needed.
    idleEvictSweep: () => idleEvictSweep(ctx),
    livenessSweep: () => livenessSweep(ctx),
  };
};
