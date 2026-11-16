/**
 * Tests for the manager's per-tenant table (worker-table.ts): slot counting,
 * replace/release, the sticky exit-watcher mark and per-tenant restart-budget
 * storage. Driven with the real pure ADT.
 */

import { describe, test, expect } from "bun:test";
import { tenantId } from "../../../domain/tenant.js";
import type { TenantId } from "../../../domain/tenant.js";
import * as lifecycleAdt from "../../../supervisor/lifecycle/worker-lifecycle.js";
import type { RestartBudget } from "../../../supervisor/lifecycle/thin-init.js";
import { createWorkerTable } from "../../../supervisor/lifecycle/worker-table.js";

const tid = (s: string): TenantId => {
  const r = tenantId(s);
  if (!r.ok) throw new Error(`bad tenant fixture ${s}`);
  return r.value;
};

const table = () => createWorkerTable(lifecycleAdt.occupiesSlot);

describe("WorkerTable", () => {
  test("a reserved spawning slot counts immediately; releasing it frees the slot", () => {
    const t = table();
    t.reserve(lifecycleAdt.requestWorker(tid("acme"), false, 0));
    expect(t.liveCount()).toBe(1);
    t.release(tid("acme"));
    expect(t.liveCount()).toBe(0);
    expect(t.get(tid("acme"))).toBeUndefined();
  });

  test("only slot-occupying phases count — a crashed entry is held but not counted", () => {
    const t = table();
    t.replace({ phase: "crashed", tenant: tid("acme"), eagerPin: false, crashedAt: 1, exitCode: 1 });
    t.replace(lifecycleAdt.adoptLive(tid("globex"), false, 4, "/run/fugue/globex.sock", 0, 0));
    expect(t.liveCount()).toBe(1);
    expect(t.get(tid("acme"))?.phase).toBe("crashed");
  });

  test("entries are filed under the state's own tenant", () => {
    const t = table();
    t.reserve(lifecycleAdt.requestWorker(tid("globex"), false, 0));
    expect(t.get(tid("globex"))?.tenant).toBe(tid("globex"));
    expect(t.get(tid("acme"))).toBeUndefined();
  });

  test("reserve supersedes a crashed entry, which then counts as a slot", () => {
    const t = table();
    t.replace({ phase: "crashed", tenant: tid("acme"), eagerPin: false, crashedAt: 1, exitCode: 1 });
    expect(t.liveCount()).toBe(0);
    t.reserve(lifecycleAdt.requestWorker(tid("acme"), false, 2));
    expect(t.get(tid("acme"))?.phase).toBe("spawning");
    expect(t.liveCount()).toBe(1);
  });

  test("replace over a live entry changes its phase without changing the count", () => {
    const t = table();
    const live = lifecycleAdt.adoptLive(tid("acme"), false, 4, "/run/fugue/acme.sock", 0, 0);
    t.replace(live);
    const draining = lifecycleAdt.beginDrain(live, 5);
    if (!draining.ok) throw new Error("fixture: beginDrain on a live state");
    t.replace(draining.value);
    expect(t.get(tid("acme"))?.phase).toBe("draining");
    expect(t.liveCount()).toBe(1);
  });

  test("snapshot is a copy — releasing during iteration does not disturb it", () => {
    const t = table();
    t.replace(lifecycleAdt.requestWorker(tid("acme"), false, 0));
    t.replace(lifecycleAdt.requestWorker(tid("globex"), false, 0));
    const seen: TenantId[] = [];
    for (const [tenant] of t.snapshot()) {
      t.release(tid("globex"));
      seen.push(tenant);
    }
    expect(seen).toEqual([tid("acme"), tid("globex")]);
  });

  test("the watched mark is sticky — releasing the tenant's entry keeps it watched", () => {
    const t = table();
    expect(t.isWatched(tid("acme"))).toBe(false);
    t.markWatched(tid("acme"));
    t.release(tid("acme"));
    expect(t.isWatched(tid("acme"))).toBe(true);
  });

  test("chargeRestart hands the decision the tenant's prior budget and stores the one it returns", () => {
    const t = table();
    const budget = (n: number): RestartBudget => ({ restartsInWindow: n, windowStartedAt: 0, maxRestartsPerWindow: 3, windowMs: 10 });
    const priors: Array<RestartBudget | undefined> = [];
    const charge = (prior: RestartBudget | undefined) => {
      priors.push(prior);
      return { action: "restart" as const, budget: budget((prior?.restartsInWindow ?? 0) + 1) };
    };
    t.chargeRestart(tid("acme"), charge);
    const second = t.chargeRestart(tid("acme"), charge);
    t.chargeRestart(tid("globex"), charge);
    expect(priors).toEqual([undefined, budget(1), undefined]);
    expect(second.budget).toEqual(budget(2));
  });
});
