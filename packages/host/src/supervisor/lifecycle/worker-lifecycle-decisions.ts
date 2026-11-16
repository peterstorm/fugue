/**
 * Worker-lifecycle DECISIONS — the functional core of the lifecycle manager
 * (`worker-lifecycle-manager.ts`). Every function here is pure: plain data in,
 * plain data out, clock instants passed as values. The manager performs the I/O
 * (signal, registry write, spawn) these decisions describe.
 *
 *   - `decideCrashRestart` — the per-tenant crash-loop budget charge.
 *   - `workerRecordOf`     — the durable registry record a pure state persists as.
 *   - `decideAdoption`     — how a registry record found alive is re-adopted.
 *   - `stopPlan`           — which signals a stop sends, and how loudly a failed
 *                            one must be reported.
 */

import { match, P } from "ts-pattern";
import type { WorkerState } from "./worker-lifecycle.js";
import type { WorkerRecord } from "./worker-registry-redis.js";
import { initialRestartBudget, decideSupervisorRestart } from "./thin-init.js";
import type { RestartBudget } from "./thin-init.js";

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
 * stores its DRAIN-START instant as `startedAt` — `decideAdoption` reads it back
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
 * How a record found alive after a supervisor restart is re-adopted: the phase
 * it re-enters (always the record's own health — a worker persisted as draining
 * must never become routable again, multi-tenant spec FR-017), the eagerPin it
 * honours, and the record's `startedAt` read in that phase's meaning.
 */
export type Adoption =
  | { readonly phase: "live"; readonly eagerPin: boolean; readonly startedAt: number }
  | { readonly phase: "draining"; readonly eagerPin: boolean; readonly drainStartedAt: number };

/**
 * C3 / AD-7: `registryEagerPin` is the AUTHORITATIVE tenant-registry value
 * (`undefined` when the tenant has no active config); the persisted record's
 * value is only the fallback — never a default of false.
 */
export const decideAdoption = (record: WorkerRecord, registryEagerPin: boolean | undefined): Adoption => {
  const eagerPin = registryEagerPin ?? record.eagerPin;
  return match(record.health)
    .with("draining", (): Adoption => ({ phase: "draining", eagerPin, drainStartedAt: record.startedAt }))
    .with("live", (): Adoption => ({ phase: "live", eagerPin, startedAt: record.startedAt }))
    .exhaustive();
};

// ── Stop signals ─────────────────────────────────────────────────────────────

export type WorkerSignal = "SIGTERM" | "SIGKILL";

/**
 * How loudly a FAILED signal must be reported (a dead pid is not a failure — the
 * adapter reports it as success). `orphan-risk`: the slot already reads as
 * reclaimed, so a surviving process would still hold the tenant's UDS while the
 * live-worker count (multi-tenant spec FR-033) excludes it — an error.
 * `best-effort`: nothing reads as reclaimed yet, or a later signal still
 * follows — a warning.
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
 *   - `hard-stop`: evict / idle-evict — entry and record are already gone.
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
