/**
 * Tests for per-tenant admission (T9, FR-032/038, SC-011, US8).
 *
 * Unit tests cover: per-tenant ceiling → tenant-over-quota with the right
 * retry-after; releaseTenant decrements the per-tenant counter correctly and
 * clamps at 0; the documented reconfigure-down (transient over-capacity) drain.
 * The property test proves anti-starvation (SC-011): a heavy tenant saturating
 * its OWN ceiling NEVER causes another tenant's admitTenant to be rejected.
 *
 * NOTE: the global live-worker bound (FR-033) is NOT modelled by admission — the
 * worker-lifecycle manager is its sole enforcer — so it is tested there
 * (worker-lifecycle-manager.test.ts), not here.
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
  forgetTenant,
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
    let state = initTenantConcurrency({ defaultTenantMax: 3, retryAfterSeconds: 7 });
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
    let state = initTenantConcurrency({ defaultTenantMax: 10 });
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
    let state = initTenantConcurrency({ defaultTenantMax: 5 });
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
    let state = initTenantConcurrency({ defaultTenantMax: 5 });
    const a = tid("a");
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = s1;
    state = releaseTenant(state, token);
    expect(tenantCurrent(state, a)).toBe(0);
    // Over-release with a forged equivalent token must clamp, never go negative.
    const forged = unsafeTestAdmitToken(a, 0);
    state = releaseTenant(state, forged);
    state = releaseTenant(state, forged);
    expect(tenantCurrent(state, a)).toBe(0);
  });
});

// ── release (FR-032) ───────────────────────────────────────────────────────────

describe("releaseTenant", () => {
  test("decrements the per-tenant counter; a released slot is re-admittable", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 1 });
    const a = tid("a");
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = s1;
    expect(tenantCurrent(state, a)).toBe(1);
    // At the ceiling of 1 — a second admit is refused.
    expect(admitTenant(state, a, 1).ok).toBe(false);

    state = releaseTenant(state, token);
    expect(tenantCurrent(state, a)).toBe(0);
    // The freed slot is admittable again.
    expect(admitTenant(state, a, 2).ok).toBe(true);
  });

  test("releasing one of a tenant's runs leaves the others in flight", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5 });
    const a = tid("a");
    const first = admitOrThrow(state, a, 0);
    state = first.state;
    const second = admitOrThrow(state, a, 1);
    state = second.state;
    expect(tenantCurrent(state, a)).toBe(2);

    state = releaseTenant(state, second.token);
    expect(tenantCurrent(state, a)).toBe(1);
    state = releaseTenant(state, first.token);
    expect(tenantCurrent(state, a)).toBe(0);
  });

  test("idempotent over-release clamps at zero (forged token)", () => {
    let state = initTenantConcurrency({ defaultTenantMax: 5 });
    const a = tid("a");
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = s1;
    state = releaseTenant(state, token);
    // Over-release with a forged equivalent token must not go negative.
    const forged = unsafeTestAdmitToken(a, 0);
    state = releaseTenant(state, forged);
    state = releaseTenant(state, forged);
    expect(tenantCurrent(state, a)).toBe(0);
  });
});

// ── forgetTenant (admission-state reclamation on final removal) ───────────────

describe("forgetTenant", () => {
  test("drops a fully-released tenant's per-tenant AND inner per-key entries", () => {
    const a = tid("a");
    let state = withTenantLimit(initTenantConcurrency({ defaultTenantMax: 3 }), a, 3);
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = releaseTenant(s1, token);
    expect(state.perTenant.has(a)).toBe(true);
    expect(state.inner.perDag.has(a)).toBe(true);

    const reclaimed = forgetTenant(state, a);
    expect(reclaimed.perTenant.has(a)).toBe(false);
    expect(reclaimed.inner.perDag.has(a)).toBe(false);
  });

  test("preserves a tenant with in-flight runs (same reference, drain-down intact)", () => {
    const a = tid("a");
    const state = withTenantLimit(initTenantConcurrency({ defaultTenantMax: 3 }), a, 3);
    const { state: live } = admitOrThrow(state, a, 0);
    const reclaimed = forgetTenant(live, a);
    expect(reclaimed).toBe(live);
    expect(tenantCurrent(reclaimed, a)).toBe(1);
  });

  test("is a same-reference no-op for a never-admitted tenant", () => {
    const state = initTenantConcurrency({ defaultTenantMax: 3 });
    expect(forgetTenant(state, tid("ghost"))).toBe(state);
  });

  test("a tenant re-admitted after forget starts from a clean counter", () => {
    const a = tid("a");
    let state = withTenantLimit(initTenantConcurrency({ defaultTenantMax: 2 }), a, 2);
    const { state: s1, token } = admitOrThrow(state, a, 0);
    state = forgetTenant(releaseTenant(s1, token), a);
    const { state: s2 } = admitOrThrow(state, a, 1);
    expect(tenantCurrent(s2, a)).toBe(1);
  });
});

// ── canAdmit consistency ───────────────────────────────────────────────────────

describe("canAdmit", () => {
  test("predicts admitTenant success/failure for a tenant at various fills", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 8 }), (max, fills) => {
        let state = initTenantConcurrency({ defaultTenantMax: max });
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
  test("a heavy tenant's per-tenant fill NEVER causes a victim's rejection; the victim admits up to its OWN ceiling regardless of the heavy tenant's load", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }), // heavy tenant ceiling
        fc.integer({ min: 1, max: 6 }), // victim tenant ceiling
        fc.integer({ min: 1, max: 30 }), // heavy admit attempts
        (heavyMax, victimMax, heavyAttempts) => {
          let state = initTenantConcurrency();
          const heavy = tid("heavy");
          const victim = tid("victim");
          state = withTenantLimit(state, heavy, heavyMax);
          state = withTenantLimit(state, victim, victimMax);

          // Heavy tenant hammers the box, far beyond its own ceiling.
          for (let i = 0; i < heavyAttempts; i++) {
            const r = admitTenant(state, heavy, i);
            if (r.ok) state = r.value.state;
            // Invariant: heavy tenant never exceeds its OWN ceiling.
            expect(tenantCurrent(state, heavy)).toBeLessThanOrEqual(heavyMax);
          }

          // The victim must be admittable up to its OWN ceiling, UNAFFECTED by the
          // heavy tenant's saturation (SC-011 / US8): the only thing that may gate a
          // victim admit is the victim's own ceiling — never another tenant's load.
          for (let i = 0; i < victimMax; i++) {
            const r = admitTenant(state, victim, i);
            expect(isOk(r)).toBe(true);
            if (r.ok) state = r.value.state;
          }
          expect(tenantCurrent(state, victim)).toBe(victimMax);

          // At its own ceiling, the NEXT victim admit is its own over-quota — and
          // it names the VICTIM, never a cross-tenant signal.
          const over = admitTenant(state, victim, 999);
          expect(isErr(over)).toBe(true);
          if (!over.ok) {
            expect(over.error.kind).toBe("tenant-over-quota");
            if (over.error.kind === "tenant-over-quota") expect(over.error.tenant).toBe(victim);
          }
        },
      ),
    );
  });

  test("per-tenant counters stay within [0, max] across arbitrary interleaved admit/release", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tenant: fc.constantFrom("a", "b", "c", "d", "e"),
            release: fc.boolean(),
          }),
          { maxLength: 80 },
        ),
        (ops) => {
          let state = initTenantConcurrency({ defaultTenantMax: 4 });
          const live: AdmitToken[] = [];
          let clock = 0;

          for (const op of ops) {
            const t = tid(op.tenant);
            if (op.release && live.length > 0) {
              const tok = live.pop()!;
              state = releaseTenant(state, tok);
            } else {
              const r = admitTenant(state, t, clock++);
              if (r.ok) {
                state = r.value.state;
                live.push(r.value.token);
              } else {
                // The only rejection is the tenant's own ceiling (no live-worker axis).
                expect(r.error.kind).toBe("tenant-over-quota");
              }
            }
            // Hard invariant at every step: 0 <= current <= max for every tenant
            // (no reconfigure-down happens in this property).
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
