/**
 * The lifecycle manager's per-tenant table: the one owner of the manager's
 * mutable per-tenant state. Every entry is an immutable pure `WorkerState` that
 * is replaced, never mutated; the operations' names carry the invariants the
 * manager relies on, so no caller touches a raw collection.
 *
 * Three facts are kept per tenant:
 *   - the current worker state (the slot-counted entry);
 *   - whether this process attached an exit watcher to the tenant (sticky);
 *   - the tenant's crash-loop restart budget.
 */

import type { TenantId } from "../../domain/tenant.js";
import type { WorkerState, SpawningState } from "./worker-lifecycle.js";
import type { RestartBudget } from "./thin-init.js";
import { spawnClearance } from "./worker-lifecycle-decisions.js";
import type { SpawnClearance } from "./worker-lifecycle-decisions.js";

/**
 * Entries are keyed by the state's own `tenant`, so an entry filed under
 * another tenant's key is unrepresentable.
 */
export interface WorkerTable {
  readonly get: (tenant: TenantId) => WorkerState | undefined;
  /**
   * Claim the state's tenant slot with a `spawning` state (the type admits no
   * other phase). Call it SYNCHRONOUSLY after the admission check and BEFORE
   * any `await`: the claim is what makes check-then-reserve atomic on Bun's
   * single thread, so concurrent first requests for distinct cold tenants
   * cannot all pass the cap (multi-tenant spec FR-033).
   *
   * Refuses — claiming nothing — while the tenant's entry still holds a
   * process (`spawnClearance`): that worker owns the tenant's one socket, and
   * superseding it would drop a running process from the table. Only a
   * process-less entry is superseded.
   */
  readonly reserve: (spawning: SpawningState) => SpawnClearance;
  /** Land the next pure state for its tenant (a transition result, or an adoption). */
  readonly replace: (next: WorkerState) => void;
  /**
   * Forget the tenant's entry, freeing its slot. Teardown paths release BEFORE
   * signalling: an exit watcher keys on "is the entry still this incarnation?",
   * so a deliberate kill must not read as a crash.
   */
  readonly release: (tenant: TenantId) => void;
  /** Entries occupying a slot (spawning/live/draining) — the live-worker count. */
  readonly liveCount: () => number;
  /** A copy of every entry, safe to iterate across awaits that change the table. */
  readonly snapshot: () => ReadonlyArray<readonly [TenantId, WorkerState]>;
  /**
   * Record that this process attached an exit watcher to the tenant's current
   * incarnation. STICKY — there is no unmark: once this process spawns a tenant,
   * every later incarnation is also spawned here (a respawn re-enters the spawn
   * path), so it stays watcher-covered for the process's lifetime. A re-adopted
   * worker is never marked; the liveness sweep is its only crash signal.
   */
  readonly markWatched: (tenant: TenantId) => void;
  readonly isWatched: (tenant: TenantId) => boolean;
  /**
   * Charge one automatic restart: `decide` receives the tenant's prior budget
   * (`undefined` before its first charge) and the budget it returns is stored
   * for the next charge.
   */
  readonly chargeRestart: <D extends { readonly budget: RestartBudget }>(
    tenant: TenantId,
    decide: (prior: RestartBudget | undefined) => D,
  ) => D;
}

/** `occupiesSlot` is the ADT's slot predicate — the one definition of "counted". */
export const createWorkerTable = (occupiesSlot: (state: WorkerState) => boolean): WorkerTable => {
  const workers = new Map<TenantId, WorkerState>();
  const watched = new Set<TenantId>();
  const restartBudgets = new Map<TenantId, RestartBudget>();
  const put = (state: WorkerState): void => {
    workers.set(state.tenant, state);
  };
  return {
    get: (tenant) => workers.get(tenant),
    reserve: (spawning) => {
      const clearance = spawnClearance(workers.get(spawning.tenant));
      if (clearance.kind === "clear") put(spawning);
      return clearance;
    },
    replace: put,
    release: (tenant) => {
      workers.delete(tenant);
    },
    liveCount: () => [...workers.values()].filter(occupiesSlot).length,
    snapshot: () => [...workers],
    markWatched: (tenant) => {
      watched.add(tenant);
    },
    isWatched: (tenant) => watched.has(tenant),
    chargeRestart: (tenant, decide) => {
      const decision = decide(restartBudgets.get(tenant));
      restartBudgets.set(tenant, decision.budget);
      return decision;
    },
  };
};
