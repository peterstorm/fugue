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

import type { DagId } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-key concurrency counters.
 *
 * INVARIANT: `0 <= current`. `current <= max` holds in steady state but MAY be
 * transiently exceeded by a reconfigure that lowers `max` below the in-flight
 * `current` (see `reconcileDagLimits`/`withDagLimit`) — the over-capacity window
 * drains down as in-flight work completes. The invariant is upheld by the
 * transition functions (`acquire` gates new work, `release` clamps at 0), NOT by
 * a smart constructor — a constructor rejecting `current > max` would contradict
 * the documented, intentional transient over-capacity behaviour.
 */
export interface DagConcurrency {
  readonly current: number;
  readonly max: number;
}

/**
 * Pure concurrency-limiter state, generic over its per-key type `K`.
 *
 * `K` defaults to `DagId`, so every existing call site and test that referred to
 * the un-parameterised `ConcurrencyState` keeps compiling and behaving
 * identically. The generic axis lets other limiter axes (e.g. per-TENANT
 * admission in `supervisor/admission.ts`) instantiate the SAME ADT at a
 * different branded key (`ConcurrencyState<TenantId>`) with no brand-erasing
 * cast — the limiter is genuinely key-agnostic, and the type now says so.
 *
 * INVARIANT on `global`: `0 <= current`, with `current <= max` in steady state
 * (transiently exceedable by reconfigure; see `DagConcurrency`). Upheld by
 * `acquire`/`release`, not a constructor.
 */
export interface ConcurrencyState<K = DagId> {
  readonly global: { readonly current: number; readonly max: number };
  readonly perDag: ReadonlyMap<K, DagConcurrency>;
  readonly defaultDagMax: number;
}

/** @internal Unique symbol for type-level branding — prevents external forgery. */
declare const __acquireTokenBrand: unique symbol;

export interface AcquireToken<K = DagId> {
  readonly dagId: K;
  readonly acquiredAt: number;
  /** Type-level brand — only `acquire()` can produce a valid token. */
  readonly [__acquireTokenBrand]: void;
}

export type ConcurrencyError<K = DagId> =
  | { readonly kind: "global-at-capacity"; readonly current: number; readonly max: number }
  | { readonly kind: "dag-at-capacity"; readonly dagId: K; readonly current: number; readonly max: number };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Create initial concurrency state.
 * @param globalMax - Maximum concurrent executions across all DAGs (default: 50)
 * @param defaultDagMax - Default per-DAG max (default: 10, overridable per DAG)
 */
export const initConcurrency = <K = DagId>(
  globalMax: number = 50,
  defaultDagMax: number = 10,
): ConcurrencyState<K> => ({
  global: { current: 0, max: globalMax },
  perDag: new Map<K, DagConcurrency>(),
  defaultDagMax,
});

/**
 * Register a DAG with a custom concurrency limit (overrides defaultDagMax).
 * Idempotent — if already registered, updates the max.
 */
export const withDagLimit = <K = DagId>(
  state: ConcurrencyState<K>,
  dagId: K,
  max: number,
): ConcurrencyState<K> => {
  const existing = state.perDag.get(dagId);
  const newPerDag = new Map(state.perDag);
  newPerDag.set(dagId, { current: existing?.current ?? 0, max });
  return { ...state, perDag: newPerDag };
};

/**
 * Drop a per-key entry entirely (reclamation), but ONLY when it has no in-flight
 * work (`current === 0`). A LIVE entry is preserved unchanged so a pending
 * `release()` still finds its slot to decrement — the same in-flight-retention
 * invariant `reconcileDagLimits` upholds. Returns the SAME state when the key is
 * absent or still live, so this is a safe idempotent no-op off the steady path.
 *
 * Unlike `reconcileDagLimits` (which rebuilds `perDag` from a registry snapshot),
 * this targets ONE key — used when a key is permanently retired (e.g. a tenant's
 * final removal) and its admission counter should be reclaimed rather than leaked.
 */
export const forgetDagLimit = <K = DagId>(
  state: ConcurrencyState<K>,
  dagId: K,
): ConcurrencyState<K> => {
  const existing = state.perDag.get(dagId);
  if (existing === undefined || existing.current > 0) return state;
  const newPerDag = new Map(state.perDag);
  newPerDag.delete(dagId);
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
 * NOTE: if a sync LOWERS a DAG's max below its current in-flight count, the entry is
 * left as `{ current: N, max: newMax }` with `current > max` transiently. This is
 * intentional and safe: `acquire` gates all new work until `current` drains back under
 * `max`, and `release` clamps at 0 — no counter corruption, just a momentary over-capacity
 * window that resolves as in-flight requests complete.
 *
 * @satisfies FR-051 — per-DAG max concurrent limit enforced at runtime, overridable.
 */
export const reconcileDagLimits = <K = DagId>(
  state: ConcurrencyState<K>,
  limits: ReadonlyArray<{ readonly dagId: K; readonly max: number }>,
): ConcurrencyState<K> => {
  const newPerDag = new Map<K, DagConcurrency>();
  const provided = new Set<K>();
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
export const acquire = <K = DagId>(
  state: ConcurrencyState<K>,
  dagId: K,
  now: number,
): Result<{ state: ConcurrencyState<K>; token: AcquireToken<K> }, ConcurrencyError<K>> => {
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

  const newState: ConcurrencyState<K> = {
    ...state,
    global: { ...state.global, current: state.global.current + 1 },
    perDag: newPerDag,
  };

  // SOLE production mint seam for the branded token. The `as unknown as` is
  // required (not laziness): `AcquireToken` carries a `[__acquireTokenBrand]`
  // symbol property the literal cannot supply, so a single `as` will not compile.
  // `acquire()` is the only producer (see the brand contract below), which is what
  // makes the brand an unforgeable proof-of-acquisition outside this module.
  const token = { dagId, acquiredAt: now } as unknown as AcquireToken<K>;

  return ok({ state: newState, token });
};

/**
 * Release a concurrency slot using a previously acquired token.
 * Always succeeds — returns new state with decremented counts.
 * If counts would go below zero (defensive), clamps to 0.
 */
export const release = <K = DagId>(
  state: ConcurrencyState<K>,
  token: AcquireToken<K>,
): ConcurrencyState<K> => {
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
export const globalUtilization = <K = DagId>(state: ConcurrencyState<K>): number =>
  state.global.max === 0 ? 1 : state.global.current / state.global.max;

/** Get the current per-DAG utilization as a fraction 0..1 */
export const dagUtilization = <K = DagId>(state: ConcurrencyState<K>, dagId: K): number => {
  const dagState = state.perDag.get(dagId);
  if (!dagState) return 0;
  return dagState.max === 0 ? 1 : dagState.current / dagState.max;
};

/** Check if a DAG has any available slots without mutating state */
export const hasCapacity = <K = DagId>(state: ConcurrencyState<K>, dagId: K): boolean => {
  if (state.global.current >= state.global.max) return false;
  const dagState = state.perDag.get(dagId) ?? { current: 0, max: state.defaultDagMax };
  return dagState.current < dagState.max;
};

// NOTE: token forging for tests lives in src/__tests__/fixtures/concurrency-token.ts,
// NOT here. Keeping it out of the production module means no production call site can
// import a way to mint a branded AcquireToken without going through acquire().
