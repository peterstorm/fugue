/**
 * Per-tenant admission — a PURE extension of the `domain/concurrency.ts`
 * `ConcurrencyState` ADT with a per-tenant axis and a global live-worker upper
 * bound.
 *
 * This module does NOT fork the concurrency limiter: a `TenantConcurrencyState`
 * COMPOSES an inner `ConcurrencyState` (reused verbatim for the
 * global-execution + per-DAG limits) and layers two additional, independent
 * axes on top:
 *
 *   1. per-tenant concurrency ceiling — each tenant gets its OWN `{current,max}`
 *      slot count, so one tenant saturating its ceiling can NEVER consume
 *      another tenant's slots (FR-032, SC-011, US8). Rejection is the caller's
 *      OWN `tenant-over-quota` (429 + per-tenant Retry-After, FR-038).
 *   2. global live-worker upper bound — a hard cap on how many workers may be
 *      live at once across ALL tenants (FR-033). A tenant that has no live
 *      worker yet AND would push the box past the bound is refused with
 *      `worker-unavailable` (503, scoped to that tenant only — FR-039).
 *
 * PURITY: every function here is pure — no timers, no async, no `Date.now()`.
 * The clock is injected as `now: number`, mirroring `acquire`/`release` in
 * `domain/concurrency.ts`. State transitions return NEW immutable state; Maps
 * are copied, never mutated in place.
 *
 * AD-9: admission is pure supervisor state. The per-tenant MEMORY ceiling
 * (FR-034) is enforced elsewhere — via the per-worker heap flag at spawn
 * (T6/T8). Here we model only the admission/concurrency axis: how many
 * concurrent runs a tenant may have in flight, and the live-worker bound.
 *
 * @satisfies FR-032 — per-tenant resource admission replaces the single global limit.
 * @satisfies FR-033 — configurable upper bound on live workers, never exceeded.
 * @satisfies FR-038 — over-quota → 429 + Retry-After, scoped to the offending tenant.
 * @satisfies FR-039 — unhealthy/unavailable worker → 503, scoped to that tenant.
 * @satisfies SC-011 / US8 — anti-starvation: a heavy tenant cannot reject others.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { TenantId } from "../domain/tenant.js";
import type { HostError } from "../domain/host-error.js";
import {
  tenantOverQuota,
  workerUnavailable,
  internalInvariantViolated,
} from "../domain/host-error.js";
import {
  type ConcurrencyState,
  type AcquireToken,
  acquire as acquireInner,
  release as releaseInner,
  withDagLimit,
  initConcurrency,
} from "../domain/concurrency.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-tenant concurrency counters. Immutable.
 *
 * INVARIANT: `0 <= current`. `current <= max` holds in steady state but MAY be
 * transiently exceeded when `withTenantLimit` lowers a tenant's `max` below its
 * in-flight `current` — the over-capacity window drains down as in-flight runs
 * release. This invariant is upheld by the TRANSITION FUNCTIONS (`admitTenant`
 * gates new admits while `current >= max`; `releaseTenant` clamps `current` at
 * 0), NOT by a smart constructor — mirroring `DagConcurrency` in
 * `domain/concurrency.ts`, a constructor rejecting `current > max` would
 * contradict the intentional, documented drain-down behaviour.
 */
export interface TenantConcurrency {
  readonly current: number;
  readonly max: number;
}

/**
 * Global live-worker counters. The supervisor tracks how many workers are live
 * across ALL tenants; `max` is the configurable upper bound (FR-033). Admitting
 * a tenant that has no live worker yet must not push `current` past `max`.
 *
 * INVARIANT: `0 <= current <= max`. Unlike `TenantConcurrency`, `max` here is
 * not reconfigured below `current` by any transition in this module, so the
 * upper bound holds at every step. The bound is upheld by `admitTenant` (refuses
 * a new-worker admit at the bound) and `releaseTenant` (clamps at 0), NOT by a
 * constructor.
 *
 * NOTE (wired supervisor): the supervisor configures this axis NON-BINDING (max
 * set well above any reachable live-worker count) so the worker-lifecycle manager's
 * `liveWorkerCount()` is the SOLE authoritative FR-033 enforcement point. The two
 * are therefore NOT competing counters — admission's `LiveWorkers` is a pure-state
 * mirror, and the lifecycle manager is where the live-worker cap actually binds.
 */
export interface LiveWorkers {
  readonly current: number;
  readonly max: number;
}

/**
 * Tenant-aware concurrency state. COMPOSES (does not fork) the existing
 * `ConcurrencyState` for the global-execution + per-DAG axes, and adds:
 *   - `perTenant`         — per-tenant concurrency ceilings (FR-032).
 *   - `defaultTenantMax`  — ceiling applied to a tenant with no explicit limit.
 *   - `liveWorkers`       — the global live-worker bound (FR-033).
 *
 * Spec shape (plan): `ConcurrencyState & { perTenant; liveWorkers }`. We model
 * the "& ConcurrencyState" by EMBEDDING it as `inner` rather than spreading, so
 * the inner ADT's invariants stay owned by `domain/concurrency.ts` and cannot
 * drift here.
 */
export interface TenantConcurrencyState {
  readonly inner: ConcurrencyState<TenantId>;
  readonly perTenant: ReadonlyMap<TenantId, TenantConcurrency>;
  readonly defaultTenantMax: number;
  readonly liveWorkers: LiveWorkers;
  /**
   * Retry-After (seconds) advertised when a tenant is over its OWN ceiling
   * (FR-038). Carried on state (config), surfaced on the `tenant-over-quota`
   * error so the HTTP layer reads it from the error, never a hardcoded header.
   */
  readonly retryAfterSeconds: number;
}

/** @internal Unique symbol for type-level branding — prevents external forgery. */
declare const __admitTokenBrand: unique symbol;

/**
 * Opaque proof that a tenant slot (and, when newly minted, a live-worker slot)
 * was acquired through `admitTenant`. Wraps the inner `AcquireToken` so a single
 * release reverses BOTH the inner concurrency slot and the tenant/live-worker
 * counters atomically. Branded so only `admitTenant` can produce one — mirrors
 * the `AcquireToken` discipline (no minting in this production module; the
 * test-only forger lives under `__tests__`).
 */
export interface AdmitToken {
  readonly tenant: TenantId;
  readonly innerToken: AcquireToken<TenantId>;
  /**
   * Whether THIS admission caused a live-worker slot to be claimed (the tenant
   * had no live worker before this admission). On release, only tokens that
   * claimed a worker decrement `liveWorkers.current`, so the count tracks
   * distinct live tenants, not in-flight runs.
   */
  readonly claimedWorker: boolean;
  /**
   * The injected clock value (`now`) at admission. Reserved for future staleness
   * diagnostics (e.g. detecting tokens held open far longer than a run should
   * take); no current reader. Retained for parity with `AcquireToken.acquiredAt`.
   * Stamped from the injected clock, never `Date.now()`.
   */
  readonly admittedAt: number;
  readonly [__admitTokenBrand]: void;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface AdmissionConfig {
  /** Default per-tenant concurrency ceiling (FR-032). */
  readonly defaultTenantMax?: number;
  /** Upper bound on live workers across all tenants (FR-033). */
  readonly maxLiveWorkers?: number;
  /** Retry-After (seconds) advertised on `tenant-over-quota` (FR-038). */
  readonly retryAfterSeconds?: number;
}

/**
 * The inner limiter is instantiated at `ConcurrencyState<TenantId>`, so the
 * per-tenant key IS the tenant id directly — no brand-erasing cast. The inner
 * ADT is genuinely key-agnostic (it was made generic over its key type with a
 * `= DagId` default), so admission composes it at `K = TenantId` and the type
 * system carries the tenant brand all the way through. Each tenant's inner
 * per-key limit is set to that tenant's OWN ceiling via `withDagLimit`, so the
 * inner per-key counter and our `perTenant` counter move in lockstep.
 *
 * The inner GLOBAL limit, by contrast, MUST NOT be the cross-tenant bottleneck:
 * FR-032 REPLACES the single global concurrency limit with per-tenant quotas,
 * and SC-011 requires that one tenant saturating the box never rejects another.
 * If the inner global limit could bind first, a heavy tenant filling it would
 * starve others — exactly the failure SC-011 forbids. So the inner global is
 * sized so it can NEVER bind before the per-tenant ceilings and the live-worker
 * bound do: the box-wide hard cap is `liveWorkers.max` (FR-033), not a shared
 * inner execution counter. `INNER_GLOBAL_HEADROOM` makes the inner global a
 * non-binding safety net rather than a starvation vector.
 */

/**
 * Sizes the inner global limit as a large multiple of the live-worker bound so
 * it never binds before per-tenant ceilings / the live-worker cap. The true
 * box-wide cap is the live-worker bound (FR-033); this is just a non-binding
 * upper safety net inherited from the inner ADT.
 *
 * PRECONDITION: the "inner global never binds" guarantee (and the unreachable-branch
 * 500 in `admitTenant` step 3 that rests on it) holds PROVIDED the sum of per-tenant
 * ceilings stays well under `INNER_GLOBAL_HEADROOM`; revisit if ceilings are ever
 * configured into the hundreds of thousands.
 */
const INNER_GLOBAL_HEADROOM = 1_000_000;

/**
 * Create initial tenant-aware concurrency state. The per-tenant ceilings
 * (FR-032) and the live-worker bound (FR-033) are the binding admission axes;
 * the inner `ConcurrencyState`'s global limit is deliberately sized so it never
 * binds first (see `INNER_GLOBAL_HEADROOM`), because FR-032 REPLACES the single
 * global concurrency limit with per-tenant quotas.
 *
 * @param config.maxLiveWorkers the hard ceiling of FR-033 (default 50).
 * @param config.defaultTenantMax the per-tenant ceiling for unconfigured tenants.
 */
export const initTenantConcurrency = (
  config: AdmissionConfig = {},
): TenantConcurrencyState => {
  const defaultTenantMax = config.defaultTenantMax ?? 10;
  return {
    inner: initConcurrency<TenantId>(INNER_GLOBAL_HEADROOM, defaultTenantMax),
    perTenant: new Map(),
    defaultTenantMax,
    liveWorkers: { current: 0, max: config.maxLiveWorkers ?? 50 },
    retryAfterSeconds: config.retryAfterSeconds ?? 5,
  };
};

/**
 * Register (or update) a tenant's explicit concurrency ceiling, overriding
 * `defaultTenantMax`. Idempotent — preserves the in-flight `current` count.
 * Also folds the ceiling into the inner ADT's per-key limit so the inner and
 * outer counters stay consistent.
 */
export const withTenantLimit = (
  state: TenantConcurrencyState,
  tenant: TenantId,
  max: number,
): TenantConcurrencyState => {
  const existing = state.perTenant.get(tenant);
  const perTenant = new Map(state.perTenant);
  perTenant.set(tenant, { current: existing?.current ?? 0, max });
  return { ...state, perTenant, inner: withDagLimit(state.inner, tenant, max) };
};

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Admit a tenant for a NEW run (FR-032/033/038/039). The gate, in order:
 *
 *   1. PER-TENANT CEILING — if THIS tenant is at its own ceiling, refuse with
 *      `tenant-over-quota` (429 + per-tenant Retry-After). This check is scoped
 *      entirely to the caller's own counters, so it can never be triggered by
 *      another tenant's load (FR-032, SC-011).
 *   2. LIVE-WORKER BOUND — if admitting would require a NEW live worker (the
 *      tenant has no in-flight runs yet, so `current === 0`) and the box is
 *      already at the live-worker bound, refuse with `worker-unavailable`
 *      (503, this tenant only — FR-033/FR-039). A tenant that ALREADY has a
 *      live worker (current > 0) does NOT consume a new worker slot, so it is
 *      never blocked by the live-worker bound.
 *   3. INNER CONCURRENCY — defer to the existing `acquire` for the global +
 *      per-DAG limits, using the tenant id as the inner key. An inner rejection
 *      (global-at-capacity / dag-at-capacity) is mapped to the tenant's own
 *      `tenant-over-quota` so the box-wide global limit also surfaces as a
 *      retriable, tenant-scoped 429 rather than leaking a global signal.
 *
 * Returns the new state + an `AdmitToken` on success, or a `HostError`.
 *
 * @param now injected clock — stamped onto the token; no `Date.now()` here.
 */
export const admitTenant = (
  state: TenantConcurrencyState,
  tenant: TenantId,
  now: number,
): Result<{ state: TenantConcurrencyState; token: AdmitToken }, HostError> => {
  const tenantState =
    state.perTenant.get(tenant) ?? { current: 0, max: state.defaultTenantMax };

  // 1. Per-tenant ceiling (FR-032 / FR-038). Scoped to the caller only.
  if (tenantState.current >= tenantState.max) {
    return err(tenantOverQuota(tenant, state.retryAfterSeconds));
  }

  // 2. Live-worker bound (FR-033 / FR-039). Only a tenant with no in-flight
  //    run yet needs a NEW worker slot; one already-live tenant never blocks.
  const needsWorker = tenantState.current === 0;
  if (needsWorker && state.liveWorkers.current >= state.liveWorkers.max) {
    return err(workerUnavailable(tenant));
  }

  // 3. Inner per-tenant slot accounting, reusing the existing pure ADT verbatim.
  //    The tenant id is the inner key; its inner per-key max equals the tenant
  //    ceiling (default or explicit via `withTenantLimit`), so the inner per-key
  //    counter and our `perTenant` counter move in lockstep. The inner GLOBAL
  //    limit is sized never to bind first (see `INNER_GLOBAL_HEADROOM`), so an
  //    inner rejection here can only be the per-tenant ceiling — already caught
  //    in step 1. This branch is therefore UNREACHABLE: the per-key inner ceiling
  //    equals the tenant ceiling already checked in step 1, and the inner global
  //    is sized never to bind (INNER_GLOBAL_HEADROOM). Rather than silently
  //    mislabel an unexpected inner rejection as the tenant's quota error
  //    (discarding the discriminating `ConcurrencyError`), make the impossibility
  //    explicit: a 500 internal-invariant-violated carrying the inner error in
  //    `context`. A genuine per-tenant-ceiling rejection is the `tenant-over-quota`
  //    returned in step 1, never here (A1).
  const innerResult = acquireInner(state.inner, tenant, now);
  if (!innerResult.ok) {
    return err(
      internalInvariantViolated(
        "admission inner acquire rejected despite per-tenant ceiling and INNER_GLOBAL_HEADROOM guards",
        { tenant, innerError: innerResult.error },
      ),
    );
  }

  const perTenant = new Map(state.perTenant);
  perTenant.set(tenant, { current: tenantState.current + 1, max: tenantState.max });

  const liveWorkers: LiveWorkers = needsWorker
    ? { ...state.liveWorkers, current: state.liveWorkers.current + 1 }
    : state.liveWorkers;

  const newState: TenantConcurrencyState = {
    ...state,
    inner: innerResult.value.state,
    perTenant,
    liveWorkers,
  };

  const token: AdmitToken = {
    tenant,
    innerToken: innerResult.value.token,
    claimedWorker: needsWorker,
    admittedAt: now,
  } as unknown as AdmitToken;

  return ok({ state: newState, token });
};

/**
 * Release a previously admitted slot. Always succeeds — reverses the inner
 * concurrency slot, decrements the per-tenant counter (clamped at 0), and, when
 * the token claimed a live worker, decrements the live-worker count (clamped at
 * 0). Idempotency note: like `release` in `domain/concurrency.ts`, calling this
 * more than once with the same token clamps rather than going negative.
 */
export const releaseTenant = (
  state: TenantConcurrencyState,
  token: AdmitToken,
): TenantConcurrencyState => {
  const innerState = releaseInner(state.inner, token.innerToken);

  const tenantState = state.perTenant.get(token.tenant);
  const perTenant = new Map(state.perTenant);
  if (tenantState) {
    perTenant.set(token.tenant, {
      current: Math.max(0, tenantState.current - 1),
      max: tenantState.max,
    });
  }

  const liveWorkers: LiveWorkers = token.claimedWorker
    ? { ...state.liveWorkers, current: Math.max(0, state.liveWorkers.current - 1) }
    : state.liveWorkers;

  return { ...state, inner: innerState, perTenant, liveWorkers };
};

// ---------------------------------------------------------------------------
// Queries (pure)
// ---------------------------------------------------------------------------

/** Current in-flight count for a tenant (0 if the tenant has never been admitted). */
export const tenantCurrent = (state: TenantConcurrencyState, tenant: TenantId): number =>
  state.perTenant.get(tenant)?.current ?? 0;

/** Effective ceiling for a tenant (its explicit limit, else the default). */
export const tenantMax = (state: TenantConcurrencyState, tenant: TenantId): number =>
  state.perTenant.get(tenant)?.max ?? state.defaultTenantMax;

/**
 * Whether `admitTenant` would succeed RIGHT NOW for this tenant, without
 * mutating state. Consistent with `admitTenant`: false iff the tenant is at its
 * ceiling OR it needs a new worker the box cannot grant OR the inner limiter is
 * exhausted.
 */
export const canAdmit = (state: TenantConcurrencyState, tenant: TenantId): boolean => {
  const tenantState =
    state.perTenant.get(tenant) ?? { current: 0, max: state.defaultTenantMax };
  if (tenantState.current >= tenantState.max) return false;
  const needsWorker = tenantState.current === 0;
  if (needsWorker && state.liveWorkers.current >= state.liveWorkers.max) return false;
  // Inner global is a non-binding safety net (see INNER_GLOBAL_HEADROOM); checked
  // for total consistency with `admitTenant`'s step 3, never the binding axis.
  if (state.inner.global.current >= state.inner.global.max) return false;
  return true;
};

// NOTE: AdmitToken forging for tests lives under src/__tests__ (mirroring the
// `concurrency-token.ts` fixture), NOT here — keeping token minting out of the
// production module means no production call site can forge an AdmitToken.
