/**
 * Tests for the worker-lifecycle functional core (worker-lifecycle-decisions.ts):
 * the crash-restart budget, the durable-record derivation, the re-adoption
 * decision and the stop-signal plans. Pure functions over plain data — no fakes,
 * no clock; fast-check properties for the invariants, examples for the tables.
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { match } from "ts-pattern";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import * as lifecycleAdt from "../../../supervisor/lifecycle/worker-lifecycle.js";
import type { WorkerState } from "../../../supervisor/lifecycle/worker-lifecycle.js";
import type { WorkerRecord } from "../../../supervisor/lifecycle/worker-registry-redis.js";
import type { RestartBudget } from "../../../supervisor/lifecycle/thin-init.js";
import {
  decideCrashRestart,
  workerRecordOf,
  decideAdoption,
  stopPlan,
  type Adoption,
  type CrashRestartDecision,
  type StopReason,
} from "../../../supervisor/lifecycle/worker-lifecycle-decisions.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

// ── Generators (valid domain values only) ───────────────────────────────────

const tenantArb = fc.constantFrom("acme", "globex", "initech").map(tid);
const instantArb = fc.integer({ min: 0, max: 1_000_000_000 });
const pidArb = fc.integer({ min: 1, max: 4_194_304 });
const udsArb = fc.constantFrom("/run/fugue/acme.sock", "/run/fugue/globex.sock");
const policyArb = fc.record({
  maxRestartsPerWindow: fc.integer({ min: 0, max: 6 }),
  restartWindowMs: fc.integer({ min: 1, max: 100_000 }),
});

const workerStateArb: fc.Arbitrary<WorkerState> = fc.oneof(
  fc.record({ phase: fc.constant("spawning" as const), tenant: tenantArb, eagerPin: fc.boolean(), requestedAt: instantArb }),
  fc.record({
    phase: fc.constant("live" as const), tenant: tenantArb, eagerPin: fc.boolean(), pid: pidArb, udsPath: udsArb,
    startedAt: instantArb, lastActivityAt: instantArb,
  }),
  fc.record({
    phase: fc.constant("draining" as const), tenant: tenantArb, eagerPin: fc.boolean(), pid: pidArb, udsPath: udsArb,
    drainStartedAt: instantArb,
  }),
  fc.record({
    phase: fc.constant("crashed" as const), tenant: tenantArb, eagerPin: fc.boolean(), crashedAt: instantArb,
    exitCode: fc.option(fc.integer({ min: -255, max: 255 }), { nil: null }),
  }),
  fc.record({ phase: fc.constant("evicted" as const), tenant: tenantArb, eagerPin: fc.boolean(), evictedAt: instantArb }),
);

const workerRecordArb: fc.Arbitrary<WorkerRecord> = fc.record({
  tenant: tenantArb,
  pid: pidArb,
  udsPath: udsArb,
  startedAt: instantArb,
  health: fc.constantFrom("live" as const, "draining" as const),
  eagerPin: fc.boolean(),
});

/** The manager's dispatch of an adoption onto the real ADT constructors. */
const adopt = (record: WorkerRecord, adoption: Adoption, now: number): WorkerState =>
  match(adoption)
    .with({ phase: "draining" }, (a) =>
      lifecycleAdt.adoptDraining(record.tenant, a.eagerPin, record.pid, record.udsPath, a.drainStartedAt))
    .with({ phase: "live" }, (a) =>
      lifecycleAdt.adoptLive(record.tenant, a.eagerPin, record.pid, record.udsPath, a.startedAt, now))
    .exhaustive();

// ── decideCrashRestart ───────────────────────────────────────────────────────

/** Charge a fresh tenant at each instant in turn; return every decision. */
const chargeAll = (
  policy: { maxRestartsPerWindow: number; restartWindowMs: number },
  instants: readonly number[],
): readonly CrashRestartDecision[] => {
  let budget: RestartBudget | undefined;
  return instants.map((now) => {
    const decision = decideCrashRestart(budget, policy, now);
    budget = decision.budget;
    return decision;
  });
};

describe("decideCrashRestart (pure)", () => {
  test("a tenant's first crash with a non-zero budget restarts and opens a window at that instant", () => {
    const d = decideCrashRestart(undefined, { maxRestartsPerWindow: 3, restartWindowMs: 1_000 }, 500);
    expect(d.action).toBe("restart");
    expect(d.budget).toEqual({ restartsInWindow: 1, windowStartedAt: 500, maxRestartsPerWindow: 3, windowMs: 1_000 });
  });

  test("a zero budget gives up on the very first crash", () => {
    expect(decideCrashRestart(undefined, { maxRestartsPerWindow: 0, restartWindowMs: 1_000 }, 0).action).toBe("give-up");
  });

  test("the prior budget, not the policy, governs once a tenant has one", () => {
    const prior: RestartBudget = { restartsInWindow: 1, windowStartedAt: 0, maxRestartsPerWindow: 1, windowMs: 1_000 };
    expect(decideCrashRestart(prior, { maxRestartsPerWindow: 50, restartWindowMs: 1_000 }, 10).action).toBe("give-up");
  });

  test("property: crashes inside one window restart exactly min(crashes, max) times", () => {
    fc.assert(
      fc.property(policyArb, instantArb, fc.array(fc.nat(), { minLength: 1, maxLength: 20 }), (policy, t0, offsets) => {
        const instants = offsets.map((o) => t0 + (o % policy.restartWindowMs)).sort((a, b) => a - b);
        const windowed = [t0, ...instants];
        const restarts = chargeAll(policy, windowed).filter((d) => d.action === "restart").length;
        expect(restarts).toBe(Math.min(windowed.length, policy.maxRestartsPerWindow));
      }),
    );
  });

  test("property: give-up is a fixpoint — the budget is unchanged and charging again still gives up", () => {
    fc.assert(
      fc.property(policyArb, instantArb, fc.integer({ min: 1, max: 20 }), (policy, now, crashes) => {
        const decisions = chargeAll(policy, Array.from({ length: crashes }, () => now));
        const last = decisions[decisions.length - 1];
        if (last === undefined || last.action !== "give-up") return;
        const again = decideCrashRestart(last.budget, policy, now);
        expect(again.action).toBe("give-up");
        expect(again.budget).toEqual(last.budget);
      }),
    );
  });

  test("property: a crash a full window after the window opened always restarts (recovery by sliding)", () => {
    fc.assert(
      fc.property(policyArb, instantArb, fc.integer({ min: 1, max: 20 }), fc.nat(), (policy, t0, crashes, extra) => {
        const decisions = chargeAll(policy, Array.from({ length: crashes }, () => t0));
        const budget = decisions[decisions.length - 1]?.budget;
        const later = t0 + policy.restartWindowMs + extra;
        const d = decideCrashRestart(budget, policy, later);
        expect(d.action).toBe("restart");
        expect(d.budget.restartsInWindow).toBe(1);
        expect(d.budget.windowStartedAt).toBe(later);
      }),
    );
  });
});

// ── workerRecordOf ───────────────────────────────────────────────────────────

describe("workerRecordOf (pure)", () => {
  test("a live state persists its spawn instant as startedAt", () => {
    const live: WorkerState = {
      phase: "live", tenant: tid("acme"), eagerPin: true, pid: 9, udsPath: "/run/fugue/acme.sock", startedAt: 10, lastActivityAt: 99,
    };
    expect(workerRecordOf(live)).toEqual({
      tenant: tid("acme"), pid: 9, udsPath: "/run/fugue/acme.sock", startedAt: 10, health: "live", eagerPin: true,
    });
  });

  test("a draining state persists its drain-start instant as startedAt", () => {
    const draining: WorkerState = {
      phase: "draining", tenant: tid("acme"), eagerPin: false, pid: 9, udsPath: "/run/fugue/acme.sock", drainStartedAt: 42,
    };
    expect(workerRecordOf(draining)).toEqual({
      tenant: tid("acme"), pid: 9, udsPath: "/run/fugue/acme.sock", startedAt: 42, health: "draining", eagerPin: false,
    });
  });

  test("property: a record exists exactly for the phases that hold a process and socket, and names that phase", () => {
    fc.assert(
      fc.property(workerStateArb, (state) => {
        const record = workerRecordOf(state);
        const holdsSocket = lifecycleAdt.udsPathOf(state) !== undefined;
        expect(record !== undefined).toBe(holdsSocket);
        if (record === undefined) return;
        expect(record.health).toBe(state.phase);
        expect(record.tenant).toBe(state.tenant);
        expect(record.eagerPin).toBe(state.eagerPin);
        expect(record.udsPath).toBe(lifecycleAdt.udsPathOf(state));
      }),
    );
  });
});

// ── decideAdoption ───────────────────────────────────────────────────────────

describe("decideAdoption (pure)", () => {
  test("the registry's eagerPin wins over the persisted one", () => {
    const record: WorkerRecord = { tenant: tid("acme"), pid: 3, udsPath: "/run/fugue/acme.sock", startedAt: 7, health: "live", eagerPin: false };
    expect(decideAdoption(record, true)).toEqual({ phase: "live", eagerPin: true, startedAt: 7 });
  });

  test("a tenant with no registry config falls back to the persisted eagerPin — never a default", () => {
    const record: WorkerRecord = { tenant: tid("acme"), pid: 3, udsPath: "/run/fugue/acme.sock", startedAt: 7, health: "draining", eagerPin: true };
    expect(decideAdoption(record, undefined)).toEqual({ phase: "draining", eagerPin: true, drainStartedAt: 7 });
  });

  test("property: an adopted worker keeps the record's health — a drained worker never becomes routable", () => {
    fc.assert(
      fc.property(workerRecordArb, fc.option(fc.boolean(), { nil: undefined }), instantArb, (record, pin, now) => {
        const state = adopt(record, decideAdoption(record, pin), now);
        expect(state.phase).toBe(record.health);
        expect(lifecycleAdt.canServe(state)).toBe(record.health === "live");
        expect(lifecycleAdt.occupiesSlot(state)).toBe(true);
        expect(state.eagerPin).toBe(pin ?? record.eagerPin);
      }),
    );
  });

  test("property: round trip — persisting an adopted worker reproduces the record it was adopted from", () => {
    fc.assert(
      fc.property(workerRecordArb, instantArb, (record, now) => {
        expect(workerRecordOf(adopt(record, decideAdoption(record, undefined), now))).toEqual(record);
      }),
    );
  });
});

// ── stopPlan ─────────────────────────────────────────────────────────────────

const allStopReasons: readonly StopReason[] = ["drain", "abort-unannounced-spawn", "abort-announced-spawn", "hard-stop"];

describe("stopPlan (pure)", () => {
  test("each stop reason has its exact signal sequence and failure severity", () => {
    expect(stopPlan("drain")).toEqual([{ sig: "SIGTERM", onFailure: "best-effort" }]);
    expect(stopPlan("abort-unannounced-spawn")).toEqual([{ sig: "SIGKILL", onFailure: "best-effort" }]);
    expect(stopPlan("abort-announced-spawn")).toEqual([{ sig: "SIGKILL", onFailure: "orphan-risk" }]);
    expect(stopPlan("hard-stop")).toEqual([
      { sig: "SIGTERM", onFailure: "best-effort" },
      { sig: "SIGKILL", onFailure: "orphan-risk" },
    ]);
  });

  test("orphan risk is only ever a failed SIGKILL, and only the final step can carry it", () => {
    for (const reason of allStopReasons) {
      const plan = stopPlan(reason);
      expect(plan.length).toBeGreaterThan(0);
      plan.forEach((step, i) => {
        if (step.onFailure !== "orphan-risk") return;
        expect(step.sig).toBe("SIGKILL");
        expect(i).toBe(plan.length - 1);
      });
    }
  });

  test("a SIGTERM is never sent after a SIGKILL — the polite signal comes first", () => {
    for (const reason of allStopReasons) {
      const sigs = stopPlan(reason).map((s) => s.sig);
      const firstKill = sigs.indexOf("SIGKILL");
      if (firstKill >= 0) expect(sigs.slice(firstKill).includes("SIGTERM")).toBe(false);
    }
  });
});
