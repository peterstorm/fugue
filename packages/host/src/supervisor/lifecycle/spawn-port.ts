/**
 * Worker process ports — the boundary contracts between the PURE worker
 * lifecycle ADT (`worker-lifecycle.ts`) and the OS process world. Pure
 * interfaces only; the Bun.spawn implementation lives in `bun-spawn-adapter.ts`.
 *
 * Three seams:
 *   - `SpawnPort`        — spawn a worker process for a tenant → a handle (pid).
 *   - `ProcManagePort`   — signal / wait on an already-running process.
 *   - `WorkerLifecyclePort` — the HIGH-LEVEL seam the T7 supervisor injects and
 *                            codes against ("ensure tenant T has a live worker;
 *                            get its UDS path; drain/evict/restart; reconcile on
 *                            restart; how many workers are live").
 *
 * Spawn and signal failures return `Result<…, HostError>` — fail-closed, never
 * throw. `isAlive` is intentionally a best-effort boolean liveness probe.
 */

import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { TenantId, SecretsRef } from "../../domain/tenant.js";

// ── Spawn request / handle ────────────────────────────────────────────────────

/**
 * Everything needed to spawn one tenant's worker. The supervisor forwards the
 * tenant's secrets REFERENCE (never the secret itself — multi-tenant spec FR-005/FR-006): the
 * worker dereferences it inside its own process via the `SecretsSource` port.
 *
 * `heapCapMb` is the per-worker V8 heap ceiling (AD-9, `WORKER_HEAP_CAP_MB`).
 * When set, the adapter applies it as a `--max-old-space-size` flag so a single
 * tenant's runaway memory is contained to its own worker (OOM → contained crash).
 * Optional: unset means no explicit cap.
 */
export interface WorkerSpawnSpec {
  readonly tenant: TenantId;
  readonly secretsRef: SecretsRef;
  /** Absolute path to the worker entrypoint (worker-main.ts, T6). */
  readonly workerEntry: string;
  /** The UDS socket the worker will bind (`workerSocketPath(udsDir, tenant)`). */
  readonly udsPath: string;
  /** Per-worker V8 heap cap (MB), AD-9. Unset → no explicit cap. */
  readonly heapCapMb?: number;
  /**
   * Extra env to merge into the child's environment (the adapter always also sets
   * TENANT_ID, FUGUE_SECRETS_REF, WORKER_UDS_DIR from the spec). Lets the
   * supervisor forward platform config (Redis URL, issuer, …) without this port
   * knowing about it.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * A handle to a spawned worker process. `pid` is the OS process id (used by the
 * registry record + `ProcManagePort`). `exited` resolves when the process exits,
 * carrying the exit code (`null` for a signal-kill) — the supervisor awaits this
 * to drive the `crash` / `drainComplete` transitions.
 */
export interface WorkerHandle {
  readonly pid: number;
  /** Resolves with the exit code (or null for signal termination) when the process exits. */
  readonly exited: Promise<number | null>;
}

// ── SpawnPort ─────────────────────────────────────────────────────────────────

/**
 * Spawn a worker process. The ONLY seam that creates a child process. Returns a
 * `WorkerHandle` on success or a fail-closed `HostError` (e.g. spawn failed) —
 * never throws.
 */
export interface SpawnPort {
  readonly spawn: (spec: WorkerSpawnSpec) => Promise<Result<WorkerHandle, HostError>>;
}

// ── ProcManagePort ────────────────────────────────────────────────────────────

/**
 * Signal / wait on a running worker process. Used to drain (SIGTERM) and to
 * force-kill (SIGKILL) on drain timeout. `kill` is idempotent — signalling an
 * already-dead pid is a no-op success (an exited worker is the desired end state).
 */
export interface ProcManagePort {
  /** Send a signal to the process. Idempotent: a dead pid resolves ok. */
  readonly signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => Promise<Result<void, HostError>>;
  /** Whether the process is currently alive (best-effort liveness via signal 0). */
  readonly isAlive: (pid: number) => Promise<boolean>;
}

// ── WorkerLifecyclePort (SHARED CONTRACT with T7 supervisor) ────────────────────

/**
 * What `ensureWorker` hands back once a tenant's worker is live: the UDS path the
 * supervisor reverse-proxies the request to.
 */
export interface EnsuredWorker {
  readonly udsPath: string;
}

/**
 * The high-level lifecycle seam the T7 supervisor injects. The supervisor never
 * touches `SpawnPort` / `ProcManagePort` / the registry directly — it goes
 * through this port so all lifecycle policy (lazy spawn, idle-evict, drain,
 * crash-restart, re-adoption) is owned HERE.
 *
 * SHARED CONTRACT — keep this shape stable (T7 codes against it):
 *   - `ensureWorker(tenant)` — lazy spawn-on-first-request (AD-7, multi-tenant spec NFR-003):
 *     returns the live worker's UDS path, spawning + waiting for readiness if
 *     none is live. Fail-closed `worker-unavailable` if the worker cannot be
 *     brought up.
 *   - `drain(tenant)` / `evict(tenant)` — graceful drain then stop (multi-tenant spec FR-017).
 *   - `onCrash(tenant, exitCode)` — record a crash and (per AD-8/multi-tenant spec FR-015) restart
 *     ONLY this tenant's worker; other tenants are untouched.
 *   - `reconcileReadopt()` — on supervisor restart, re-adopt still-live workers
 *     from the registry + UDS probe and resume routing (multi-tenant spec SC-006, FR-019/FR-020).
 *   - `liveWorkerCount()` — the count primitive T9's admission bound reads.
 */
export interface WorkerLifecyclePort {
  /**
   * Ensure a live worker exists for `tenant` and return its UDS path. Lazy-spawns
   * on first request (AD-7). Fail-closed: `worker-unavailable(tenant)` if it
   * cannot be brought up (contained to this tenant only — AD-8).
   */
  readonly ensureWorker: (tenant: TenantId) => Promise<Result<EnsuredWorker, HostError>>;
  /** Begin graceful drain of a tenant's worker (live → draining → stop, multi-tenant spec FR-017). */
  readonly drain: (tenant: TenantId) => Promise<Result<void, HostError>>;
  /** Evict a tenant's worker (drain then stop / reclaim its slot, AD-7). */
  readonly evict: (tenant: TenantId) => Promise<Result<void, HostError>>;
  /**
   * Record that a tenant's worker crashed and restart ONLY that worker
   * (AD-8/multi-tenant spec FR-015). `exitCode` is `null` for a signal kill / OOM.
   */
  readonly onCrash: (tenant: TenantId, exitCode: number | null) => Promise<Result<void, HostError>>;
  /**
   * On supervisor restart: re-adopt still-live workers (registry + UDS probe) and
   * prune dead entries (multi-tenant spec SC-006, FR-019/FR-020). Returns the set of tenants whose
   * workers were adopted live.
   */
  readonly reconcileReadopt: () => Promise<Result<{ readonly adopted: readonly TenantId[]; readonly pruned: readonly TenantId[] }, HostError>>;
  /** Number of workers occupying a slot (spawning/live/draining) — T9 admission reads this. */
  readonly liveWorkerCount: () => number;
  /**
   * Idle-evict sweep (AD-7/multi-tenant spec FR-017): evict every idle-evictable live worker,
   * RESPECTING eager-pin. Driven by the supervisor binary on a timer (the binary
   * owns the interval; the policy lives here). Returns the evicted tenants.
   *
   * Part of the typed port (NOT a structural escape hatch) so the binary can wire
   * the sweep without an `as`-cast — a missing implementation is a type error.
   */
  readonly idleEvictSweep: () => Promise<readonly TenantId[]>;
  /**
   * Liveness sweep (multi-tenant spec FR-014/FR-015, SC-006): crash-detection SAFETY NET for
   * RE-ADOPTED workers. A worker spawned by this process carries a `handle.exited`
   * crash watcher; a worker re-adopted across a supervisor restart does NOT (its
   * process was re-parented — no handle to await). This sweep probes such workers'
   * liveness and drives `onCrash` for any that died, so a re-adopted worker's crash
   * is detected and restarted rather than wedging the tenant at 503. Driven by the
   * supervisor binary on a timer (the binary owns the interval). Returns the
   * tenants detected dead this sweep.
   */
  readonly livenessSweep: () => Promise<readonly TenantId[]>;
}

/**
 * Copy an inherited env into a clean `Record<string, string>`, dropping keys
 * whose value is `undefined`.
 *
 * ONE definition shared by both spawn adapters (`bun-spawn-adapter` for
 * workers, `bun-init-process-adapter` for the supervisor). `process.env` is
 * typed with optional values but `Bun.spawn` wants a total string record, and
 * the two adapters previously each open-coded this same narrowing loop.
 */
export const cleanEnvRecord = (
  source: Record<string, string | undefined>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};
