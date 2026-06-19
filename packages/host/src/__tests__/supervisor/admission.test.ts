/**
 * Tests for per-tenant admission + the global live-worker upper bound
 * (T9, FR-032/033/038/039, SC-011, US8).
 *
 * Unit tests cover: per-tenant ceiling → tenant-over-quota with the right
 * retry-after; live-worker bound → worker-unavailable; releaseTenant decrements
 * tenant + live-worker counters correctly; an already-live tenant is not
 * blocked by the live-worker bound. The property test proves anti-starvation
 * (SC-011): a heavy tenant saturating its OWN ceiling NEVER causes another
 * tenant's admitTenant to be rejected, and the live-worker bound is NEVER
 * exceeded.
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { isOk, isErr } from "@fuguejs/framework";
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import {
  initTenantConcurrency,
  withTenantLimit,
  admitTenant,
  releaseTenant,
  canAdmit,
  tenantCurrent,
  type TenantConcurrencyState,
  type AdmitToken,
} from "../../supervisor/admission.js";
import { unsafeTestAdmitToken } from "../fixtures/admit-token.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant id in test: ${s}`);
  return r.value;
};

const admitOrThrow = (
  state: TenantConcurrencyState,
  tenant: TenantId,
  now: number,
): { state: TenantConcurrencyState; token: AdmitToken } => {
  const r = admitTenant(state, tenant, now);
  if (!r.ok) throw new Error(`expected admit ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

// ── per-tenant ceiling (FR-032 / FR-038) ──────────────────────────────────────

describe("admitTenant — per-tenant ceiling", () => {
  test("admits up to the ceiling, then refuses with tenant-over-quota", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 3, maxLiveWorkers: 50, retryAfterSeconds: 7 });
    const t = tid("acme");

    for (let i = 0; i < 3; i++) {
      const r = admitTenant(state, t, i);
      expect(isOk(r)).toBe(true);
      if (r.ok) state = r.value.state;
    }
    expect(tenantCurrent(state, t)).toBe(3);

    const over = admitTenant(state, t, 99);
    expect(isErr(over)).toBe(true);
    if (!over.ok) {
      expect(over.error.kind).toBe("tenant-over-quota");
      if (over.error.kind === "tenant-over-quota") {
        expect(over.error.tenant).toBe(t);
        expect(over.error.retryAfterSeconds).toBe(7);
      }
    }
  });

  test("explicit withTenantLimit overrides the default ceiling", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 10, maxLiveWorkers: 50 });
    const t = tid("small");
    state = withTenantLimit(state, t, 1);

    const first = admitTenant(state, t, 0);
    expect(isOk(first)).toBe(true);
    if (first.ok) state = first.value.state;

    const second = admitTenant(state, t, 1);
    expect(isErr(second)).toBe(true);
    if (!second.ok) expect(second.error.kind).toBe("tenant-over-quota");
  });

  test("the over-quota retryAfter is the configured per-tenant backoff", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 1, retryAfterSeconds: 42 });
    const t = tid("t1");
    state = admitOrThrow(state, t, 0).state;
    const over = admitTenant(state, t, 1);
    expect(over.ok).toBe(false);
    if (!over.ok && over.error.kind === "tenant-over-quota") {
      expect(over.error.retryAfterSeconds).toBe(42);
    }
  });

  test("the over-quota retryAfter defaults to the documented 5s when config omits it", () => {
    // No explicit retryAfterSeconds → documented default of 5 (see initTenantConcurrency).
    let state = initTenantConcurrency({ defaultTenantMax: 1 });
    const t = tid("t1");
    state = admitOrThrow(state, t, 0).state;
    const over = admitTenant(state, t, 1);
    expect(over.ok).toBe(false);
    if (!over.ok && over.error.kind === "tenant-over-quota") {
      expect(over.error.retryAfterSeconds).toBe(5);
    }
  });
});

// ── C3: reconfigure-down (transient over-capacity drain) ──────────────────────

describe("withTenantLimit lowering max below in-flight current (drain-down)", () => {
  test("documented transient over-capacity: state stays consistent, new admits gated until drained, release clamps at 0", () => {
    // Fill a tenant to 3 in-flight.
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 50 });
    const t = tid("acme");
    const tokens: AdmitToken[] = [];
    for (let i = 0; i < 3; i++) {
      const { state: s, token } = admitOrThrow(state, t, i);
      state = s;
      tokens.push(token);
    }
    expect(tenantCurrent(state, t)).toBe(3);

    // Reconfigure the ceiling DOWN to 1 — below the in-flight current of 3.
    // This is the documented, intentional transient over-capacity window: the
    // entry becomes { current: 3, max: 1 }. We do NOT reject this or clamp current.
    state = withTenantLimit(state, t, 1);
    const entry = state.perTenant.get(t)!;
    expect(entry.current).toBe(3); // current preserved, NOT clamped to max
    expect(entry.max).toBe(1);

    // New admits are GATED until current drains back under max (3 >= 1).
    const blocked = admitTenant(state, t, 10);
    expect(isErr(blocked)).toBe(true);
    if (!blocked.ok) expect(blocked.error.kind).toBe("tenant-over-quota");
    expect(canAdmit(state, t)).toBe(false);

    // Drain: releasing 1 leaves current=2, still over the lowered max → still gated.
    state = releaseTenant(state, tokens[0]!);
    expect(tenantCurrent(state, t)).toBe(2);
    expect(canAdmit(state, t)).toBe(false);
    expect(admitTenant(state, t, 11).ok).toBe(false);

    // Release another → current=1, now AT max (1) → still gated (>=).
    state = releaseTenant(state, tokens[1]!);
    expect(tenantCurrent(state, t)).toBe(1);
    expect(canAdmit(state, t)).toBe(false);

    // Release the last → current=0, under max → admits resume.
    state = releaseTenant(state, tokens[2]!);
    expect(tenantCurrent(state, t)).toBe(0);
    expect(canAdmit(state, t)).toBe(true);
    const resumed = admitTenant(state, t, 12);
    expect(isOk(resumed)).toBe(true);
    if (resumed.ok) {
      state = resumed.value.state;
      expect(tenantCurrent(state, t)).toBe(1);
    }
  });

  test("release clamps current at 0 (never negative) — invariant 0 <= current", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 2 });
    const a = tid("a");
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = s1;
    state = releaseTenant(state, token);
    expect(tenantCurrent(state, a)).toBe(0);
    // Over-release with a forged equivalent token must clamp, never go negative.
    const forged = unsafeTestAdmitToken(a, true, 0);
    state = releaseTenant(state, forged);
    state = releaseTenant(state, forged);
    expect(tenantCurrent(state, a)).toBe(0);
    expect(state.liveWorkers.current).toBe(0);
  });
});

// ── live-worker upper bound (FR-033 / FR-039) ─────────────────────────────────

describe("admitTenant — live-worker upper bound", () => {
  test("never exceeds maxLiveWorkers; a tenant needing a new worker is refused 503", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 2 });
    const a = tid("a");
    const b = tid("b");
    const c = tid("c");

    state = admitOrThrow(state, a, 0).state; // claims worker 1
    state = admitOrThrow(state, b, 0).state; // claims worker 2 (at bound)
    expect(state.liveWorkers.current).toBe(2);

    // c has no live worker and the box is at the bound → worker-unavailable.
    const refused = admitTenant(state, c, 0);
    expect(isErr(refused)).toBe(true);
    if (!refused.ok) {
      expect(refused.error.kind).toBe("worker-unavailable");
      if (refused.error.kind === "worker-unavailable") expect(refused.error.tenant).toBe(c);
    }
    expect(state.liveWorkers.current).toBeLessThanOrEqual(state.liveWorkers.max);
  });

  test("a tenant that ALREADY has a live worker is not blocked by the bound", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 1 });
    const a = tid("a");

    // a claims the only worker slot.
    state = admitOrThrow(state, a, 0).state;
    expect(state.liveWorkers.current).toBe(1);

    // a's second run does NOT need a new worker → admitted despite bound==1.
    const second = admitTenant(state, a, 1);
    expect(isOk(second)).toBe(true);
    if (second.ok) {
      expect(second.value.state.liveWorkers.current).toBe(1);
      expect(tenantCurrent(second.value.state, a)).toBe(2);
    }
  });
});

// ── release (FR-032/033) ───────────────────────────────────────────────────────

describe("releaseTenant", () => {
  test("decrements the per-tenant counter and frees the live-worker slot", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 1 });
    const a = tid("a");
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = s1;
    expect(state.liveWorkers.current).toBe(1);

    state = releaseTenant(state, token);
    expect(tenantCurrent(state, a)).toBe(0);
    // The single live-worker slot is freed so a different tenant can claim it.
    expect(state.liveWorkers.current).toBe(0);

    const b = tid("b");
    const r = admitTenant(state, b, 1);
    expect(isOk(r)).toBe(true);
  });

  test("only the worker-claiming token frees a worker slot (multi-run tenant)", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 1 });
    const a = tid("a");
    const first = admitOrThrow(state, a, 0); // claimedWorker = true
    state = first.state;
    const second = admitOrThrow(state, a, 1); // claimedWorker = false
    state = second.state;
    expect(state.liveWorkers.current).toBe(1);

    // Releasing the SECOND (non-claiming) run leaves the worker live.
    state = releaseTenant(state, second.token);
    expect(state.liveWorkers.current).toBe(1);
    expect(tenantCurrent(state, a)).toBe(1);

    // Releasing the FIRST (claiming) run frees the worker.
    state = releaseTenant(state, first.token);
    expect(state.liveWorkers.current).toBe(0);
    expect(tenantCurrent(state, a)).toBe(0);
  });

  test("idempotent over-release clamps at zero (forged token)", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5, maxLiveWorkers: 2 });
    const a = tid("a");
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = s1;
    state = releaseTenant(state, token);
    // Over-release with a forged equivalent token must not go negative.
    const forged = unsafeTestAdmitToken(a, true, 0);
    state = releaseTenant(state, forged);
    state = releaseTenant(state, forged);
    expect(tenantCurrent(state, a)).toBe(0);
    expect(state.liveWorkers.current).toBe(0);
  });
});

// ── canAdmit consistency ───────────────────────────────────────────────────────

describe("canAdmit", () => {
  test("predicts admitTenant success/failure for a tenant at various fills", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 8 }), (max, fills) => {
        let state = initTenantConcurrency({ defaultTenantMax: max, maxLiveWorkers: 50 });
        const t = tid("t");
        const effective = Math.min(fills, max);
        for (let i = 0; i < effective; i++) {
          const r = admitTenant(state, t, i);
          if (r.ok) state = r.value.state;
        }
        const predicted = canAdmit(state, t);
        const actual = admitTenant(state, t, effective);
        expect(predicted).toBe(actual.ok);
      }),
    );
  });
});

// ── SC-011: anti-starvation property ──────────────────────────────────────────

describe("SC-011 anti-starvation", () => {
  test("a heavy tenant's per-tenant fill NEVER causes the victim's rejection; the victim is gated ONLY by the live-worker bound, and only legitimately", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }), // heavy tenant ceiling
        fc.integer({ min: 1, max: 6 }), // victim tenant ceiling
        // maxLiveWorkers includes 1: with a bound of 1 and the heavy tenant
        // holding the only worker slot, the victim genuinely CANNOT get a fresh
        // worker — this is the live-worker-slot contention C1 demands we exercise.
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 30 }), // heavy admit attempts
        (heavyMax, victimMax, maxLiveWorkers, heavyAttempts) => {
          let state = initTenantConcurrency({ maxLiveWorkers });
          const heavy = tid("heavy");
          const victim = tid("victim");
          state = withTenantLimit(state, heavy, heavyMax);
          state = withTenantLimit(state, victim, victimMax);

          // Heavy tenant hammers the box, far beyond its own ceiling.
          for (let i = 0; i < heavyAttempts; i++) {
            const r = admitTenant(state, heavy, i);
            if (r.ok) state = r.value.state;
            // Invariant: live-worker bound never exceeded.
            expect(state.liveWorkers.current).toBeLessThanOrEqual(state.liveWorkers.max);
            // Invariant: heavy tenant never exceeds its OWN ceiling.
            expect(tenantCurrent(state, heavy)).toBeLessThanOrEqual(heavyMax);
          }

          // Now drive the victim up to its own ceiling. The heavy tenant's
          // per-tenant saturation must contribute ZERO rejections (SC-011/US8):
          // the ONLY thing that may legitimately gate a victim admit is the
          // live-worker bound, and that only when the victim needs a FRESH
          // worker (its current === 0) and no free slot exists. So the victim is
          // admittable IFF it already holds a slot (current > 0) OR a free worker
          // slot exists. This is the full FR-032/FR-033/SC-011 contract.
          for (let i = 0; i < victimMax; i++) {
            const before = tenantCurrent(state, victim);
            const holdsSlot = before > 0;
            const freeWorkerSlot = state.liveWorkers.current < state.liveWorkers.max;
            const shouldAdmit = holdsSlot || freeWorkerSlot;

            const r = admitTenant(state, victim, i);

            if (shouldAdmit) {
              expect(isOk(r)).toBe(true);
              if (r.ok) state = r.value.state;
            } else {
              // The ONLY legitimate gate is the live-worker bound — and it must
              // surface as worker-unavailable for the victim, NOT tenant-over-quota
              // (the victim is nowhere near its own ceiling).
              expect(isErr(r)).toBe(true);
              if (!r.ok) {
                expect(r.error.kind).toBe("worker-unavailable");
                if (r.error.kind === "worker-unavailable") expect(r.error.tenant).toBe(victim);
              }
              // A blocked fresh-worker admit cannot have advanced the victim.
              expect(tenantCurrent(state, victim)).toBe(before);
            }
            expect(state.liveWorkers.current).toBeLessThanOrEqual(state.liveWorkers.max);
          }
        },
      ),
    );
  });

  test("global live-worker invariant holds across arbitrary interleaved admit/release; every worker-unavailable rejection is correct (box at bound AND tenant had current===0)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }), // maxLiveWorkers
        fc.array(
          fc.record({
            tenant: fc.constantFrom("a", "b", "c", "d", "e"),
            release: fc.boolean(),
          }),
          { maxLength: 80 },
        ),
        (maxLiveWorkers, ops) => {
          let state = initTenantConcurrency({ defaultTenantMax: 4, maxLiveWorkers });
          const live: AdmitToken[] = [];
          let clock = 0;

          for (const op of ops) {
            const t = tid(op.tenant);
            if (op.release && live.length > 0) {
              const tok = live.pop()!;
              state = releaseTenant(state, tok);
            } else {
              const beforeCurrent = tenantCurrent(state, t);
              const beforeWorkers = state.liveWorkers.current;
              const r = admitTenant(state, t, clock++);
              if (r.ok) {
                state = r.value.state;
                live.push(r.value.token);
              } else if (r.error.kind === "worker-unavailable") {
                // Rejection-correctness, not just safety: a worker-unavailable
                // is legitimate ONLY when the box was genuinely at the live-worker
                // bound AND this tenant needed a fresh worker (current === 0).
                expect(beforeWorkers).toBe(state.liveWorkers.max);
                expect(beforeCurrent).toBe(0);
                expect(r.error.tenant).toBe(t);
              }
            }
            // Hard invariants at every step.
            expect(state.liveWorkers.current).toBeLessThanOrEqual(state.liveWorkers.max);
            expect(state.liveWorkers.current).toBeGreaterThanOrEqual(0);
            // No reconfigure-down happens in this property, so the steady-state
            // bound also holds: 0 <= current <= max for every tenant.
            for (const [, ts] of state.perTenant) {
              expect(ts.current).toBeGreaterThanOrEqual(0);
              expect(ts.current).toBeLessThanOrEqual(ts.max);
            }
          }
        },
      ),
    );
  });
});
