/**
 * Tests for the worker-lifecycle functional core (worker-lifecycle-decisions.ts):
 * spawn clearance, the drain kill deadline, the crash-restart budget, the
 * durable-record derivation, the adopted state, the stop-signal plans and the
 * spawn-env composition. Pure functions over plain data — no fakes,
 * no clock; fast-check properties for the invariants, examples for the tables.
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import * as lifecycleAdt from "../../../supervisor/lifecycle/worker-lifecycle.js";
import type { WorkerState } from "../../../supervisor/lifecycle/worker-lifecycle.js";
import type { WorkerRecord } from "../../../supervisor/lifecycle/worker-registry-redis.js";
import type { RestartBudget } from "../../../supervisor/lifecycle/thin-init.js";
import {
  spawnClearance,
  decideCrashRestart,
  workerRecordOf,
  drainOverdue,
  adoptedState,
  stopPlan,
  composeSpawnEnv,
  MAX_QUEUED_RUNS_ENV,
  DAGS_LOCAL_PATH_ENV,
  type CrashRestartDecision,
  type StopReason,
  type SpawnEnvSources,
} from "../../../supervisor/lifecycle/worker-lifecycle-decisions.js";
import { WORKER_REDIS_ACL_USERNAME_ENV, WORKER_REDIS_ACL_PASSWORD_ENV } from "../../../supervisor/secrets/redis-acl.js";
import type { AppliedAclCredential } from "../../../supervisor/secrets/redis-acl-provisioner.js";

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

type DrainingState = Extract<WorkerState, { readonly phase: "draining" }>;

const drainingStateArb: fc.Arbitrary<DrainingState> = fc.record({
  phase: fc.constant("draining" as const), tenant: tenantArb, eagerPin: fc.boolean(), pid: pidArb, udsPath: udsArb,
  drainStartedAt: instantArb,
});

const workerStateArb: fc.Arbitrary<WorkerState> = fc.oneof(
  fc.record({ phase: fc.constant("spawning" as const), tenant: tenantArb, eagerPin: fc.boolean(), requestedAt: instantArb }),
  fc.record({
    phase: fc.constant("live" as const), tenant: tenantArb, eagerPin: fc.boolean(), pid: pidArb, udsPath: udsArb,
    startedAt: instantArb, lastActivityAt: instantArb,
  }),
  drainingStateArb,
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

// ── spawnClearance ───────────────────────────────────────────────────────────

describe("spawnClearance (pure)", () => {
  test("a tenant with no entry is clear to spawn", () => {
    expect(spawnClearance(undefined)).toEqual({ kind: "clear" });
  });

  test("a draining worker blocks its replacement", () => {
    const draining: WorkerState = {
      phase: "draining", tenant: tid("acme"), eagerPin: false, pid: 9, udsPath: "/run/fugue/acme.sock", drainStartedAt: 1,
    };
    expect(spawnClearance(draining)).toEqual({ kind: "blocked", by: "draining" });
  });

  test("property: a spawn is blocked exactly while the entry still holds the tenant's socket, and names its phase", () => {
    fc.assert(
      fc.property(workerStateArb, (state) => {
        const clearance = spawnClearance(state);
        const holdsSocket = lifecycleAdt.udsPathOf(state) !== undefined;
        expect(clearance.kind === "blocked").toBe(holdsSocket);
        if (clearance.kind === "blocked") expect(clearance.by).toBe(state.phase);
      }),
    );
  });
});

// ── drainOverdue ─────────────────────────────────────────────────────────────

describe("drainOverdue (pure)", () => {
  const draining = (drainStartedAt: number): DrainingState => ({
    phase: "draining", tenant: tid("acme"), eagerPin: false, pid: 9, udsPath: "/run/fugue/acme.sock", drainStartedAt,
  });

  test("a drain is overdue from exactly its kill deadline, not before", () => {
    expect(drainOverdue(draining(100), 1_000, 1_099)).toBe(false);
    expect(drainOverdue(draining(100), 1_000, 1_100)).toBe(true);
  });

  test("property: a draining worker is overdue exactly once its drain age reaches the kill deadline", () => {
    fc.assert(
      fc.property(drainingStateArb, fc.integer({ min: 1, max: 100_000 }), instantArb, (state, killAfterMs, now) => {
        expect(drainOverdue(state, killAfterMs, now)).toBe(now - state.drainStartedAt >= killAfterMs);
      }),
    );
  });

  test("property: overdue is monotone in time — once overdue, a later instant stays overdue", () => {
    fc.assert(
      fc.property(drainingStateArb, fc.integer({ min: 1, max: 100_000 }), instantArb, fc.nat(), (state, killAfterMs, now, later) => {
        if (drainOverdue(state, killAfterMs, now)) expect(drainOverdue(state, killAfterMs, now + later)).toBe(true);
      }),
    );
  });
});

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

// ── adoptedState ─────────────────────────────────────────────────────────────

describe("adoptedState (pure)", () => {
  test("the registry's eagerPin wins over the persisted one", () => {
    const record: WorkerRecord = { tenant: tid("acme"), pid: 3, udsPath: "/run/fugue/acme.sock", startedAt: 7, health: "live", eagerPin: false };
    expect(adoptedState(record, true, 0).eagerPin).toBe(true);
  });

  test("a tenant with no registry config falls back to the persisted eagerPin — never a default", () => {
    const record: WorkerRecord = { tenant: tid("acme"), pid: 3, udsPath: "/run/fugue/acme.sock", startedAt: 7, health: "draining", eagerPin: true };
    expect(adoptedState(record, undefined, 0).eagerPin).toBe(true);
  });

  test("property: an adopted worker keeps the record's health — a drained worker never becomes routable", () => {
    fc.assert(
      fc.property(workerRecordArb, fc.option(fc.boolean(), { nil: undefined }), instantArb, (record, pin, now) => {
        const state = adoptedState(record, pin, now);
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
        expect(workerRecordOf(adoptedState(record, undefined, now))).toEqual(record);
      }),
    );
  });

  test("a live adoption seeds its idle clock from now; a draining adoption carries the drain-start instant", () => {
    const base = { tenant: tid("acme"), pid: 3, udsPath: "/run/fugue/acme.sock", startedAt: 7, eagerPin: false } as const;
    expect(adoptedState({ ...base, health: "live" }, undefined, 50)).toEqual({
      phase: "live", tenant: tid("acme"), eagerPin: false, pid: 3, udsPath: "/run/fugue/acme.sock", startedAt: 7, lastActivityAt: 50,
    });
    expect(adoptedState({ ...base, health: "draining" }, true, 50)).toEqual({
      phase: "draining", tenant: tid("acme"), eagerPin: true, pid: 3, udsPath: "/run/fugue/acme.sock", drainStartedAt: 7,
    });
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

// ── composeSpawnEnv ──────────────────────────────────────────────────────────

const ACL_USER = WORKER_REDIS_ACL_USERNAME_ENV;
const ACL_PASS = WORKER_REDIS_ACL_PASSWORD_ENV;
const PLATFORM_KEYS: readonly string[] = [ACL_USER, ACL_PASS, MAX_QUEUED_RUNS_ENV, DAGS_LOCAL_PATH_ENV];

const envKeyArb = fc.oneof(fc.constantFrom(...PLATFORM_KEYS, "LOG_LEVEL", "FEATURE_X"), fc.stringMatching(/^[A-Z][A-Z_]{0,11}$/));
const envArb = fc.dictionary(envKeyArb, fc.string({ maxLength: 12 }));
const sourcesArb: fc.Arbitrary<SpawnEnvSources> = fc.record(
  {
    dagsRoot: fc.constantFrom("/dags/acme", "/dags/acme/releases/current"),
    maxQueuedRuns: fc.nat({ max: 10_000 }),
    extraEnv: envArb,
  },
  { requiredKeys: [] },
);
const credArb: fc.Arbitrary<AppliedAclCredential | undefined> = fc.option(
  fc.record({ username: fc.constantFrom("fugue-acme"), password: fc.string({ minLength: 1, maxLength: 16 }) }),
  { nil: undefined },
);

describe("composeSpawnEnv (pure)", () => {
  const cred: AppliedAclCredential = { username: "fugue-acme", password: "s3cret" };

  test.each([
    ["nothing applies → no extraEnv at all", {}, undefined, undefined],
    ["only the tenant's extraEnv → that record as is", { extraEnv: { LOG_LEVEL: "debug" } }, undefined, { LOG_LEVEL: "debug" }],
    ["an empty extraEnv alone is passed through", { extraEnv: {} }, undefined, {}],
    ["dagsRoot → DAGS_LOCAL_PATH", { dagsRoot: "/dags/acme" }, undefined, { DAGS_LOCAL_PATH: "/dags/acme" }],
    ["maxQueuedRuns → FUGUE_MAX_QUEUED_RUNS (0 is a ceiling, not absence)", { maxQueuedRuns: 0 }, undefined, { FUGUE_MAX_QUEUED_RUNS: "0" }],
    ["an ACL credential → both ACL vars", {}, cred, { [ACL_USER]: "fugue-acme", [ACL_PASS]: "s3cret" }],
    [
      "every platform binding wins over a colliding extraEnv key",
      {
        dagsRoot: "/dags/acme",
        maxQueuedRuns: 7,
        extraEnv: { DAGS_LOCAL_PATH: "/etc", FUGUE_MAX_QUEUED_RUNS: "999", [ACL_USER]: "default", [ACL_PASS]: "x", KEEP: "1" },
      },
      cred,
      { DAGS_LOCAL_PATH: "/dags/acme", FUGUE_MAX_QUEUED_RUNS: "7", [ACL_USER]: "fugue-acme", [ACL_PASS]: "s3cret", KEEP: "1" },
    ],
  ] as const)("%s", (_name, sources: SpawnEnvSources, acl: AppliedAclCredential | undefined, expected) => {
    expect(composeSpawnEnv(sources, acl)).toEqual(expected);
  });

  test("with only an extraEnv the same record is returned (no copy)", () => {
    const extraEnv = { LOG_LEVEL: "debug" };
    expect(composeSpawnEnv({ extraEnv }, undefined)).toBe(extraEnv);
  });

  test("property: every present source sets its key, an absent one adds none, and platform values win", () => {
    fc.assert(
      fc.property(sourcesArb, credArb, (sources, acl) => {
        const env = composeSpawnEnv(sources, acl);
        const platform: Record<string, string | undefined> = {
          [DAGS_LOCAL_PATH_ENV]: sources.dagsRoot,
          [MAX_QUEUED_RUNS_ENV]: sources.maxQueuedRuns === undefined ? undefined : String(sources.maxQueuedRuns),
          [ACL_USER]: acl?.username,
          [ACL_PASS]: acl?.password,
        };
        const anyPlatform = Object.values(platform).some((v) => v !== undefined);
        if (!anyPlatform) {
          expect(env).toBe(sources.extraEnv);
          return;
        }
        if (env === undefined) throw new Error("a platform binding applies, so an env must exist");
        for (const [key, value] of Object.entries(platform)) {
          if (value !== undefined) expect(env[key]).toBe(value);
          else expect(env[key]).toBe(sources.extraEnv?.[key]);
        }
        // Every non-platform key is the tenant's own, unchanged.
        for (const [key, value] of Object.entries(env)) {
          if (!PLATFORM_KEYS.includes(key)) expect(value).toBe(sources.extraEnv?.[key]);
        }
      }),
    );
  });

  test("property: composing never mutates the tenant's extraEnv", () => {
    fc.assert(
      fc.property(sourcesArb, credArb, (sources, acl) => {
        const before = JSON.stringify(sources.extraEnv);
        composeSpawnEnv(sources, acl);
        expect(JSON.stringify(sources.extraEnv)).toBe(before);
      }),
    );
  });
});
