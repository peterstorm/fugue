/**
 * Pure concurrency limiter — immutable state transitions for global + per-DAG limits.
 *
 * All functions are pure: no timers, no async, no side effects.
 * Clock is injected as `now: number` parameter for deterministic testing.
 *
 * FR-050: Host MUST enforce a global max concurrent execution limit (default: 50)
 * FR-051: Host MUST enforce a per-DAG max concurrent execution limit (default: 10, overridable)
 */

import type { DagId } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import { ok, err } from "@fugue/framework";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagConcurrency {
  readonly current: number;
  readonly max: number;
}

export interface ConcurrencyState {
  readonly global: { readonly current: number; readonly max: number };
  readonly perDag: ReadonlyMap<DagId, DagConcurrency>;
  readonly defaultDagMax: number;
}

export interface AcquireToken {
  readonly dagId: DagId;
  readonly acquiredAt: number;
}

export type ConcurrencyError = "global-at-capacity" | "dag-at-capacity";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Create initial concurrency state.
 * @param globalMax - Maximum concurrent executions across all DAGs (default: 50)
 * @param defaultDagMax - Default per-DAG max (default: 10, overridable per DAG)
 */
export const initConcurrency = (
  globalMax: number = 50,
  defaultDagMax: number = 10,
): ConcurrencyState => ({
  global: { current: 0, max: globalMax },
  perDag: new Map(),
  defaultDagMax,
});

/**
 * Register a DAG with a custom concurrency limit (overrides defaultDagMax).
 * Idempotent — if already registered, updates the max.
 */
export const withDagLimit = (
  state: ConcurrencyState,
  dagId: DagId,
  max: number,
): ConcurrencyState => {
  const existing = state.perDag.get(dagId);
  const newPerDag = new Map(state.perDag);
  newPerDag.set(dagId, { current: existing?.current ?? 0, max });
  return { ...state, perDag: newPerDag };
};

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire a concurrency slot for a given DAG.
 * Returns the new state + an opaque token on success, or an error if at capacity.
 */
export const acquire = (
  state: ConcurrencyState,
  dagId: DagId,
  now: number,
): Result<{ state: ConcurrencyState; token: AcquireToken }, ConcurrencyError> => {
  // Check global capacity
  if (state.global.current >= state.global.max) {
    return err("global-at-capacity");
  }

  // Get or initialize per-DAG state
  const dagState = state.perDag.get(dagId) ?? { current: 0, max: state.defaultDagMax };

  // Check per-DAG capacity
  if (dagState.current >= dagState.max) {
    return err("dag-at-capacity");
  }

  // Produce new state
  const newPerDag = new Map(state.perDag);
  newPerDag.set(dagId, { current: dagState.current + 1, max: dagState.max });

  const newState: ConcurrencyState = {
    ...state,
    global: { ...state.global, current: state.global.current + 1 },
    perDag: newPerDag,
  };

  const token: AcquireToken = { dagId, acquiredAt: now };

  return ok({ state: newState, token });
};

/**
 * Release a concurrency slot using a previously acquired token.
 * Always succeeds — returns new state with decremented counts.
 * If counts would go below zero (defensive), clamps to 0.
 */
export const release = (
  state: ConcurrencyState,
  token: AcquireToken,
): ConcurrencyState => {
  const dagState = state.perDag.get(token.dagId);

  const newGlobalCurrent = Math.max(0, state.global.current - 1);
  const newPerDag = new Map(state.perDag);

  if (dagState) {
    newPerDag.set(token.dagId, {
      current: Math.max(0, dagState.current - 1),
      max: dagState.max,
    });
  }

  return {
    ...state,
    global: { ...state.global, current: newGlobalCurrent },
    perDag: newPerDag,
  };
};

// ---------------------------------------------------------------------------
// Queries (pure)
// ---------------------------------------------------------------------------

/** Get the current global utilization as a fraction 0..1 */
export const globalUtilization = (state: ConcurrencyState): number =>
  state.global.max === 0 ? 1 : state.global.current / state.global.max;

/** Get the current per-DAG utilization as a fraction 0..1 */
export const dagUtilization = (state: ConcurrencyState, dagId: DagId): number => {
  const dagState = state.perDag.get(dagId);
  if (!dagState) return 0;
  return dagState.max === 0 ? 1 : dagState.current / dagState.max;
};

/** Check if a DAG has any available slots without mutating state */
export const hasCapacity = (state: ConcurrencyState, dagId: DagId): boolean => {
  if (state.global.current >= state.global.max) return false;
  const dagState = state.perDag.get(dagId) ?? { current: 0, max: state.defaultDagMax };
  return dagState.current < dagState.max;
};
