/**
 * Worker lifecycle MANAGER — the imperative-shell ORCHESTRATOR that composes the
 * pure lifecycle ADT (`worker-lifecycle.ts`), the `SpawnPort` / `ProcManagePort`
 * (`bun-spawn-adapter.ts`), the Redis `WorkerRegistry` (`worker-registry-redis.ts`),
 * a UDS liveness probe, and the tenant registry into a single
 * `WorkerLifecyclePort` the supervisor injects (FR-014/015/019/020, SC-006).
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
 *     never touches another tenant's entry (FR-015, AD-8).
 *
 * SECURITY (FR-004 one-tenant-one-socket): the udsPath a worker binds is a PURE
 * function of its `TenantId` (`workerSocketPath(udsDir, tenant)`), derived HERE —
 * never taken from arbitrary input — so a worker can only ever own its own socket.
 *
 * SECURITY (FR-005 reference-only): the spawn forwards the tenant's `secretsRef`
 * REFERENCE only; this module never dereferences a secret.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { workerUnavailable, formatHostError } from "../../domain/host-error.js";
import type { HostError } from "../../domain/host-error.js";
import type { TenantId, SecretsRef } from "../../domain/tenant.js";
import type { LogPort } from "../../ports.js";
import { workerSocketPath } from "../../domain/config.js";
import {
  requestWorker,
  workerLive,
  adoptLive,
  adoptDraining,
  touch,
  idleEvict,
  isIdleEvictable,
  beginDrain,
  drainComplete,
  crash,
  occupiesSlot,
} from "./worker-lifecycle.js";
import type { WorkerState } from "./worker-lifecycle.js";
import { initialRestartBudget, decideSupervisorRestart } from "./thin-init.js";
import type { RestartBudget } from "./thin-init.js";
import type { AppliedAclCredential } from "../secrets/redis-acl-provisioner.js";
import { WORKER_REDIS_ACL_USERNAME_ENV, WORKER_REDIS_ACL_PASSWORD_ENV } from "../secrets/redis-acl.js";
import type { SpawnPort, ProcManagePort, WorkerLifecyclePort, EnsuredWorker } from "./spawn-port.js";
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

export interface WorkerLifecycleDeps {
  readonly spawn: SpawnPort;
  readonly proc: ProcManagePort;
  readonly registry: WorkerRegistry;
  /** UDS liveness probe — "is the worker bound to `udsPath` answering?". */
  readonly probe: UdsLivenessProbe;
  /** Authoritative tenant spawn config (secretsRef + eagerPin). */
  readonly tenants: TenantSpawnConfigView;
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

// ── Manager ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const createWorkerLifecycle = (deps: WorkerLifecycleDeps): WorkerLifecyclePort => {
  const { spawn, proc, registry, probe, tenants, clock, config, logger, provisionRedisAcl } = deps;

  // Per-tenant pure ADT state. The ONLY mutable state — every entry is an
  // immutable pure `WorkerState`; we replace (never mutate) entries.
  const workers = new Map<TenantId, WorkerState>();

  // In-flight cold-spawn coalescing (single-flight per tenant). `lazySpawn` sets
  // the `spawning` entry synchronously but then `await`s the spawn; two concurrent
  // first-requests for the same cold tenant would BOTH pass the no-live-worker
  // check and BOTH spawn a process onto the same `workerSocketPath` (UDS bind
  // contention, double-charged slot, an orphaned process). `ensureWorker` dedupes
  // concurrent callers onto ONE shared promise keyed by `TenantId`, cleared on
  // settle, so a cold tenant is spawned exactly once even under a request burst.
  const inFlightSpawns = new Map<TenantId, Promise<Result<EnsuredWorker, HostError>>>();

  // Tenants whose CURRENT incarnation was SPAWNED by this manager and therefore
  // carries a `handle.exited` crash watcher (attached in `lazySpawn`). Crash
  // detection for these tenants flows through that watcher.
  //
  // RE-ADOPTED workers (`reconcileReadopt` → `adoptLive`) are NOT in this set: the
  // worker was re-parented across a supervisor restart, so this process never owns
  // its `WorkerHandle` and has no `exited` promise to await. Their ONLY crash
  // signal is `livenessSweep` (poll `proc.isAlive`). The set is what lets the sweep
  // skip watched tenants so it never double-fires `onCrash` against a worker the
  // exited-watcher already covers. Membership is sticky: once a tenant is spawned
  // by this process, every later incarnation is also spawned (respawn re-enters
  // `lazySpawn`), so it stays watcher-covered for this process's lifetime.
  const watchedTenants = new Set<TenantId>();

  // Single-flight guard for `livenessSweep`: serialize sweeps so two overlapping
  // ticks cannot both detect the same dead adopted worker and drive `onCrash`
  // twice (the second `crash` from a `spawning`/`crashed` phase would drop the
  // respawning entry). One sweep at a time; a tick that overlaps a slow sweep is
  // skipped (liveness detection is not latency-critical).
  let livenessSweepRunning = false;

  // Per-tenant crash-loop budget (mirrors the supervisor-process budget in
  // thin-init). Tracks AUTOMATIC `onCrash` respawns within a SLIDING window; an
  // exhausted budget stops the auto-restart so a boots-then-crashes-fast worker
  // cannot pin a core. Window-based (NOT reset on `live`): a worker that reaches
  // `live` briefly each cycle still counts toward the budget — the window sliding
  // is the recovery path (a tenant healthy for > windowMs resets on its next crash).
  const restartBudgets = new Map<TenantId, RestartBudget>();

  /** Count of workers occupying a slot (spawning/live/draining) — T9 reads this. */
  const liveWorkerCount = (): number => {
    let n = 0;
    for (const s of workers.values()) if (occupiesSlot(s)) n++;
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
   *    while the supervisor believes the slot is reclaimed (corrupts the FR-033
   *    live-worker count). Logged at `error`.
   *  - `orphanRisk: false` → the slot is not yet considered reclaimed (e.g. SIGTERM
   *    during drain); logged at `warn`.
   */
  const signalWorker = async (
    tenant: TenantId,
    pid: number,
    sig: "SIGTERM" | "SIGKILL",
    orphanRisk: boolean,
  ): Promise<void> => {
    const r = await proc.signal(pid, sig);
    if (r.ok) return;
    const ctx = { tenant, pid, sig, error: formatHostError(r.error) };
    if (orphanRisk) {
      logger.error(
        "[worker-lifecycle] kill failed AFTER slot reclaim — worker may be orphaned (still bound to its UDS); live-worker count may be inaccurate",
        ctx,
      );
    } else {
      logger.warn("[worker-lifecycle] signal failed (best-effort)", ctx);
    }
  };

  /** Persist a record derived from a live/draining pure state (best-effort fail-closed). */
  const persistRecord = async (state: WorkerState): Promise<void> => {
    let record: WorkerRecord | undefined;
    if (state.phase === "live") {
      record = { tenant: state.tenant, pid: state.pid, udsPath: state.udsPath, startedAt: state.startedAt, health: "live", eagerPin: state.eagerPin };
    } else if (state.phase === "draining") {
      record = { tenant: state.tenant, pid: state.pid, udsPath: state.udsPath, startedAt: state.drainStartedAt, health: "draining", eagerPin: state.eagerPin };
    }
    if (record === undefined) return;
    const r = await registry.put(record);
    if (!r.ok) {
      logger.warn("[worker-lifecycle] registry put failed (continuing — routing uses in-memory state)", { tenant: state.tenant });
    }
  };

  /** Remove a tenant's registry record (best-effort). */
  const removeRecord = async (tenant: TenantId): Promise<void> => {
    const r = await registry.remove(tenant);
    if (!r.ok) logger.warn("[worker-lifecycle] registry remove failed (continuing)", { tenant });
  };

  /** Wait, bounded, for a worker's UDS to become reachable via the probe. */
  const waitForUds = async (record: WorkerRecord): Promise<boolean> => {
    const deadline = clock() + config.spawnReadyTimeoutMs;
    // Always probe at least once.
    for (;;) {
      let alive = false;
      try {
        alive = await probe(record);
      } catch (e) {
        logger.warn("[worker-lifecycle] UDS probe threw during spawn-wait — treating as not-ready", {
          tenant: record.tenant,
          error: e instanceof Error ? e.message : String(e),
        });
        alive = false;
      }
      if (alive) return true;
      if (clock() >= deadline) return false;
      await sleep(config.spawnReadyPollMs);
    }
  };

  /**
   * Lazy-spawn a tenant's worker to `live` (AD-7). Fail-closed + contained:
   * returns a `worker-unavailable(tenant)` HostError on any failure and leaves
   * the map either empty or with a terminal entry for THIS tenant only.
   */
  const lazySpawn = async (tenant: TenantId): Promise<Result<EnsuredWorker, HostError>> => {
    // Admission: refuse if at the live-worker ceiling (T9 count primitive).
    if (config.maxLiveWorkers !== undefined && liveWorkerCount() >= config.maxLiveWorkers) {
      logger.warn("[worker-lifecycle] at SUPERVISOR_MAX_LIVE_WORKERS — refusing new worker", { tenant, cap: config.maxLiveWorkers });
      return err(workerUnavailable(tenant));
    }

    const spawnCfg = tenants.spawnConfigFor(tenant);
    if (spawnCfg === undefined) {
      // No active config → cannot configure a worker. Fail closed.
      logger.warn("[worker-lifecycle] no spawn config for tenant — refusing", { tenant });
      return err(workerUnavailable(tenant));
    }

    // FR-004: the socket is a PURE function of the TenantId, derived here.
    const udsPath = workerSocketPath(config.udsDir, tenant);

    // CLAIM THE `spawning` SLOT NOW (FR-033) — synchronously, AFTER the admission
    // check above and BEFORE any `await`. `requestWorker` yields a `spawning` state
    // that `occupiesSlot` counts, so the check-then-reserve pair is atomic on Bun's
    // single thread. The single-flight only dedupes the SAME tenant; concurrent
    // FIRST requests for DISTINCT cold tenants each run their own `lazySpawn`, so if
    // the slot were claimed only AFTER the awaited ACL provisioning below, all of
    // them would read the same pre-commit `liveWorkerCount()`, all pass the cap and
    // all overshoot it (`liveWorkerCount()` is the SOLE FR-033 enforcer). Reserving
    // here closes that TOCTOU; every failure path below unwinds this entry
    // (`workers.delete`) so the slot is released fail-closed.
    workers.set(tenant, requestWorker(tenant, spawnCfg.eagerPin, clock()));

    // Per-tenant Redis ACL (ADR-0067): when provisioning is wired, mint a FRESH
    // scoped credential and inject it into the worker env so the worker connects
    // to Redis as its own `~fugue:<tenant>:*` user. The password is local to this
    // call (and the spawn env) — never retained or logged here. On a provisioning
    // failure we RELEASE the reserved slot and fail closed (no worker spawned).
    let extraEnv = spawnCfg.extraEnv;
    if (provisionRedisAcl !== undefined) {
      const cred = await provisionRedisAcl(tenant);
      if (!cred.ok) {
        logger.error("[worker-lifecycle] redis ACL provisioning failed — refusing spawn (fail-closed)", {
          tenant,
          error: formatHostError(cred.error),
        });
        workers.delete(tenant);
        return err(workerUnavailable(tenant));
      }
      extraEnv = {
        ...(extraEnv ?? {}),
        [WORKER_REDIS_ACL_USERNAME_ENV]: cred.value.username,
        [WORKER_REDIS_ACL_PASSWORD_ENV]: cred.value.password,
      };
    }

    // Per-tenant HITL queue-depth ceiling (ADR-0074): forward the registry's
    // `maxQueuedRuns` so the worker's HITL service gates `startRun`. Applied via
    // `extraEnv` (which `buildWorkerSpawn` merges over the inherited env), so a
    // stray inherited value can never override this tenant's configured ceiling.
    if (spawnCfg.maxQueuedRuns !== undefined) {
      extraEnv = { ...(extraEnv ?? {}), FUGUE_MAX_QUEUED_RUNS: String(spawnCfg.maxQueuedRuns) };
    }

    const spawnResult = await spawn.spawn({
      tenant,
      secretsRef: spawnCfg.secretsRef, // REFERENCE only (FR-005).
      workerEntry: config.workerEntry,
      udsPath,
      ...(config.heapCapMb !== undefined ? { heapCapMb: config.heapCapMb } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
    });
    if (!spawnResult.ok) {
      // Surface the UNDERLYING spawn cause (ENOMEM/ENOENT/fork-limit, in the
      // adapter's HostError) so an operator can see WHY a worker won't start —
      // the returned worker-unavailable (503) mapping is unchanged.
      logger.error("[worker-lifecycle] spawn failed — worker-unavailable (contained)", {
        tenant,
        error: formatHostError(spawnResult.error),
      });
      workers.delete(tenant);
      return err(workerUnavailable(tenant));
    }
    const handle = spawnResult.value;

    // Wait (bounded) for the worker's UDS to come up.
    const probeRecord: WorkerRecord = {
      tenant,
      pid: handle.pid,
      udsPath,
      startedAt: clock(),
      health: "live",
      eagerPin: spawnCfg.eagerPin,
    };
    const ready = await waitForUds(probeRecord);
    if (!ready) {
      logger.warn("[worker-lifecycle] worker UDS did not become ready in time — killing + worker-unavailable", { tenant, pid: handle.pid });
      workers.delete(tenant);
      // No live slot/registry record was ever taken for this incarnation, but a
      // failed kill still leaks the spawned process — surface it (warn).
      await signalWorker(tenant, handle.pid, "SIGKILL", false);
      return err(workerUnavailable(tenant));
    }

    // Pure transition spawning → live.
    const current = workers.get(tenant);
    if (current === undefined || current.phase !== "spawning") {
      // The entry was concurrently replaced (e.g. an evict) — fail closed for
      // this request rather than resurrect a stale spawn.
      logger.warn("[worker-lifecycle] spawning state vanished before workerLive — refusing", { tenant });
      await signalWorker(tenant, handle.pid, "SIGKILL", false);
      return err(workerUnavailable(tenant));
    }
    const liveResult = workerLive(current, handle.pid, udsPath, clock());
    if (!liveResult.ok) {
      logger.error("[worker-lifecycle] workerLive transition rejected (invariant)", { tenant });
      workers.delete(tenant);
      await signalWorker(tenant, handle.pid, "SIGKILL", false);
      return err(workerUnavailable(tenant));
    }
    workers.set(tenant, liveResult.value);
    await persistRecord(liveResult.value);

    // EXIT WATCHER (FR-014/FR-015/FR-017/AD-8): `handle.exited` is the ONLY exit
    // signal for a worker THIS process spawned. When it resolves, react ONLY if the
    // map entry is still THIS incarnation (same pid), then branch on phase:
    //   - `live`     → an UNEXPECTED exit is a crash; drive `onCrash` (respawn, AD-8).
    //   - `draining` → the worker was SIGTERM'd by `drain` and has now stopped; that
    //     is the EXPECTED end of a graceful drain (FR-017), NOT a crash — drive the
    //     pure `drainComplete` transition (→ terminal `evicted`), free the slot and
    //     remove the record. It must NOT be misread as a crash and respawned.
    // The pid+phase guard is REQUIRED so a deliberate evict/idle-evict (which DELETES
    // the entry BEFORE its SIGKILL) is seen here as `undefined`/non-matching and so
    // triggers NEITHER path (no spurious restart). NOTE: `drain` (unlike evict) keeps
    // the entry as `draining` so the slot stays counted until the worker truly exits;
    // the drainComplete branch here is what frees it.
    watchedTenants.add(tenant); // this incarnation is watcher-covered (see set docs).
    void handle.exited.then((code) => {
      const cur = workers.get(tenant);
      if (cur === undefined) return;
      if (cur.phase === "draining" && cur.pid === handle.pid) {
        // Graceful drain completed (FR-017): land the pure draining → evicted
        // transition, then drop the entry + record to release the slot. No respawn.
        const done = drainComplete(cur, clock());
        if (!done.ok) {
          logger.error("[worker-lifecycle] drainComplete rejected on draining exit (invariant)", { tenant });
        }
        workers.delete(tenant);
        void removeRecord(tenant);
        return;
      }
      if (cur.phase === "live" && cur.pid === handle.pid) {
        void onCrash(tenant, code).catch((e) =>
          logger.error("[worker-lifecycle] onCrash threw", { tenant, error: e instanceof Error ? e.message : String(e) }),
        );
      }
    });

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
  const spawnSingleFlight = (tenant: TenantId): Promise<Result<EnsuredWorker, HostError>> => {
    const pending = inFlightSpawns.get(tenant);
    if (pending !== undefined) return pending;
    const spawnPromise = lazySpawn(tenant).finally(() => {
      inFlightSpawns.delete(tenant);
    });
    inFlightSpawns.set(tenant, spawnPromise);
    return spawnPromise;
  };

  const ensureWorker = async (tenant: TenantId): Promise<Result<EnsuredWorker, HostError>> => {
    const existing = workers.get(tenant);
    if (existing !== undefined && existing.phase === "live") {
      // Touch (refresh idle clock) and route to the existing socket.
      const touched = touch(existing, clock());
      if (touched.ok) workers.set(tenant, touched.value);
      return ok({ udsPath: existing.udsPath });
    }
    // No live worker → lazy spawn (a draining/crashed/evicted/spawning entry is
    // not routable; lazySpawn re-enters spawning for it), coalesced single-flight.
    return spawnSingleFlight(tenant);
  };

  const onCrash = async (tenant: TenantId, exitCode: number | null): Promise<Result<void, HostError>> => {
    const current = workers.get(tenant);
    if (current === undefined) {
      // Nothing to crash (already gone). Idempotent no-op success — contained.
      return ok(undefined);
    }
    // Pure crash transition (valid from live/draining). Contained to THIS tenant.
    const crashed = crash(current, exitCode, clock());
    if (!crashed.ok) {
      // Not in a crashable phase (spawning/crashed/evicted) — drop the entry so a
      // fresh request lazy-spawns. Still contained to this tenant.
      logger.warn("[worker-lifecycle] crash from non-crashable phase — dropping entry", { tenant, phase: current.phase });
      workers.delete(tenant);
      await removeRecord(tenant);
      return ok(undefined);
    }
    workers.set(tenant, crashed.value);
    await removeRecord(tenant);

    // Restart ONLY this tenant's worker (AD-8/FR-015): re-run the spawn path.
    // Sync runs fail-fast (the crash already surfaced as 503 to in-flight
    // callers); HITL durability is handled by existing checkpoint machinery
    // (AD-8 — no new resume engine here).
    //
    // CRASH-LOOP BUDGET (resilience): before auto-respawning, charge this tenant's
    // restart budget within a SLIDING window. If exhausted, GIVE UP the automatic
    // restart — a worker that boots-then-crashes-fast would otherwise hot-loop
    // onCrash→lazySpawn and pin a core. The tenant stays unavailable; the budget is
    // request-independent, so a future request can still lazy-spawn (rate-limited by
    // arrival), and the window resets once the tenant stops crashing for windowMs.
    const now = clock();
    const budget = restartBudgets.get(tenant) ?? initialRestartBudget(config.maxRestartsPerWindow, config.restartWindowMs, now);
    const decision = decideSupervisorRestart(budget, now);
    restartBudgets.set(tenant, decision.budget);
    if (decision.action === "give-up") {
      logger.error("[worker-lifecycle] worker crash-loop budget exhausted — NOT auto-restarting (tenant unavailable until next request)", {
        tenant,
        restartsInWindow: decision.budget.restartsInWindow,
        windowMs: config.restartWindowMs,
      });
      // Leave the entry deleted (done below); no auto-respawn.
      workers.delete(tenant);
      return ok(undefined);
    }

    // RESTART-AT-CAP (FR-015): we DELETE the crashed entry before respawning
    // rather than pre-setting `spawning` via `restart(...)`. lazySpawn's admission
    // check counts `spawning` (occupiesSlot) against SUPERVISOR_MAX_LIVE_WORKERS,
    // so a pre-set `spawning` would make the crashing tenant count its OWN
    // restarting slot and get refused at the cap — exactly when containment
    // matters. By removing the record first, lazySpawn re-enters `spawning` via
    // `requestWorker` AFTER the admission check passes. The crashed tenant is
    // replacing itself, so its restart must not be blocked by the cap.
    workers.delete(tenant);
    // Respawn via the SAME single-flight as `ensureWorker` so a crash racing a
    // concurrent inbound request for this tenant collapses to ONE spawn (no
    // double-spawn on the shared UDS).
    const respawn = await spawnSingleFlight(tenant);
    if (!respawn.ok) {
      logger.warn("[worker-lifecycle] restart respawn failed — tenant remains unavailable until next request", { tenant });
      // lazySpawn already cleaned up the entry; a subsequent request retries.
    }
    return ok(undefined);
  };

  const drain = async (tenant: TenantId): Promise<Result<void, HostError>> => {
    const current = workers.get(tenant);
    if (current === undefined || current.phase !== "live") {
      // Nothing live to drain — idempotent no-op success.
      return ok(undefined);
    }
    // `current` was just confirmed `phase === "live"`, so `beginDrain` MUST yield a
    // `draining` state. A rejection (or unexpected phase) here is a real ADT
    // INVARIANT VIOLATION — NOT the legitimate "nothing live to drain" no-op above
    // — so it must surface loudly rather than masquerade as success (mirrors the
    // `workerLive` "transition rejected (invariant)" logging).
    const draining = beginDrain(current, clock());
    if (!draining.ok || draining.value.phase !== "draining") {
      logger.error("[worker-lifecycle] beginDrain rejected for a confirmed-live worker (invariant)", {
        tenant,
        ...(draining.ok ? { phase: draining.value.phase } : { error: draining.error.message }),
      });
      // A confirmed-live worker that cannot begin draining is a real invariant
      // violation — surface it as a worker-unavailable rather than silent success.
      return draining.ok ? ok(undefined) : err(workerUnavailable(tenant));
    }
    const next = draining.value;
    workers.set(tenant, next);
    await persistRecord(next);
    // Signal the worker to stop accepting new work (SIGTERM). In-flight work
    // finishes; the crash/exit path drives the terminal transition.
    await signalWorker(tenant, next.pid, "SIGTERM", false);
    return ok(undefined);
  };

  const evict = async (tenant: TenantId): Promise<Result<void, HostError>> => {
    const current = workers.get(tenant);
    if (current === undefined) return ok(undefined);
    // Capture the pid (in the narrowed branch so the union widening never loses
    // the field) for the deliberate stop signals.
    let pid: number | undefined;
    if (current.phase === "live" || current.phase === "draining") pid = current.pid;
    // CRITICAL: remove the entry BEFORE signalling. The crash-exit watcher's
    // guard keys on "is the map entry still THIS live/draining incarnation?";
    // deleting first guarantees a deliberate evict SIGKILL — which resolves the
    // worker's `handle.exited` — is NOT misread as a crash (no spurious restart).
    workers.delete(tenant);
    await removeRecord(tenant);
    if (pid !== undefined) {
      // Immediate revoke (FR-029 / NFR-012), NOT a graceful drain: SIGTERM and
      // SIGKILL fire back-to-back with NO intervening wait — `signalWorker` returns
      // once the signal is delivered, it does not await `exited` — so this is a HARD
      // kill. (Graceful "let in-flight work finish" is `drain()`'s job: SIGTERM only,
      // terminal cleanup deferred to `drainComplete` on actual exit.) SIGTERM is the
      // polite first signal; SIGKILL guarantees the slot is reclaimed if the worker
      // ignores it. Both are idempotent on a dead pid. The entry + registry record
      // were ALREADY removed above, so a failed SIGKILL leaves an orphan still bound
      // to the UDS while the slot reads as reclaimed — orphan-risk (error).
      await signalWorker(tenant, pid, "SIGTERM", false);
      await signalWorker(tenant, pid, "SIGKILL", true);
    }
    return ok(undefined);
  };

  const reconcileReadopt = async (): Promise<Result<{ readonly adopted: readonly TenantId[]; readonly pruned: readonly TenantId[] }, HostError>> => {
    const result = await registry.reconcileReadopt();
    if (!result.ok) return err(result.error);
    const adoptedTenants: TenantId[] = [];
    for (const { record } of result.value.adopted) {
      // C3 / AD-7: source eagerPin from the AUTHORITATIVE tenant registry config;
      // fall back to the persisted record value (belt-and-suspenders), NEVER
      // default to false.
      const spawnCfg = tenants.spawnConfigFor(record.tenant);
      const eagerPin = spawnCfg !== undefined ? spawnCfg.eagerPin : record.eagerPin;
      // FR-017 fidelity: a record persisted as `draining` (it had been SIGTERM'd to
      // drain) that still answers its UDS MUST be re-adopted as `draining`, NOT
      // forced to `live`. `adoptLive` would set `canServe` true and `ensureWorker`
      // would route NEW traffic to a worker we deliberately drained. `adoptDraining`
      // keeps `canServe` false (no new routing) while still counting the slot
      // (`occupiesSlot`) and letting the liveness sweep finalise it via
      // `drainComplete` when it exits. `record.startedAt` is the drain-start instant
      // for a draining record (see `persistRecord`).
      const state =
        record.health === "draining"
          ? adoptDraining(record.tenant, eagerPin, record.pid, record.udsPath, record.startedAt)
          : adoptLive(record.tenant, eagerPin, record.pid, record.udsPath, record.startedAt, clock());
      workers.set(record.tenant, state);
      adoptedTenants.push(record.tenant);
    }
    // Prune dead in-memory entries the registry pruned (defensive — the map is
    // freshly empty on a supervisor restart, but a re-run must drop stale ones).
    for (const tenant of result.value.pruned) {
      const cur = workers.get(tenant);
      if (cur !== undefined && cur.phase !== "live" && cur.phase !== "draining") workers.delete(tenant);
    }
    return ok({ adopted: adoptedTenants, pruned: result.value.pruned });
  };

  /**
   * Idle-evict sweep (AD-7): evict every idle-evictable live worker, RESPECTING
   * eager-pin (the pure `isIdleEvictable` query is false for pinned workers).
   * Exposed for the supervisor to call on a timer. Returns the evicted tenants.
   */
  const idleEvictSweep = async (): Promise<readonly TenantId[]> => {
    const now = clock();
    const candidates: TenantId[] = [];
    for (const [tenant, state] of workers) {
      if (isIdleEvictable(state, config.idleEvictMs, now)) candidates.push(tenant);
    }
    const evicted: TenantId[] = [];
    for (const tenant of candidates) {
      const state = workers.get(tenant);
      if (state === undefined || state.phase !== "live") continue;
      // Re-confirm via the pure transition (it re-checks eager-pin + TTL); a
      // pinned worker returns err here and is skipped (AD-7).
      const result = idleEvict(state, config.idleEvictMs, clock());
      if (!result.ok) continue;
      const pid = state.pid;
      // Remove the entry BEFORE signalling so the crash-exit watcher's guard sees
      // this is no longer the live incarnation — a deliberate idle-evict SIGTERM
      // that resolves `handle.exited` must not be misread as a crash (no respawn).
      workers.delete(tenant);
      await removeRecord(tenant);
      // Drain then force-stop (mirrors `evict`): SIGTERM lets an idle worker exit
      // cleanly, SIGKILL GUARANTEES the slot is reclaimed so the live-worker count
      // (FR-033) cannot under-count a worker that ignores SIGTERM. Entry + record
      // are already removed, so a failed SIGKILL leaves an orphan — orphan-risk.
      await signalWorker(tenant, pid, "SIGTERM", false);
      await signalWorker(tenant, pid, "SIGKILL", true);
      evicted.push(tenant);
    }
    return evicted;
  };

  /**
   * Liveness sweep (FR-014/FR-015, SC-006): the crash-detection SAFETY NET for
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
  const livenessSweep = async (): Promise<readonly TenantId[]> => {
    if (livenessSweepRunning) return [];
    livenessSweepRunning = true;
    try {
      // Snapshot candidates first: only adopted (non-watched) live/draining workers.
      const candidates: Array<{ tenant: TenantId; pid: number }> = [];
      for (const [tenant, state] of workers) {
        if (watchedTenants.has(tenant)) continue;
        if (state.phase === "live" || state.phase === "draining") candidates.push({ tenant, pid: state.pid });
      }
      const dead: TenantId[] = [];
      for (const { tenant, pid } of candidates) {
        let alive: boolean;
        try {
          alive = await proc.isAlive(pid);
        } catch (e) {
          // A probe that throws is inconclusive — do NOT synthesize a crash off a
          // failed liveness check (that could kill a healthy worker). Skip; the
          // next tick re-checks.
          logger.warn("[worker-lifecycle] liveness probe threw — skipping this tick", {
            tenant,
            pid,
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        if (alive) continue;
        // Re-fetch the CURRENT state to branch on phase AND guard against a
        // concurrent transition/replacement: only finalise THIS dead incarnation.
        const cur = workers.get(tenant);
        if (cur === undefined || (cur.phase !== "live" && cur.phase !== "draining") || cur.pid !== pid) continue;
        if (cur.phase === "draining") {
          // A RE-ADOPTED draining worker (no exited watcher) has now exited — that
          // is the EXPECTED end of a graceful drain (FR-017), NOT a crash. Mirror
          // the spawned-worker exit watcher: land the pure `drainComplete` (→
          // terminal `evicted`), free the slot + record, and DO NOT restart it
          // (a worker SIGTERM'd to drain must not be resurrected).
          logger.info("[worker-lifecycle] re-adopted draining worker has exited — drain complete (no restart)", { tenant, pid });
          const done = drainComplete(cur, clock());
          if (!done.ok) {
            logger.error("[worker-lifecycle] drainComplete rejected on draining liveness-death (invariant)", { tenant });
          }
          workers.delete(tenant);
          await removeRecord(tenant);
          dead.push(tenant);
          continue;
        }
        logger.warn("[worker-lifecycle] re-adopted worker is dead (no exited watcher) — driving crash/restart", { tenant, pid });
        // `null` exit code: a re-parented worker has no observable exit code.
        const r = await onCrash(tenant, null);
        if (!r.ok) {
          logger.error("[worker-lifecycle] onCrash for dead re-adopted worker failed", { tenant, error: formatHostError(r.error) });
        }
        dead.push(tenant);
      }
      return dead;
    } finally {
      livenessSweepRunning = false;
    }
  };

  return {
    ensureWorker,
    drain,
    evict,
    onCrash,
    reconcileReadopt,
    liveWorkerCount,
    // `idleEvictSweep` / `livenessSweep` are part of the typed WorkerLifecyclePort
    // (spawn-port.ts) — the supervisor binary drives each on a timer. No cast needed.
    idleEvictSweep,
    livenessSweep,
  };
};
