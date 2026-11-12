// map-fan-concurrency — the fan shell (`runMappedFan`) as an interpreter of
// the LC-1 machine, driven through the deterministic deferred-child harness
// (F1 PR-D T10). Every test settles children by hand, so completion order,
// drain timing and abort timing are exact; no real timers are involved.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { z } from "zod";
import { InMemoryCheckpointer, type Checkpointer } from "../checkpoint/checkpointer.js";
import { defineDag, runDag } from "../executor/index.js";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createFileCheckpointer } from "../file/checkpointer.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createMapNode } from "../nodes/map.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { __resetFrameworkTracer, setFrameworkTracer } from "../tracing/global-tracer.js";
import {
  FAN_SPAN_CLAMPED,
  FAN_SPAN_EFFECTIVE_CONCURRENCY,
  FAN_SPAN_SEEDED,
} from "../dag-runtime/run-mapped-fan.js";
import { frameworkError } from "../types/error-factories.js";
import { formatFrameworkError, type FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import { FanRefusalSeedSchema, fanConcurrencyCap } from "../types/fan-scheduling.js";
import { DAG_INPUT, dagId, nodeId } from "../types/ids.js";
import { err, ok } from "../types/result.js";
import {
  FAN,
  RUN,
  START_MS,
  callsCeiling,
  childError,
  cost,
  crashChild,
  drive,
  errorOf,
  failChild,
  fanHarness,
  okChild,
  presave,
  quiesce,
  range,
  refusalOf,
  scriptedBudget,
  tenfold,
  type ChildPlan,
} from "./fan-test-harness.js";

/** The variable-cost sequential fixture: three 1-call children, then a 4-call one breaches. */
const COSTS = [1, 1, 1, 4, 1, 1];
const refusingFan = (cp?: Checkpointer) => {
  const budget = scriptedBudget([callsCeiling(12)]);
  const h = fanHarness({ width: COSTS.length, budget, ...(cp !== undefined ? { checkpointer: cp } : {}) });
  return { h, budget };
};
const costed = (i: number) => okChild(i * 10, cost({ calls: COSTS[i] ?? 1 }));

describe("bounded concurrency (FR-003, AS-002)", () => {
  it("AS-002: N equal-latency children at concurrency C finish in ceil(N/C) rounds", async () => {
    const h = fanHarness({ width: 10, childConcurrency: 3 });
    const run = h.start();
    let rounds = 0;
    for (;;) {
      await quiesce();
      if (h.returned) break;
      rounds += 1;
      for (const i of h.openIndices()) h.settle(i, tenfold(i));
    }
    expect(rounds).toBe(Math.ceil(10 / 3));
    expect(await run).toEqual(ok(range(10)));
    expect(h.maxInFlight).toBe(3);
    expect(h.pendingAtReturn).toBe(0);
  });

  for (const [width, c] of [[1, 4], [4, 4], [9, 2], [7, 5], [6, 1]] as const) {
    it(`FR-003: never more than C=${c} of ${width} children in flight, reverse completion`, async () => {
      const h = fanHarness({ width, childConcurrency: c });
      const run = h.start();
      expect(await drive(h, run, tenfold, (open) => open.at(-1) ?? -1)).toEqual(ok(range(width)));
      expect(h.maxInFlight).toBe(Math.min(c, width));
      expect(h.dispatched).toEqual(range(width, (i) => i));
    });
  }
});

describe("index-ordered reduce and replay (FR-005, FR-006, FR-007)", () => {
  it("AS-003: children completing out of index order reduce in index order", async () => {
    const h = fanHarness({ width: 6, childConcurrency: 4 });
    const run = h.start();
    expect(await drive(h, run, tenfold, (open) => open.at(-1) ?? -1)).toEqual(ok(range(6)));
    expect(h.reductions).toEqual([range(6)]);
    const settles = h.trace.filter((t) => t.startsWith("settle:"));
    expect(settles).not.toEqual([...settles].sort());
  });

  it("AS-005: indices saved for the current epoch replay at C>1 and are never re-dispatched", async () => {
    const cp = new InMemoryCheckpointer();
    await presave(cp, [1, 3], (i) => i * 10);
    // A completion of ANOTHER epoch is not this epoch's completion (FR-007).
    await presave(cp, [2], () => 999, 1);
    const h = fanHarness({ width: 6, childConcurrency: 3, checkpointer: cp });
    const run = h.start();
    expect(await drive(h, run, tenfold)).toEqual(ok(range(6)));
    expect(h.dispatched).toEqual([0, 2, 4, 5]);
    expect(h.trace.filter((t) => t.startsWith("save:")).sort()).toEqual(
      ["save:dag@fan@0@0", "save:dag@fan@2@0", "save:dag@fan@4@0", "save:dag@fan@5@0"]);
    expect(h.trace).not.toContain("setMeta");
    expect(h.eventsOf("fan-start")[0]).toMatchObject({ replayed: 2, width: 6 });
  });

  it("a saved entry the child schema rejects is a validation failure of that index, not a reduce", async () => {
    const cp = new InMemoryCheckpointer();
    await presave(cp, [0], () => "not-a-number");
    const h = fanHarness({ width: 3, childConcurrency: 2, checkpointer: cp });
    const run = h.start();
    const error = errorOf(await drive(h, run, tenfold));
    expect(error).toMatchObject({ kind: "validation", nodeId: FAN });
    expect(error.kind === "validation" && error.message).toContain("checkpoint replay rejected for fan index 0");
    expect(h.reductions).toEqual([]);
    expect(h.pendingAtReturn).toBe(0);
  });

  it("AS-006: a corrupt entry refuses the whole fan at C>1 before any dispatch", async () => {
    const meta = { dagId: dagId("outer"), startedAt: new Date(START_MS), nodeCount: 4 };
    const h = fanHarness({
      width: 4,
      childConcurrency: 4,
      checkpointer: {
        load: async () => ok({ meta, nodes: {}, corruptNodeAddresses: [{ kind: "node-key", nodeKey: "dag@fan@2@0" }] }),
        setMeta: async () => ok(undefined),
        saveNode: async () => ok(undefined),
      },
    });
    expect(errorOf(await h.start())).toMatchObject({ kind: "checkpoint-corrupt", nodeId: FAN });
    expect(h.dispatched).toEqual([]);
    expect(h.trace).toEqual(["load", "return"]);
    expect(h.events).toEqual([]);
  });
});

describe("child retry stays inside the child (FR-009)", () => {
  it("AS-007: a retryable child failure retries in the same epoch and the fan never drains", async () => {
    const attempts = new Map<number, number>();
    const work = createFetchNode({
      id: "work", inputSchema: z.number(), outputSchema: z.number(),
      fetch: async (n) => {
        const seen = (attempts.get(n) ?? 0) + 1;
        attempts.set(n, seen);
        return n === 1 && seen === 1 ? err({ kind: "transient", nodeId: nodeId("work"), message: "retry me" }) : ok(n * 10);
      },
    });
    const child = defineDag({ id: "child", nodes: { work: { ...work, retry: { backoffMs: [0], jitterRatio: 0 } } },
      edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work", defaultRetryLimit: 1 });
    const fan = createMapNode({ id: "fan", inputSchema: z.object({ items: z.array(z.number()) }), outputSchema: z.array(z.number()),
      widthFrom: "items", maxWidth: 8, child, childOutputSchema: z.number(), childConcurrency: 2, reduce: (xs) => ok([...xs]) });
    const outer = defineDag({ id: "outer", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
    const cp = new InMemoryCheckpointer();
    const result = await runDag(outer, { items: [0, 1, 2, 3] },
      makeNodeContext({ runId: RUN, dagId: "outer", capabilities: { checkpointer: cp } }));
    expect(result).toEqual(ok([0, 10, 20, 30]));
    expect([...attempts.entries()].sort(([a], [b]) => a - b)).toEqual([[0, 1], [1, 2], [2, 1], [3, 1]]);
    const loaded = await cp.load(RUN);
    expect(loaded.ok && Object.keys(loaded.value?.nodes ?? {}).sort()).toEqual(
      ["dag@fan@0@0", "dag@fan@1@0", "dag@fan@2@0", "dag@fan@3@0"]);
  });
});

describe("projection refusal (FR-010..FR-016, AS-010..AS-013)", () => {
  it("AS-010: once the probe settled, a projection breach dispatches nothing more and refuses", async () => {
    const { h } = refusingFan();
    const run = h.start();
    const error = errorOf(await drive(h, run, costed));
    expect(h.dispatched).toEqual([0, 1, 2, 3]);
    expect(error.kind).toBe("fan-budget-refused");
    expect(h.reductions).toEqual([]);
    expect(h.pendingAtReturn).toBe(0);
    // The probe (index 0) is unprojected; indices 1..3 were each admitted, then 4 refused.
    expect(h.eventsOf("fan-projection").map((e) => e.verdict)).toEqual(["admit", "admit", "admit", "refuse"]);
  });

  it("AS-011: the refusal carries every FR-014 field and the redeploy hint", async () => {
    const { h } = refusingFan();
    const run = h.start();
    const result = await drive(h, run, costed);
    expect(errorOf(result)).toMatchObject({ kind: "fan-budget-refused", nodeId: FAN });
    expect(refusalOf(result)).toMatchObject({
      axis: "calls",
      ceiling: { kind: "calls", limit: 12 },
      perChildEstimate: 4,
      estimatorApplied: "largest-seen",
      effectiveConcurrency: 1,
      completed: 4,
      remaining: 2,
      lowerBound: false,
      scopePath: [],
    });
    expect(refusalOf(result).hint).toContain("redeploy");
  });

  it("AS-012: the refusal is a distinct outcome kind with a self-contained structured event", async () => {
    const { h } = refusingFan();
    const run = h.start();
    const error = errorOf(await drive(h, run, costed));
    expect(["node-crash", "llm-budget-exceeded", "aborted", "fan-child-failed"]).not.toContain(error.kind);
    const refused = h.eventsOf("fan-refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      runId: RUN, dagId: "outer", nodeId: FAN, sticky: false, attachedToChildFailure: false,
      refusal: { effectiveConcurrency: 1, perChildEstimate: 4, estimatorApplied: "largest-seen", axis: "calls",
        ceiling: { kind: "calls", limit: 12 }, completed: 4, remaining: 2 },
    });
    expect(h.eventsOf("fan-projection").at(-1)).toMatchObject({
      nodeId: FAN, verdict: "refuse", axis: "calls", estimate: 4, remainingChildren: 2, effectiveConcurrency: 1,
    });
  });

  it("FR-026: a refusal persists its seed for the current epoch before returning", async () => {
    const { h } = refusingFan();
    const run = h.start();
    await drive(h, run, costed);
    const seedSave = h.trace.indexOf("save:fan-seed@fan@0@0");
    expect(seedSave).toBeGreaterThan(-1);
    expect(seedSave).toBeLessThan(h.trace.indexOf("return"));
    const loaded = await h.checkpointer.load(RUN);
    const stored = loaded.ok ? loaded.value?.nodes["fan-seed@fan@0@0"] : undefined;
    const seed = FanRefusalSeedSchema.parse(stored?.output);
    expect(seed.samples.map((s) => s.calls)).toEqual([1, 1, 1, 4]);
    expect(seed.ceilings).toEqual([{ kind: "calls", limit: 12 }]);
    expect(seed.refusal.completed).toBe(4);
  });

  it("AS-013: children in flight at the refusal finish, are saved, and count as completed", async () => {
    const budget = scriptedBudget([callsCeiling(10)]);
    const h = fanHarness({ width: 6, childConcurrency: 2, budget });
    const run = h.start();
    await quiesce();
    expect(h.openIndices()).toEqual([0, 1]);
    h.settle(0, okChild(0, cost({ calls: 4 })));
    await quiesce();
    // Projected 5 × 4 > 6 left: refused, so nothing new starts — but index 1 is still running.
    expect(h.openIndices()).toEqual([1]);
    expect(h.returned).toBe(false);
    h.settle(1, okChild(10, cost({ calls: 1 })));
    expect(refusalOf(await run)).toMatchObject({ completed: 2, remaining: 4 });
    expect(h.trace).toContain("save:dag@fan@1@0");
    expect(h.dispatched).toEqual([0, 1]);
    expect(h.pendingAtReturn).toBe(0);
  });

  it("seed-save failure fails closed with the typed write error, and the refusal is still emitted", async () => {
    const twin = refusingFan().h;
    const displaced = errorOf(await drive(twin, twin.start(), costed));
    expect(displaced.kind).toBe("fan-budget-refused");
    const writeFailed = frameworkError.checkpointWriteFailed(RUN, FAN, "seed store unavailable");
    const budget = scriptedBudget([callsCeiling(12)]);
    const h = fanHarness({ width: COSTS.length, budget,
      failSave: (key) => (key.startsWith("fan-seed@") ? writeFailed : undefined) });
    const run = h.start();
    expect(await drive(h, run, costed)).toEqual(err(writeFailed));
    expect(h.eventsOf("fan-refused")).toHaveLength(1);
    // The write error displaces the refusal, so the log must carry it whole.
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain(`map fan "${FAN}"`);
    expect(h.errors[0]).toContain(formatFrameworkError(displaced));
    expect(h.pendingAtReturn).toBe(0);
  });
});

describe("drain on terminal failure (FR-020, FR-021, AS-019..AS-021)", () => {
  it("AS-019: a terminal failure stops dispatch; in-flight children finish and are saved", async () => {
    const h = fanHarness({ width: 8, childConcurrency: 3 });
    const run = h.start();
    await quiesce();
    expect(h.openIndices()).toEqual([0, 1, 2]);
    h.settle(1, failChild(childError(1)));
    await quiesce();
    expect(h.openIndices()).toEqual([0, 2]);
    expect(h.returned).toBe(false);
    h.settle(2, tenfold(2));
    await quiesce();
    expect(h.returned).toBe(false);
    h.settle(0, tenfold(0));
    // One failure and no refusal: the bare child error, exactly as the sequential fan returns it.
    expect(await run).toEqual(err(childError(1)));
    expect(h.dispatched).toEqual([0, 1, 2]);
    expect(h.trace).toContain("save:dag@fan@0@0");
    expect(h.trace).toContain("save:dag@fan@2@0");
    expect(h.reductions).toEqual([]);
    expect(h.pendingAtReturn).toBe(0);
  });

  it("AS-020: several failures during the drain — lowest index primary, the rest secondary", async () => {
    const h = fanHarness({ width: 6, childConcurrency: 3 });
    const run = h.start();
    await quiesce();
    h.settle(2, failChild(childError(2)));
    await quiesce();
    h.settle(1, failChild(childError(1)));
    await quiesce();
    h.settle(0, tenfold(0));
    const error = errorOf(await run);
    expect(error).toMatchObject({
      kind: "fan-child-failed", nodeId: FAN,
      primary: { index: 1, error: childError(1) },
      causes: { kind: "secondaries", secondary: [{ index: 2, error: childError(2) }] },
    });
  });

  it("AS-021: a lower-index failure observed AFTER a higher-index one is still primary", async () => {
    const h = fanHarness({ width: 5, childConcurrency: 3 });
    const run = h.start();
    await quiesce();
    h.settle(2, failChild(childError(2)));
    await quiesce();
    h.settle(0, failChild(childError(0)));
    await quiesce();
    h.settle(1, failChild(childError(1)));
    const error = errorOf(await run);
    expect(error).toMatchObject({
      kind: "fan-child-failed",
      primary: { index: 0 },
      causes: { kind: "secondaries", secondary: [{ index: 1 }, { index: 2 }] },
    });
  });

  it("a rejected slot promise becomes a non-retriable node-crash for that index", async () => {
    const h = fanHarness({ width: 4, childConcurrency: 2 });
    const run = h.start();
    await quiesce();
    h.settle(1, crashChild(new Error("child exploded")));
    await quiesce();
    h.settle(0, tenfold(0));
    const error = errorOf(await run);
    expect(error).toMatchObject({ kind: "node-crash", nodeId: FAN, retriability: "non-retriable" });
    expect(error.kind === "node-crash" && error.message).toContain("fan index 1");
    expect(h.pendingAtReturn).toBe(0);
  });

  it("FR-050: drain-saved outputs are reused by a later run of the same epoch (0 re-dispatch)", async () => {
    const cp = new InMemoryCheckpointer();
    const first = fanHarness({ width: 6, childConcurrency: 3, checkpointer: cp });
    const run = first.start();
    await quiesce();
    first.settle(1, failChild(childError(1)));
    await quiesce();
    first.settle(0, tenfold(0));
    first.settle(2, tenfold(2));
    await run;
    const resumed = fanHarness({ width: 6, childConcurrency: 3, checkpointer: cp, auto: tenfold });
    expect(await resumed.start()).toEqual(ok(range(6)));
    expect(resumed.dispatched).toEqual([1, 3, 4, 5]);
  });
});

describe("mixed drain (FR-025)", () => {
  it("a refusal plus a child failure: lowest failure primary, refusal attached, event still emitted", async () => {
    const budget = scriptedBudget([callsCeiling(10)]);
    const h = fanHarness({ width: 6, childConcurrency: 2, budget });
    const run = h.start();
    await quiesce();
    h.settle(0, okChild(0, cost({ calls: 4 })));
    await quiesce();
    h.settle(1, failChild(childError(1), cost({ calls: 1 })));
    const error = errorOf(await run);
    expect(error).toMatchObject({
      kind: "fan-child-failed",
      primary: { index: 1, error: childError(1) },
      causes: { kind: "refusal", refusal: { axis: "calls", completed: 1, remaining: 5, effectiveConcurrency: 2 } },
    });
    expect(h.eventsOf("fan-refused")).toEqual([expect.objectContaining({ attachedToChildFailure: true, sticky: false })]);
    expect(h.trace).toContain("save:fan-seed@fan@0@0");
    expect(h.pendingAtReturn).toBe(0);
  });

  describe("a failed seed save never hides the child failures it displaces (FR-025, FR-026)", () => {
    const writeFailed = frameworkError.checkpointWriteFailed(RUN, FAN, "seed store unavailable");
    const failSeed = (key: string) => (key.startsWith("fan-seed@") ? writeFailed : undefined);

    /**
     * C=3 under a 10-call ceiling: index 0 spends 4, so the projection refuses
     * (5 × 4 > 6 left) with indices 1 and 2 still in flight; `drained` settles
     * them, highest index first.
     */
    const refusedWithInFlight = async (
      drained: (i: number) => ChildPlan,
      failSave?: (key: string) => FrameworkError | undefined,
    ) => {
      const h = fanHarness({ width: 6, childConcurrency: 3, budget: scriptedBudget([callsCeiling(10)]),
        ...(failSave !== undefined ? { failSave } : {}) });
      const run = h.start();
      await quiesce();
      h.settle(0, okChild(0, cost({ calls: 4 })));
      await quiesce();
      expect(h.eventsOf("fan-projection").at(-1)).toMatchObject({ verdict: "refuse" });
      for (const i of [2, 1]) h.settle(i, drained(i));
      return { h, result: await run };
    };

    const cases: readonly (readonly [string, (i: number) => ChildPlan, string | null])[] = [
      ["the primary child failure alone", (i) => (i === 1 ? failChild(childError(1)) : tenfold(i)), null],
      ["the primary and every further child failure", (i) => failChild(childError(i)), "1 further child failure (child 2: rejected)"],
    ];
    for (const [label, drained, further] of cases) {
      it(`the log carries the fan's displaced error whole: ${label}, plus the refusal`, async () => {
        // The twin run, whose seed save succeeds, returns the error the write failure displaces.
        const displaced = errorOf((await refusedWithInFlight(drained)).result);
        expect(displaced).toMatchObject({ kind: "fan-child-failed", primary: { index: 1 } });

        const { h, result } = await refusedWithInFlight(drained, failSeed);
        expect(result).toEqual(err(writeFailed));
        expect(h.eventsOf("fan-refused")).toEqual([expect.objectContaining({ attachedToChildFailure: true })]);
        expect(h.errors).toHaveLength(1);
        const logged = h.errors[0] ?? "";
        expect(logged).toContain(formatFrameworkError(displaced));
        expect(logged).toContain(`child 1 failed: ${formatFrameworkError(childError(1))}`);
        expect(logged).toContain("refused by budget projection on the calls axis");
        if (further === null) expect(logged).not.toContain("further child failure");
        else expect(logged).toContain(further);
        expect(h.pendingAtReturn).toBe(0);
      });
    }
  });
});

describe("abort (FR-023, FR-024, AS-022, AS-023)", () => {
  it("AS-022: abort mid-fan stops dispatch, lets in-flight children save, and never reduces", async () => {
    const h = fanHarness({ width: 6, childConcurrency: 2 });
    const run = h.start();
    await quiesce();
    h.abort();
    h.settle(0, tenfold(0));
    await quiesce();
    expect(h.openIndices()).toEqual([1]);
    expect(h.returned).toBe(false);
    h.settle(1, tenfold(1));
    const result = await run;
    expect(h.dispatched).toEqual([0, 1]);
    expect(h.trace).toContain("save:dag@fan@0@0");
    expect(h.trace).toContain("save:dag@fan@1@0");
    expect(h.reductions).toEqual([]);
    expect(h.pendingAtReturn).toBe(0);
    expect(result).toEqual(err({ kind: "aborted", reason: "signal" }));
  });

  it("AS-023: the abort error kind is distinct from budget refusal and child failure", async () => {
    const h = fanHarness({ width: 3, childConcurrency: 3 });
    const run = h.start();
    await quiesce();
    h.abort();
    for (const i of [2, 0, 1]) h.settle(i, tenfold(i));
    const error = errorOf(await run);
    expect(error.kind).toBe("aborted");
    expect(["fan-budget-refused", "fan-child-failed"]).not.toContain(error.kind);
  });

  it("an abort during a failure drain never replaces the failure (FR-024 precedence)", async () => {
    const h = fanHarness({ width: 4, childConcurrency: 2 });
    const run = h.start();
    await quiesce();
    h.settle(0, failChild(childError(0)));
    await quiesce();
    h.abort();
    h.settle(1, tenfold(1));
    expect(await run).toEqual(err(childError(0)));
  });

  it("an abort before the fan starts loads nothing and dispatches nothing", async () => {
    const h = fanHarness({ width: 3, childConcurrency: 2 });
    h.abort();
    expect(await h.start()).toEqual(err({ kind: "aborted", reason: "signal" }));
    expect(h.trace).toEqual(["return"]);
  });
});

describe("effective concurrency and the host clamp (FR-033, AS-026, AS-027, FR-060)", () => {
  it("AS-027: an authored limit above the host maximum is clamped, warned once and evented", async () => {
    const h = fanHarness({ width: 7, childConcurrency: 6, cap: 2 });
    expect(await drive(h, h.start(), tenfold)).toEqual(ok(range(7)));
    expect(h.maxInFlight).toBe(2);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("'fan'");
    expect(h.warnings[0]).toContain("6");
    expect(h.warnings[0]).toContain("2");
    expect(h.eventsOf("fan-start")).toEqual([expect.objectContaining({
      nodeId: FAN, width: 7, replayed: 0, seeded: false, authored: 6, cap: 2, effective: 2, clamped: true,
      estimator: "largest-seen",
    })]);
  });

  for (const [authored, cap] of [[2, 8], [5, 5], [1, 3]] as const) {
    it(`AS-026: effective concurrency is min(${authored}, ${cap}) with no warning when not clamped`, async () => {
      const h = fanHarness({ width: 9, childConcurrency: authored, cap });
      expect(await drive(h, h.start(), tenfold)).toEqual(ok(range(9)));
      expect(h.maxInFlight).toBe(Math.min(authored, cap));
      expect(h.warnings).toEqual([]);
      expect(h.eventsOf("fan-start")[0]).toMatchObject({ effective: Math.min(authored, cap), clamped: false });
    });
  }

  it("the node span is tagged with effective concurrency, clamp and seed flags (FR-060)", async () => {
    const h = fanHarness({ width: 3, childConcurrency: 4, cap: 3, auto: tenfold });
    await h.start();
    expect(h.spanAttributes).toEqual({
      [FAN_SPAN_EFFECTIVE_CONCURRENCY]: 3,
      [FAN_SPAN_CLAMPED]: true,
      [FAN_SPAN_SEEDED]: false,
    });
  });
});

describe("the host per-call meter stays the hard stop (FR-019, AS-043, FR-018 d)", () => {
  it("a cost spike admitted on the old estimate is stopped by the per-call meter, not by projection", async () => {
    const budget = scriptedBudget([callsCeiling(10)]);
    const h = fanHarness({ width: 5, budget, meter: true });
    const run = h.start();
    const spikes = [1, 1, 100, 1, 1];
    const result = await drive(h, run, (i) => okChild(i * 10, cost({ calls: spikes[i] ?? 1 })));
    const error = errorOf(result);
    expect(error.kind).toBe("llm-budget-exceeded");
    expect(h.dispatched).toEqual([0, 1, 2]);
    expect(budget.spent().calls).toBe(2);
    // Every dispatched child's spend went through the meter independently.
    expect(h.meterChecks).toBe(3);
    expect(h.eventsOf("fan-refused")).toEqual([]);
    expect(h.eventsOf("fan-projection").map((e) => e.verdict)).toEqual(["admit", "admit"]);
  });
});

describe("refusal seed round trip through real checkpointers (AD-11)", () => {
  let dir = "";
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "fan-seed-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const backends: readonly (readonly [string, () => Checkpointer])[] = [
    ["in-memory", () => new InMemoryCheckpointer({ now: () => START_MS })],
    ["file", () => createFileCheckpointer(join(dir, "store"), { now: () => START_MS })],
  ];

  for (const [name, make] of backends) {
    it(`${name}: the seed is persisted, reloaded as a sticky refusal, and a raised ceiling completes`, async () => {
      const cp = make();
      const budget = scriptedBudget([callsCeiling(12)]);
      const first = fanHarness({ width: COSTS.length, budget, checkpointer: cp, auto: costed });
      expect(errorOf(await first.start()).kind).toBe("fan-budget-refused");

      const sticky = fanHarness({ width: COSTS.length, budget, checkpointer: cp, auto: costed });
      const again = errorOf(await sticky.start());
      expect(again).toMatchObject({ kind: "fan-budget-refused", refusal: { completed: 4, remaining: 2 } });
      expect(sticky.dispatched).toEqual([]);
      expect(sticky.eventsOf("fan-start")[0]).toMatchObject({ seeded: true, replayed: 4 });
      expect(sticky.eventsOf("fan-refused")[0]).toMatchObject({ sticky: true });

      budget.redeploy([callsCeiling(100)]);
      const raised = fanHarness({ width: COSTS.length, budget, checkpointer: cp, auto: costed });
      expect(await raised.start()).toEqual(ok(range(COSTS.length)));
      expect(raised.dispatched).toEqual([4, 5]);
    });
  }

  it("a seed that fails its schema refuses the fan, naming it, before any dispatch", async () => {
    const cp = new InMemoryCheckpointer();
    await presave(cp, [], () => 0);
    const saved = await cp.saveNode(RUN, { nodeId: FAN, output: { version: 99 }, completedAt: new Date(START_MS) },
      { namespace: "fan-seed", index: 0, attempt: 0 });
    expect(saved.ok).toBe(true);
    const h = fanHarness({ width: 3, childConcurrency: 2, checkpointer: cp, auto: tenfold });
    const error = errorOf(await h.start());
    expect(error).toMatchObject({ kind: "validation", nodeId: FAN });
    expect(error.kind === "validation" && error.message).toContain("refusal seed");
    expect(h.dispatched).toEqual([]);
  });

  it("a seed of another execution epoch is never read (a reroute ignores it)", async () => {
    const cp = new InMemoryCheckpointer();
    await presave(cp, [], () => 0);
    await cp.saveNode(RUN, { nodeId: FAN, output: { version: 99 }, completedAt: new Date(START_MS) },
      { namespace: "fan-seed", index: 0, attempt: 0 });
    const h = fanHarness({ width: 3, childConcurrency: 2, checkpointer: cp, epoch: 1, auto: tenfold });
    expect(await h.start()).toEqual(ok(range(3)));
    expect(h.eventsOf("fan-start")[0]).toMatchObject({ seeded: false });
    expect(h.scopes.every((s) => s.executionEpoch === 1)).toBe(true);
  });
});

describe("root wiring (AD-7): FanRuntime comes from the root context and run options", () => {
  const wiredDag = (childConcurrency: number) => {
    const child = defineDag({ id: "child", nodes: { work: createFetchNode({ id: "work", inputSchema: z.number(),
      outputSchema: z.number(), fetch: async (n) => ok(n * 10) }) }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
    const fan = createMapNode({ id: "fan", inputSchema: z.object({ items: z.array(z.number()) }), outputSchema: z.array(z.number()),
      widthFrom: "items", maxWidth: 32, child, childOutputSchema: z.number(), childConcurrency, reduce: (xs) => ok([...xs]) });
    return defineDag({ id: "outer", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
  };
  const run = async (childConcurrency: number, cap?: number) => {
    const events: ObserverEvent[] = [];
    const warnings: string[] = [];
    const ctx = makeNodeContext({ runId: RUN, dagId: "outer", capabilities: { checkpointer: new InMemoryCheckpointer() },
      observer: { observe: (e) => { events.push(e); } },
      logger: { warn: (m: string) => { warnings.push(m); }, error: () => {} } });
    const result = await runDag(wiredDag(childConcurrency), { items: [1, 2, 3] }, ctx,
      cap === undefined ? undefined : { fanConcurrencyCap: fanConcurrencyCap(cap) });
    return { result, warnings, start: events.find((e) => e.type === "fan-start") };
  };

  it("the run option cap clamps the authored limit and the root logger carries the warning", async () => {
    const { result, warnings, start } = await run(6, 2);
    expect(result).toEqual(ok([10, 20, 30]));
    expect(start).toMatchObject({ authored: 6, cap: 2, effective: 2, clamped: true });
    expect(warnings.filter((w) => w.includes("'fan'"))).toHaveLength(1);
  });

  it("an omitted cap defaults to the host default of 8", async () => {
    const { start } = await run(12);
    expect(start).toMatchObject({ authored: 12, cap: 8, effective: 8, clamped: true });
  });

  it("the root binds the fan's span sink to the active node span", async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    setFrameworkTracer(provider.getTracer("map-fan-concurrency"));
    try {
      const { result } = await run(4, 2);
      expect(result).toEqual(ok([10, 20, 30]));
      const fanSpan = exporter.getFinishedSpans().find((span) => span.name === "node:fan");
      expect(fanSpan?.attributes).toMatchObject({
        [FAN_SPAN_EFFECTIVE_CONCURRENCY]: 2,
        [FAN_SPAN_CLAMPED]: true,
        [FAN_SPAN_SEEDED]: false,
      });
    } finally {
      __resetFrameworkTracer();
      await provider.shutdown();
    }
  });
});
