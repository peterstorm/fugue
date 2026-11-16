/**
 * Worker-lifecycle DECISIONS — the functional core of the lifecycle manager
 * (`worker-lifecycle-manager.ts`). Every function here is pure: plain data in,
 * plain data out, clock instants passed as values. The manager performs the I/O
 * (signal, registry write, spawn) these decisions describe.
 *
 *   - `spawnClearance`     — whether a tenant's current entry lets a new worker
 *                            be spawned for it.
 *   - `drainOverdue`       — whether a draining worker has outlived its drain.
 *   - `decideCrashRestart` — the per-tenant crash-loop budget charge.
 *   - `workerRecordOf`     — the durable registry record a pure state persists as.
 *   - `adoptedState`       — the pure state a registry record found alive is
 *                            re-adopted into.
 *   - `stopPlan`           — which signals a stop sends, and how loudly a failed
 *                            one must be reported.
 *   - `composeSpawnEnv`    — the per-tenant env overrides a spawn carries.
 */

import { match, P } from "ts-pattern";
import type { WorkerState, ProcessState } from "./worker-lifecycle.js";
import { adoptLive, adoptDraining, holdsProcess } from "./worker-lifecycle.js";
import type { WorkerRecord } from "./worker-registry-redis.js";
import { initialRestartBudget, decideSupervisorRestart } from "./thin-init.js";
import type { RestartBudget } from "./thin-init.js";
import { WORKER_REDIS_ACL_USERNAME_ENV, WORKER_REDIS_ACL_PASSWORD_ENV } from "../secrets/redis-acl.js";
import type { AppliedAclCredential } from "../secrets/redis-acl-provisioner.js";

// ── Spawn clearance ──────────────────────────────────────────────────────────

/** A process-holding phase: the worker still runs and still owns the tenant's socket. */
export type ProcessPhase = ProcessState["phase"];

export type SpawnClearance =
  | { readonly kind: "clear" }
  | { readonly kind: "blocked"; readonly by: ProcessPhase };

const CLEAR: SpawnClearance = { kind: "clear" };

/**
 * A tenant has exactly one socket (multi-tenant spec FR-004) and one table
 * entry, so a new worker may be spawned only when the current entry holds no
 * process. A `draining` worker keeps its socket bound until it exits: a
 * replacement could not bind it, and superseding the entry would drop the
 * draining process from the table — its slot uncounted (FR-033), its exit
 * unobserved. A `live` worker is routed to, never replaced. A `spawning` entry
 * is the in-flight spawn's own reservation, which the spawn single-flight
 * already serializes.
 */
export const spawnClearance = (current: WorkerState | undefined): SpawnClearance =>
  current !== undefined && holdsProcess(current) ? { kind: "blocked", by: current.phase } : CLEAR;

// ── Drain deadline ───────────────────────────────────────────────────────────

/**
 * A draining worker that has outlived `killAfterMs` since its drain began. The
 * worker bounds its own drain (`DRAIN_TIMEOUT_MS`) and exits; one still running
 * past the kill deadline ignored its SIGTERM, or never received it. While it
 * runs it blocks its tenant's replacement (`spawnClearance`), so the manager
 * hard-stops it rather than leave the tenant unavailable indefinitely.
 */
export const drainOverdue = (
  state: Extract<WorkerState, { readonly phase: "draining" }>,
  killAfterMs: number,
  now: number,
): boolean => now - state.drainStartedAt >= killAfterMs;

// ── Crash-restart budget ─────────────────────────────────────────────────────

/** The configured crash-loop budget a tenant gets on its first charged crash. */
export interface RestartPolicy {
  readonly maxRestartsPerWindow: number;
  readonly restartWindowMs: number;
}

/** Restart or give up, with the budget the tenant carries forward either way. */
export type CrashRestartDecision = ReturnType<typeof decideSupervisorRestart>;

/**
 * Charge one automatic crash-restart against a tenant's SLIDING-window budget.
 * A tenant with no prior budget opens a fresh window at `now` from `policy`;
 * once it has one, the carried budget alone governs. `give-up` returns the
 * budget unchanged, so an exhausted tenant stays exhausted until the window
 * slides — the recovery path, since the budget is never reset on `live`.
 */
export const decideCrashRestart = (
  prior: RestartBudget | undefined,
  policy: RestartPolicy,
  now: number,
): CrashRestartDecision =>
  decideSupervisorRestart(prior ?? initialRestartBudget(policy.maxRestartsPerWindow, policy.restartWindowMs, now), now);

// ── Durable record ───────────────────────────────────────────────────────────

/**
 * The registry record a pure state persists as, or `undefined` for a phase that
 * holds no process + socket (nothing durable to record). A draining record
 * stores its DRAIN-START instant as `startedAt` — `adoptedState` reads it back
 * as such.
 */
export const workerRecordOf = (state: WorkerState): WorkerRecord | undefined =>
  match(state)
    .with({ phase: "live" }, (s): WorkerRecord => ({
      tenant: s.tenant, pid: s.pid, udsPath: s.udsPath, startedAt: s.startedAt, health: "live", eagerPin: s.eagerPin,
    }))
    .with({ phase: "draining" }, (s): WorkerRecord => ({
      tenant: s.tenant, pid: s.pid, udsPath: s.udsPath, startedAt: s.drainStartedAt, health: "draining", eagerPin: s.eagerPin,
    }))
    .with({ phase: P.union("spawning", "crashed", "evicted") }, () => undefined)
    .exhaustive();

// ── Re-adoption ──────────────────────────────────────────────────────────────

/**
 * The pure state a record found alive after a supervisor restart is re-adopted
 * into. The phase is always the record's own health: a worker persisted as
 * draining must never become routable again (multi-tenant spec FR-017), so it
 * stays `draining` — `canServe` false, slot still counted. The record's
 * `startedAt` is read in that phase's meaning (spawn instant, or drain start).
 *
 * C3 / AD-7: `registryEagerPin` is the AUTHORITATIVE tenant-registry value
 * (`undefined` when the tenant has no active config); the persisted record's
 * value is only the fallback — never a default of false. `now` seeds a live
 * adoption's idle clock; a draining adoption ignores it.
 */
export const adoptedState = (record: WorkerRecord, registryEagerPin: boolean | undefined, now: number): WorkerState => {
  const { tenant, pid, udsPath, startedAt } = record;
  const eagerPin = registryEagerPin ?? record.eagerPin;
  return match(record.health)
    .with("draining", () => adoptDraining(tenant, eagerPin, pid, udsPath, startedAt))
    .with("live", () => adoptLive(tenant, eagerPin, pid, udsPath, startedAt, now))
    .exhaustive();
};

// ── Stop signals ─────────────────────────────────────────────────────────────

export type WorkerSignal = "SIGTERM" | "SIGKILL";

/**
 * How loudly a FAILED signal must be reported (a dead pid is not a failure — the
 * adapter reports it as success). Abort and hard-stop kills are sent after the
 * slot is released; the drain SIGTERM is sent while the draining entry still
 * holds its slot, so its failure leaves the process counted and is never an
 * orphan. Among released slots, what separates the two is whether a registry
 * record could exist for the process. `orphan-risk`: a record may have existed (an announced spawn,
 * an evicted worker), so a surviving process would still hold the tenant's UDS
 * while the live-worker count (multi-tenant spec FR-033) excludes it — an
 * error. `best-effort`: no registry record was ever written for the process, or
 * a later signal still follows — a warning.
 */
export type SignalFailureSeverity = "best-effort" | "orphan-risk";

export interface SignalStep {
  readonly sig: WorkerSignal;
  readonly onFailure: SignalFailureSeverity;
}

/**
 * Why a worker is being signalled.
 *   - `drain`: polite stop of a draining worker; its exit finishes the drain.
 *   - `abort-unannounced-spawn`: kill a spawn that never wrote a registry record.
 *   - `abort-announced-spawn`: kill a spawn whose registry record may exist.
 *   - `hard-stop`: evict, idle-evict, or an overdue drain (`stopOverdueDrains`,
 *     decided by `drainOverdue`) — entry and record are already gone.
 */
export type StopReason = "drain" | "abort-unannounced-spawn" | "abort-announced-spawn" | "hard-stop";

const POLITE: SignalStep = { sig: "SIGTERM", onFailure: "best-effort" };
const KILL_UNANNOUNCED: SignalStep = { sig: "SIGKILL", onFailure: "best-effort" };
const KILL_RECLAIMED: SignalStep = { sig: "SIGKILL", onFailure: "orphan-risk" };

/** The signals a stop sends, in order, each with its failure severity. */
export const stopPlan = (reason: StopReason): readonly SignalStep[] =>
  match(reason)
    .with("drain", () => [POLITE])
    .with("abort-unannounced-spawn", () => [KILL_UNANNOUNCED])
    .with("abort-announced-spawn", () => [KILL_RECLAIMED])
    .with("hard-stop", () => [POLITE, KILL_RECLAIMED])
    .exhaustive();

// ── Spawn env ────────────────────────────────────────────────────────────────

/**
 * The per-tenant spawn-config fields that become worker env (a `TenantSpawnConfig`
 * slice). `composeSpawnEnv` lays them over the inherited env, which
 * `buildWorkerSpawn` merges into every child, so they deterministically override
 * any pod-wide value the supervisor itself carries.
 */
export interface SpawnEnvSources {
  /**
   * The tenant's DAG root (`TenantConfigBase.dagsRoot`) → `DAGS_LOCAL_PATH`: the
   * worker roots its LocalGitAdapter here and discovers ONLY this team's DAGs —
   * the at-rest DAG-isolation boundary of a multi-tenant pod (ADR-0061). Sourced
   * from the active tenant registry (authoritative, like `eagerPin`); unset only
   * on paths that do not spawn from the registry.
   */
  readonly dagsRoot?: string;
  /**
   * Per-tenant ceiling on outstanding HITL runs (ADR-0074,
   * `admission.maxQueuedRuns`) → `FUGUE_MAX_QUEUED_RUNS`, which the worker's
   * `HitlRunService` enforces at `startRun`. Sourced from the active tenant
   * registry (authoritative, like `eagerPin`); unset only on the single-tenant
   * path.
   */
  readonly maxQueuedRuns?: number;
  /**
   * Genuinely PER-TENANT env overrides — the base every platform binding (DAG
   * root, HITL ceiling, Redis ACL credential) is laid over, so none can be
   * replaced. Platform-wide config (REDIS_URL, REALM_JWT_ISSUER, …) is not
   * carried here: workers inherit the supervisor's env automatically, and the
   * mandatory TENANT_ID / FUGUE_SECRETS_REF / WORKER_UDS_DIR bindings are applied
   * after it. Today no per-tenant override is sourced, so `spawnConfigFor`
   * leaves it unset.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** The env the worker reads its HITL queue-depth ceiling from. */
export const MAX_QUEUED_RUNS_ENV = "FUGUE_MAX_QUEUED_RUNS";
/** The env the worker roots its LocalGitAdapter at. */
export const DAGS_LOCAL_PATH_ENV = "DAGS_LOCAL_PATH";

/**
 * The worker's per-tenant spawn env overrides (merged by `buildWorkerSpawn` OVER
 * the inherited env, so a stray pod-wide value never overrides them).
 *
 * Precedence: the tenant's own `extraEnv` is the base; the freshly minted
 * per-tenant Redis ACL credential (ADR-0067), the HITL ceiling and the DAG root
 * are laid over it, so a per-tenant override can never replace a platform
 * binding. An absent source adds no key. `undefined` when no source applies
 * (the spawn then carries no `extraEnv` at all); with only an `extraEnv`, that
 * same record is returned.
 */
export const composeSpawnEnv = (
  sources: SpawnEnvSources,
  aclCredential: AppliedAclCredential | undefined,
): Readonly<Record<string, string>> | undefined => {
  const platform: Readonly<Record<string, string>> = {
    ...(aclCredential !== undefined
      ? {
          [WORKER_REDIS_ACL_USERNAME_ENV]: aclCredential.username,
          [WORKER_REDIS_ACL_PASSWORD_ENV]: aclCredential.password,
        }
      : {}),
    ...(sources.maxQueuedRuns !== undefined ? { [MAX_QUEUED_RUNS_ENV]: String(sources.maxQueuedRuns) } : {}),
    ...(sources.dagsRoot !== undefined ? { [DAGS_LOCAL_PATH_ENV]: sources.dagsRoot } : {}),
  };
  if (Object.keys(platform).length === 0) return sources.extraEnv;
  return { ...sources.extraEnv, ...platform };
};
