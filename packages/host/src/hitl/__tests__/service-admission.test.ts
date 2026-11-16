// service-admission.test.ts — the HITL queue-depth admission policy (ADR-0074).
//
// The policy is resolved once at service construction (`queuedRunAdmission`)
// and decided purely (`decideQueuedRunAdmission`); the service only reads the
// active-run count for a `bounded` policy. End-to-end gate behaviour against the
// real kernel lives in service.test.ts ("per-tenant maxQueuedRuns gate").

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { ok, err, runId as mkRunId } from "@fuguejs/framework";
import type { DagId } from "@fuguejs/framework";
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import { markTeam } from "../../domain/auth.js";
import { retryAfterSeconds as parseRetryAfter, tenantOverQuota } from "../../domain/host-error.js";
import type { RunExecutorPort, RunQueuePort, DecisionStorePort, HumanReviewNotifierPort } from "../ports.js";
import { createInMemoryRunLeaseAuthority, createInMemoryRunStore } from "../adapters/run-store.js";
import {
  createHitlRunService,
  decideQueuedRunAdmission,
  queuedRunAdmission,
  DEFAULT_QUEUED_RUN_RETRY_AFTER_SECONDS,
} from "../service.js";

const tid = (s: string): TenantId => {
  const t = tenantId(s);
  if (!t.ok) throw new Error(`bad tenant fixture ${s}`);
  return t.value;
};

const TENANT = tid("acme-prod");

// Generators (valid domain values only).
const tenantArb = fc.constantFrom("acme-prod", "globex", "initech").map(tid);
const countArb = fc.nat({ max: 10_000 });
const retryArb = fc.integer({ min: 1, max: 3_600 });

describe("queuedRunAdmission — defaults resolved once at construction", () => {
  it("an unset ceiling is `unlimited`, whatever Retry-After is configured", () => {
    fc.assert(
      fc.property(tenantArb, fc.option(retryArb, { nil: undefined }), (tenant, retryAfterSeconds) => {
        const policy = queuedRunAdmission({
          tenant,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
        expect(policy).toEqual({ kind: "unlimited" });
      }),
    );
  });

  it("a set ceiling is `bounded` with the configured Retry-After, or the default when unset", () => {
    fc.assert(
      fc.property(tenantArb, countArb, fc.option(retryArb, { nil: undefined }), (tenant, maxQueuedRuns, retryAfterSeconds) => {
        const policy = queuedRunAdmission({
          tenant,
          maxQueuedRuns,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
        expect(policy).toEqual({
          kind: "bounded",
          tenant,
          maxQueuedRuns,
          retryAfterSeconds: parseRetryAfter(retryAfterSeconds ?? DEFAULT_QUEUED_RUN_RETRY_AFTER_SECONDS),
        });
      }),
    );
    expect(DEFAULT_QUEUED_RUN_RETRY_AFTER_SECONDS).toBe(5);
  });

  it("a malformed Retry-After is refused at construction, not at the first refusal", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => queuedRunAdmission({ tenant: TENANT, maxQueuedRuns: 1, retryAfterSeconds: bad })).toThrow(RangeError);
    }
    // An unlimited policy never advertises a Retry-After, so it has nothing to parse.
    expect(queuedRunAdmission({ tenant: TENANT, retryAfterSeconds: -1 })).toEqual({ kind: "unlimited" });
  });
});

describe("decideQueuedRunAdmission — the bounded gate", () => {
  const parsedRetryArb = retryArb.map(parseRetryAfter);

  it("admits exactly while the active count is below the ceiling", () => {
    fc.assert(
      fc.property(tenantArb, countArb, countArb, parsedRetryArb, (tenant, maxQueuedRuns, active, retryAfterSeconds) => {
        const decision = decideQueuedRunAdmission({ kind: "bounded", tenant, maxQueuedRuns, retryAfterSeconds }, active);
        expect(decision.ok).toBe(active < maxQueuedRuns);
      }),
    );
  });

  it("a refusal is the tenant's OWN tenant-over-quota carrying the policy's Retry-After", () => {
    fc.assert(
      fc.property(tenantArb, countArb, fc.nat({ max: 100 }), parsedRetryArb, (tenant, maxQueuedRuns, over, retryAfterSeconds) => {
        const decision = decideQueuedRunAdmission(
          { kind: "bounded", tenant, maxQueuedRuns, retryAfterSeconds },
          maxQueuedRuns + over,
        );
        expect(decision.ok).toBe(false);
        if (!decision.ok) {
          expect(decision.error).toMatchObject({ kind: "tenant-over-quota", tenant, retryAfterSeconds });
        }
      }),
    );
  });
});

describe("createHitlRunService — admission I/O", () => {
  const harness = (limits: { readonly maxQueuedRuns?: number; readonly retryAfterSeconds?: number }) => {
    const leases = createInMemoryRunLeaseAuthority();
    const store = createInMemoryRunStore(leases, () => 1_000);
    let counts = 0;
    let activeOverride: number | undefined;
    const runStore = {
      ...store,
      countActiveRuns: async () => {
        counts++;
        return activeOverride === undefined ? store.countActiveRuns() : ok(activeOverride);
      },
    };
    const runQueue: RunQueuePort = { enqueue: async () => ok(undefined) };
    const unused = (): never => { throw new Error("not reached by startRun"); };
    const decisions: DecisionStorePort = {
      preparePending: unused,
      markNotified: unused,
      resolvePending: unused,
      getDecision: unused,
      clear: unused,
    };
    const notifier: HumanReviewNotifierPort = { notify: unused };
    const executor: RunExecutorPort = {
      seedCheckpoint: async () => ok("{}"),
      run: unused,
    };
    let n = 0;
    const service = createHitlRunService({
      runStore,
      runQueue,
      decisions,
      notifier,
      executor,
      clock: () => 1_000,
      newRunId: () => mkRunId(`run-${++n}`),
      tenant: TENANT,
      ...limits,
    });
    const start = () => service.startRun("test-dag" as DagId, markTeam("team"), null, { kind: "admin" });
    return {
      start,
      counts: () => counts,
      setActive: (value: number) => { activeOverride = value; },
    };
  };

  it("an unlimited service never reads the active-run count", async () => {
    const h = harness({});
    for (let i = 0; i < 3; i++) expect((await h.start()).ok).toBe(true);
    expect(h.counts()).toBe(0);
  });

  it("a bounded service reads the count once per start and refuses with the default Retry-After", async () => {
    const h = harness({ maxQueuedRuns: 2 });
    h.setActive(2);
    const refused = await h.start();
    expect(h.counts()).toBe(1);
    expect(refused).toEqual(err(tenantOverQuota(TENANT, 5)));
  });

  it("a configured Retry-After reaches the refusal", async () => {
    const h = harness({ maxQueuedRuns: 0, retryAfterSeconds: 42 });
    const refused = await h.start();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ kind: "tenant-over-quota", retryAfterSeconds: 42 });
  });
});
