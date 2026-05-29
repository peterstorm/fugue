/**
 * Pure concurrency limiter — immutable state transitions for global + per-DAG limits.
 *
 * All functions are pure: no timers, no async, no side effects.
 * Clock is injected as `now: number` parameter for deterministic testing.
 *
 * PERFORMANCE NOTE: acquire/release create new Map instances per call.
 * At MAX_GLOBAL_CONCURRENCY=50, this means ≤50 Map copies/sec in steady state.
 * Measured: Map(10 entries) copy is ~0.5μs — negligible at current scale.
 * If scaling beyond 200+ concurrent, consider mutable-with-atomics approach.
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

/** @internal Unique symbol for type-level branding — prevents external forgery. */
declare const __acquireTokenBrand: unique symbol;

export interface AcquireToken {
  readonly dagId: DagId;
  readonly acquiredAt: number;
  /** Type-level brand — only `acquire()` can produce a valid token. */
  readonly [__acquireTokenBrand]: void;
}

export type ConcurrencyError =
  | { readonly kind: "global-at-capacity"; readonly current: number; readonly max: number }
  | { readonly kind: "dag-at-capacity"; readonly dagId: DagId; readonly current: number; readonly max: number };

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

/**
 * Reconcile per-DAG limits against a registry snapshot.
 *
 * Rebuilds `perDag` from `limits`, preserving in-flight `current` counts for DAGs that
 * survive the reconcile. DAGs absent from `limits` are dropped UNLESS they still have
 * in-flight requests (`current > 0`) — those entries are retained at their existing max
 * so a later `release()` still finds a per-DAG slot to decrement, keeping the global
 * counter and the sum of per-DAG counters consistent (no drift).
 *
 * Called at boot and on every successful git sync to fold the registry's per-DAG
 * `maxConcurrency` into the live limiter.
 *
 * @satisfies FR-051 — per-DAG max concurrent limit enforced at runtime, overridable.
 */
export const reconcileDagLimits = (
  state: ConcurrencyState,
  limits: ReadonlyArray<{ readonly dagId: DagId; readonly max: number }>,
): ConcurrencyState => {
  const newPerDag = new Map<DagId, DagConcurrency>();
  const provided = new Set<DagId>();
  for (const { dagId, max } of limits) {
    const existing = state.perDag.get(dagId);
    newPerDag.set(dagId, { current: existing?.current ?? 0, max });
    provided.add(dagId);
  }
  // Retain entries for de-registered DAGs that still have in-flight work, so their
  // eventual release() decrements the per-DAG counter rather than silently no-op'ing.
  for (const [id, dagState] of state.perDag) {
    if (!provided.has(id) && dagState.current > 0) {
      newPerDag.set(id, dagState);
    }
  }
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
    return err({ kind: "global-at-capacity", current: state.global.current, max: state.global.max });
  }

  // Get or initialize per-DAG state
  const dagState = state.perDag.get(dagId) ?? { current: 0, max: state.defaultDagMax };

  // Check per-DAG capacity
  if (dagState.current >= dagState.max) {
    return err({ kind: "dag-at-capacity", dagId, current: dagState.current, max: dagState.max });
  }

  // Produce new state
  const newPerDag = new Map(state.perDag);
  newPerDag.set(dagId, { current: dagState.current + 1, max: dagState.max });

  const newState: ConcurrencyState = {
    ...state,
    global: { ...state.global, current: state.global.current + 1 },
    perDag: newPerDag,
  };

  const token = { dagId, acquiredAt: now } as unknown as AcquireToken;

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

// NOTE: token forging for tests lives in src/__tests__/fixtures/concurrency-token.ts,
// NOT here. Keeping it out of the production module means no production call site can
// import a way to mint a branded AcquireToken without going through acquire().
