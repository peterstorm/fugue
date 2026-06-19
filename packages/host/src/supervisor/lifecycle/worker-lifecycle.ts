/**
 * WorkerState — PURE lifecycle ADT for a single tenant's worker process.
 *
 * Mirrors the style of `domain/host-state.ts`: a discriminated union with TOTAL,
 * IMMUTABLE, Result-returning transitions. No I/O, no clock — every transition
 * takes `now: number` so it is deterministic and trivially property-testable.
 * Illegal transitions return `err(invalidWorkerTransition(...))`, they never
 * throw and never silently no-op.
 *
 * The lifecycle (AD-7, AD-8, AD-9, FR-014..FR-021):
 *
 *   (none) --requestWorker--> spawning --workerLive--> live
 *
 *   live --idleEvict(now)--> evicted        (only when NOT eager-pinned, AD-7)
 *   live --beginDrain-------> draining --drainComplete--> evicted (AD-7/FR-017)
 *   live --crash------------> crashed
 *   draining --crash--------> crashed        (a draining worker can still die)
 *
 *   crashed --restart-------> spawning       (AD-8/FR-015: restart the crashed
 *                                             tenant's worker only)
 *
 * `evicted` and `crashed` are terminal-ISH: `evicted` is fully terminal for a
 * given worker incarnation (the supervisor re-spawns via a fresh `requestWorker`
 * on the next request — lazy spawn, AD-7); `crashed` is the only state from
 * which `restart` is legal, modelling the supervisor's automatic restart of a
 * crashed tenant's worker without touching other tenants.
 *
 * @satisfies FR-014 — spawn / crash-detect+restart / drain transitions modelled.
 * @satisfies FR-015 — crash→restart is per-worker; nothing here references other tenants.
 * @satisfies FR-017 — drain (live→draining→evicted) lets in-flight work finish first.
 * @satisfies AD-7   — lazy spawn (requestWorker→spawning→live); idle-evict honours eager-pin.
 * @satisfies AD-9   — OOM is just a `crash`; containment is structural (per-worker ADT).
 */

import { match } from "ts-pattern";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { TenantId } from "../../domain/tenant.js";

// ── Transition error ─────────────────────────────────────────────────────────

/**
 * Error returned when an invalid worker-state transition is attempted. Kept
 * local to this module (mirrors `host-state.ts`'s `TransitionError`); callers
 * widen to `HostError` at the boundary if they need to.
 */
export interface WorkerTransitionError {
  readonly kind: "invalid-worker-transition";
  readonly tenant: TenantId;
  readonly from: WorkerPhase | "none";
  readonly to: WorkerPhase;
  readonly message: string;
}

export type WorkerPhase = WorkerState["phase"];

const invalidWorkerTransition = (
  tenant: TenantId,
  from: WorkerPhase | "none",
  to: WorkerPhase,
): WorkerTransitionError => ({
  kind: "invalid-worker-transition",
  tenant,
  from,
  to,
  message: `Invalid worker transition for tenant "${tenant}": cannot move from "${from}" to "${to}"`,
});

// ── State ADT ──────────────────────────────────────────────────────────────

/**
 * A single tenant's worker lifecycle state.
 *
 * `tenant` and `eagerPin` ride on EVERY state so a transition never needs an
 * out-of-band lookup to decide legality (e.g. idle-evict consults `eagerPin`
 * from the state itself). `eagerPin` is the per-tenant "keep hot" flag (AD-7):
 * an eager-pinned worker is NEVER idle-evicted.
 *
 * `udsPath` appears only on states where a socket actually exists (`live`,
 * `draining`) — "this worker has no socket yet" (spawning/crashed/evicted) is
 * represented by the variant LACKING the field, not by an empty-string sentinel
 * (parse-don't-validate: illegal "live worker with no socket" is unrepresentable).
 */
export type WorkerState =
  | { readonly phase: "spawning"; readonly tenant: TenantId; readonly eagerPin: boolean; readonly requestedAt: number }
  | { readonly phase: "live"; readonly tenant: TenantId; readonly eagerPin: boolean; readonly pid: number; readonly udsPath: string; readonly startedAt: number; readonly lastActivityAt: number }
  | { readonly phase: "draining"; readonly tenant: TenantId; readonly eagerPin: boolean; readonly pid: number; readonly udsPath: string; readonly drainStartedAt: number }
  | { readonly phase: "crashed"; readonly tenant: TenantId; readonly eagerPin: boolean; readonly crashedAt: number; readonly exitCode: number | null }
  | { readonly phase: "evicted"; readonly tenant: TenantId; readonly eagerPin: boolean; readonly evictedAt: number };

// ── Constructors ───────────────────────────────────────────────────────────

/**
 * Lazy spawn (AD-7): the supervisor received the FIRST request for a tenant with
 * no live worker. Enters `spawning`. There is no "none" state object — absence of
 * a worker is the absence of an entry in the supervisor's per-tenant map, so this
 * is a constructor, not a transition from a prior state.
 */
export const requestWorker = (tenant: TenantId, eagerPin: boolean, now: number): WorkerState => ({
  phase: "spawning",
  tenant,
  eagerPin,
  requestedAt: now,
});

// ── Transitions (pure) ───────────────────────────────────────────────────────

/**
 * Spawn succeeded: the worker process is up and its UDS socket is bound.
 * Valid from: spawning.
 */
export const workerLive = (
  state: WorkerState,
  pid: number,
  udsPath: string,
  now: number,
): Result<WorkerState, WorkerTransitionError> => {
  if (state.phase !== "spawning") {
    return err(invalidWorkerTransition(state.tenant, state.phase, "live"));
  }
  return ok({
    phase: "live",
    tenant: state.tenant,
    eagerPin: state.eagerPin,
    pid,
    udsPath,
    startedAt: now,
    lastActivityAt: now,
  });
};

/**
 * Re-adoption (SC-006, FR-019/FR-020): a supervisor restart found this tenant's
 * worker still alive (registry entry + UDS liveness probe ok), so it is adopted
 * DIRECTLY into `live` without a spawn — the worker never stopped serving. This
 * is the constructor used by `reconcileReadopt`; modelled as a constructor (no
 * prior in-memory state survives the supervisor restart) rather than a transition.
 */
export const adoptLive = (
  tenant: TenantId,
  eagerPin: boolean,
  pid: number,
  udsPath: string,
  startedAt: number,
  now: number,
): WorkerState => ({
  phase: "live",
  tenant,
  eagerPin,
  pid,
  udsPath,
  startedAt,
  lastActivityAt: now,
});

/**
 * Record activity on a live worker — refreshes the idle clock. Pure: returns a
 * new state with `lastActivityAt` advanced. Valid from: live. (Used so idle-evict
 * measures from the LAST request, not from spawn.)
 */
export const touch = (
  state: WorkerState,
  now: number,
): Result<WorkerState, WorkerTransitionError> => {
  if (state.phase !== "live") {
    return err(invalidWorkerTransition(state.tenant, state.phase, "live"));
  }
  return ok({ ...state, lastActivityAt: now });
};

/**
 * Idle-evict (AD-7): a live worker with no activity for >= `idleTtlMs` is
 * evicted to reclaim memory. ENFORCES the eager-pin rule structurally — an
 * eager-pinned worker is NEVER idle-evicted (returns an invalid-transition error,
 * which the supervisor treats as "not eligible"). Also rejects if the worker has
 * not yet been idle for the full TTL.
 *
 * Valid from: live, AND only when `!eagerPin` AND `now - lastActivityAt >= idleTtlMs`.
 */
export const idleEvict = (
  state: WorkerState,
  idleTtlMs: number,
  now: number,
): Result<WorkerState, WorkerTransitionError> => {
  if (state.phase !== "live") {
    return err(invalidWorkerTransition(state.tenant, state.phase, "evicted"));
  }
  if (state.eagerPin) {
    return err(invalidWorkerTransition(state.tenant, "live", "evicted"));
  }
  if (now - state.lastActivityAt < idleTtlMs) {
    return err(invalidWorkerTransition(state.tenant, "live", "evicted"));
  }
  return ok({ phase: "evicted", tenant: state.tenant, eagerPin: state.eagerPin, evictedAt: now });
};

/**
 * Whether a live worker is eligible for idle eviction RIGHT NOW (pure query;
 * never mutates). Mirrors `idleEvict`'s gate so the supervisor can cheaply pick
 * eviction candidates without producing an error. Eager-pinned workers are never
 * eligible (AD-7).
 */
export const isIdleEvictable = (state: WorkerState, idleTtlMs: number, now: number): boolean =>
  state.phase === "live" && !state.eagerPin && now - state.lastActivityAt >= idleTtlMs;

/**
 * Begin graceful drain (AD-7, FR-017): stop routing NEW work to this worker, let
 * in-flight runs complete/checkpoint. Valid from: live. Reuses the drain SEMANTIC
 * of `host-state.ts`'s `beginDrain` (live → draining), scoped to one worker.
 */
export const beginDrain = (
  state: WorkerState,
  now: number,
): Result<WorkerState, WorkerTransitionError> => {
  if (state.phase !== "live") {
    return err(invalidWorkerTransition(state.tenant, state.phase, "draining"));
  }
  return ok({
    phase: "draining",
    tenant: state.tenant,
    eagerPin: state.eagerPin,
    pid: state.pid,
    udsPath: state.udsPath,
    drainStartedAt: now,
  });
};

/**
 * Drain complete (FR-017): all in-flight work finished/checkpointed; the worker
 * can be stopped. Lands in `evicted` (terminal for this incarnation). Valid from:
 * draining.
 */
export const drainComplete = (
  state: WorkerState,
  now: number,
): Result<WorkerState, WorkerTransitionError> => {
  if (state.phase !== "draining") {
    return err(invalidWorkerTransition(state.tenant, state.phase, "evicted"));
  }
  return ok({ phase: "evicted", tenant: state.tenant, eagerPin: state.eagerPin, evictedAt: now });
};

/**
 * Crash (AD-8/AD-9, FR-014/FR-015): the worker process exited unexpectedly (incl.
 * OOM). Contained to THIS tenant by construction — the state names only its own
 * tenant. Valid from: live OR draining (a draining worker can still die before it
 * finishes). `exitCode` is `null` for signal-kills (no numeric code).
 */
export const crash = (
  state: WorkerState,
  exitCode: number | null,
  now: number,
): Result<WorkerState, WorkerTransitionError> =>
  match<WorkerState, Result<WorkerState, WorkerTransitionError>>(state)
    .with({ phase: "live" }, (s) => ok({ phase: "crashed", tenant: s.tenant, eagerPin: s.eagerPin, crashedAt: now, exitCode }))
    .with({ phase: "draining" }, (s) => ok({ phase: "crashed", tenant: s.tenant, eagerPin: s.eagerPin, crashedAt: now, exitCode }))
    .with({ phase: "spawning" }, (s) => err(invalidWorkerTransition(s.tenant, s.phase, "crashed")))
    .with({ phase: "crashed" }, (s) => err(invalidWorkerTransition(s.tenant, s.phase, "crashed")))
    .with({ phase: "evicted" }, (s) => err(invalidWorkerTransition(s.tenant, s.phase, "crashed")))
    .exhaustive();

/**
 * Restart a crashed worker (AD-8, FR-015/FR-016): the supervisor automatically
 * re-spawns the crashed tenant's worker (and only that one). Returns to
 * `spawning`. Best-effort resume of the crashed tenant's in-flight run from its
 * last durable checkpoint is the WORKER's job on boot (existing processRun
 * idempotency + SET NX EX lock, FR-016) — this transition only re-enters the
 * spawn path. Valid from: crashed.
 */
export const restart = (
  state: WorkerState,
  now: number,
): Result<WorkerState, WorkerTransitionError> => {
  if (state.phase !== "crashed") {
    return err(invalidWorkerTransition(state.tenant, state.phase, "spawning"));
  }
  return ok({ phase: "spawning", tenant: state.tenant, eagerPin: state.eagerPin, requestedAt: now });
};

// ── Queries (pure) ─────────────────────────────────────────────────────────

/**
 * Is this worker in a state that can serve requests? Only `live` workers route
 * traffic. `draining` is intentionally FALSE for NEW work (drain stops new
 * routing, FR-017) — in-flight runs already on the worker keep going, but the
 * supervisor does not route NEW requests to a draining worker.
 */
export const canServe = (state: WorkerState): boolean => state.phase === "live";

/**
 * Counts as "live" for the supervisor's live-worker bound (SUPERVISOR_MAX_LIVE_WORKERS,
 * T9 admission). `live` and `draining` both still hold a process + socket, so both
 * count against the ceiling; `spawning` counts too (a slot is committed). `crashed`
 * and `evicted` hold no process and do not count.
 *
 * NOTE: this is the COUNT primitive T9's admission bound reads (SHARED CONTRACT);
 * admission policy itself is T9, not implemented here.
 */
export const occupiesSlot = (state: WorkerState): boolean =>
  state.phase === "spawning" || state.phase === "live" || state.phase === "draining";

/** The worker's UDS socket path, if it currently has one (live/draining only). */
export const udsPathOf = (state: WorkerState): string | undefined =>
  match(state)
    .with({ phase: "live" }, (s) => s.udsPath)
    .with({ phase: "draining" }, (s) => s.udsPath)
    .with({ phase: "spawning" }, () => undefined)
    .with({ phase: "crashed" }, () => undefined)
    .with({ phase: "evicted" }, () => undefined)
    .exhaustive();
