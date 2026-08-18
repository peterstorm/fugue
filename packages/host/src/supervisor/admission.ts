/**
 * Per-tenant admission — a PURE extension of the `domain/concurrency.ts`
 * `ConcurrencyState` ADT with a per-tenant concurrency axis.
 *
 * This module does NOT fork the concurrency limiter: a `TenantConcurrencyState`
 * COMPOSES an inner `ConcurrencyState` (reused verbatim for the
 * global-execution + per-DAG limits) and layers ONE additional axis on top:
 *
 *   - per-tenant concurrency ceiling — each tenant gets its OWN `{current,max}`
 *     slot count, so one tenant saturating its ceiling can NEVER consume
 *     another tenant's slots (FR-032, SC-011, US8). Rejection is the caller's
 *     OWN `tenant-over-quota` (429 + per-tenant Retry-After, FR-038).
 *
 * LIVE-WORKER BOUND (FR-033) lives ELSEWHERE: the worker-lifecycle manager's
 * `liveWorkerCount()` is the SOLE authoritative enforcement point (it refuses a
 * new spawn at `SUPERVISOR_MAX_LIVE_WORKERS` → `worker-unavailable` 503).
 * Admission deliberately does NOT mirror that count — a second counter here
 * would be a dead, drift-prone duplicate of the lifecycle's authoritative one
 * (it was previously carried sized-to-never-bind, and removed for that reason).
 *
 * PURITY: every function here is pure — no timers, no async, no `Date.now()`.
 * The clock is injected as `now: number`, mirroring `acquire`/`release` in
 * `domain/concurrency.ts`. State transitions return NEW immutable state; Maps
 * are copied, never mutated in place.
 *
 * AD-9: admission is pure supervisor state. The per-tenant MEMORY ceiling
 * (FR-034) is enforced elsewhere — via the per-worker heap flag at spawn
 * (T6/T8). Here we model only the per-tenant admission/concurrency axis: how
 * many concurrent runs a tenant may have in flight.
 *
 * @satisfies FR-032 — per-tenant resource admission replaces the single global limit.
 * @satisfies FR-038 — over-quota → 429 + Retry-After, scoped to the offending tenant.
 * @satisfies SC-011 / US8 — anti-starvation: a heavy tenant cannot reject others.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { TenantId } from "../domain/tenant.js";
import type { HostError } from "../domain/host-error.js";
import {
  tenantOverQuota,
  internalInvariantViolated,
} from "../domain/host-error.js";
import {
  type ConcurrencyState,
  type AcquireToken,
  acquire as acquireInner,
  release as releaseInner,
  withDagLimit,
  forgetDagLimit,
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
 * Tenant-aware concurrency state. COMPOSES (does not fork) the existing
 * `ConcurrencyState` for the global-execution + per-DAG axes, and adds:
 *   - `perTenant`         — per-tenant concurrency ceilings (FR-032).
 *   - `defaultTenantMax`  — ceiling applied to a tenant with no explicit limit.
 *
 * Spec shape (plan): `ConcurrencyState & { perTenant }`. We model the
 * "& ConcurrencyState" by EMBEDDING it as `inner` rather than spreading, so the
 * inner ADT's invariants stay owned by `domain/concurrency.ts` and cannot drift
 * here. The global live-worker bound (FR-033) is NOT modelled here — the
 * worker-lifecycle manager is its sole authoritative enforcer (see module doc).
 */
export interface TenantConcurrencyState {
  readonly inner: ConcurrencyState<TenantId>;
  readonly perTenant: ReadonlyMap<TenantId, TenantConcurrency>;
  readonly defaultTenantMax: number;
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
 * Opaque proof that a tenant slot was acquired through `admitTenant`. Wraps the
 * inner `AcquireToken` so a single release reverses BOTH the inner concurrency
 * slot and the per-tenant counter atomically. Branded so only `admitTenant` can
 * produce one — mirrors the `AcquireToken` discipline (no minting in this
 * production module; the test-only forger lives under `__tests__`).
 */
export interface AdmitToken {
  readonly tenant: TenantId;
  readonly innerToken: AcquireToken<TenantId>;
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
 * sized so it can NEVER bind before the per-tenant ceilings do: the box-wide
 * hard cap is the worker-lifecycle manager's live-worker bound (FR-033, enforced
 * there), not a shared inner execution counter. `INNER_GLOBAL_HEADROOM` makes
 * the inner global a non-binding safety net rather than a starvation vector.
 */

/**
 * Sizes the inner global limit large enough that it never binds before the
 * per-tenant ceilings. The true box-wide cap is the lifecycle manager's
 * live-worker bound (FR-033); this is just a non-binding upper safety net
 * inherited from the inner ADT.
 *
 * PRECONDITION: the "inner global never binds" guarantee (and the unreachable-branch
 * 500 in `admitTenant` step 2 that rests on it) holds PROVIDED the sum of per-tenant
 * ceilings stays well under `INNER_GLOBAL_HEADROOM`; revisit if ceilings are ever
 * configured into the hundreds of thousands.
 */
const INNER_GLOBAL_HEADROOM = 1_000_000;

/**
 * Create initial tenant-aware concurrency state. The per-tenant ceilings
 * (FR-032) are the binding admission axis here; the inner `ConcurrencyState`'s
 * global limit is deliberately sized so it never binds first (see
 * `INNER_GLOBAL_HEADROOM`), because FR-032 REPLACES the single global
 * concurrency limit with per-tenant quotas. The live-worker bound (FR-033) is
 * enforced by the worker-lifecycle manager, not here.
 *
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

/**
 * Reclaim a tenant's admission state on its FINAL removal (the grace-window
 * hard-delete). Drops the per-tenant ceiling entry AND the mirrored inner
 * per-key entry, but ONLY when the tenant has no in-flight runs (`current === 0`);
 * a tenant with live runs is preserved unchanged so a pending `releaseTenant`
 * still finds its counter to decrement (mirrors the in-flight retention in
 * `reconcileDagLimits` / `forgetDagLimit`). Idempotent: forgetting an absent or
 * still-live tenant returns the SAME state reference.
 *
 * WHY: without this, `perTenant` (and the mirrored inner `perDag`) accumulate one
 * permanent entry per distinct tenant id ever admitted — a slow unbounded leak
 * reclaimed only by a process restart. Bound to the registry's terminal
 * hard-delete (post-grace, tenant fully retired), admission state is released in
 * lockstep with final tenant removal. The `current > 0` guard keeps the
 * transient over-capacity / clamp-at-0 invariants intact for any edge case.
 */
export const forgetTenant = (
  state: TenantConcurrencyState,
  tenant: TenantId,
): TenantConcurrencyState => {
  const existing = state.perTenant.get(tenant);
  if (existing !== undefined && existing.current > 0) return state; // preserve drain-down
  const inner = forgetDagLimit(state.inner, tenant);
  if (existing === undefined && inner === state.inner) return state; // nothing to reclaim
  const perTenant = new Map(state.perTenant);
  perTenant.delete(tenant);
  return { ...state, perTenant, inner };
};

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Admit a tenant for a NEW run (FR-032/038). The gate, in order:
 *
 *   1. PER-TENANT CEILING — if THIS tenant is at its own ceiling, refuse with
 *      `tenant-over-quota` (429 + per-tenant Retry-After). This check is scoped
 *      entirely to the caller's own counters, so it can never be triggered by
 *      another tenant's load (FR-032, SC-011).
 *   2. INNER CONCURRENCY — defer to the existing `acquire` for the global +
 *      per-DAG limits, using the tenant id as the inner key. An inner rejection
 *      (global-at-capacity / dag-at-capacity) is mapped to the tenant's own
 *      `tenant-over-quota` so the box-wide global limit also surfaces as a
 *      retriable, tenant-scoped 429 rather than leaking a global signal.
 *
 * The global live-worker bound (FR-033) is NOT checked here — the worker-lifecycle
 * manager is its sole enforcer (see module doc).
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

  // 2. Inner per-tenant slot accounting, reusing the existing pure ADT verbatim.
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

  const newState: TenantConcurrencyState = {
    ...state,
    inner: innerResult.value.state,
    perTenant,
  };

  const token: AdmitToken = {
    tenant,
    innerToken: innerResult.value.token,
    admittedAt: now,
  } as unknown as AdmitToken;

  return ok({ state: newState, token });
};

/**
 * Release a previously admitted slot. Always succeeds — reverses the inner
 * concurrency slot and decrements the per-tenant counter (clamped at 0).
 * Idempotency note: like `release` in `domain/concurrency.ts`, calling this more
 * than once with the same token clamps rather than going negative.
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

  return { ...state, inner: innerState, perTenant };
};

// ---------------------------------------------------------------------------
// Queries (pure)
// ---------------------------------------------------------------------------

/** Current in-flight count for a tenant (0 if the tenant has never been admitted). */
export const tenantCurrent = (state: TenantConcurrencyState, tenant: TenantId): number =>
  state.perTenant.get(tenant)?.current ?? 0;

/**
 * Whether `admitTenant` would succeed RIGHT NOW for this tenant, without
 * mutating state. Consistent with `admitTenant`: false iff the tenant is at its
 * ceiling OR the inner limiter is exhausted.
 */
export const canAdmit = (state: TenantConcurrencyState, tenant: TenantId): boolean => {
  const tenantState =
    state.perTenant.get(tenant) ?? { current: 0, max: state.defaultTenantMax };
  if (tenantState.current >= tenantState.max) return false;
  // Inner global is a non-binding safety net (see INNER_GLOBAL_HEADROOM); checked
  // for total consistency with `admitTenant`'s step 2, never the binding axis.
  if (state.inner.global.current >= state.inner.global.max) return false;
  return true;
};

// NOTE: AdmitToken forging for tests lives under src/__tests__ (mirroring the
// `concurrency-token.ts` fixture), NOT here — keeping token minting out of the
// production module means no production call site can forge an AdmitToken.
