// Wave 6 §6.12 — regression test for §1.2: DAG-machine retry trace outcome.
//
// Before §1.2 the runner classified retry trace outcomes by state-equality
// (`prevStateKey === nextStateKey`), which is wrong for the DAG machine:
// `running → retrying` is a *state change*, so retries were reported as
// "success" in onTrace. The fix added an optional `isRetryTransition` hook
// on Machine; the DAG machine declares it.
//
// Property: a DAG that retries at least once emits at least one trace event
// with `outcome: "retry"`.

import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { TraceEvent } from "../state-machine/types.js";
import type { DagPhase, DagEvent } from "../dag-runtime/types.js";
import { N } from "./_id-helpers.js";

const mkCtx = (): NodeContext => ({
  runId: "retry-trace-run" as RunId,
  dagId: "retry-trace-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null, clock: null, budget: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("§6.12 — DAG-machine retry trace outcome (regression for §1.2)", () => {
  it("flaky node that fails once emits at least one trace with outcome:'retry'", async () => {
    let callCount = 0;
    const flaky: NodeDef<unknown, unknown> = {
      id: N("flaky"),
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: [],
      sideEffects: { kind: "none" },
  confidence: { mode: "none" },
      run: async () => {
        callCount += 1;
        if (callCount < 2) {
          return err({ kind: "node-crash" as const, retriability: "retriable" as const, nodeId: "flaky" as NodeId, message: "transient" });
        }
        return ok("done");
      },
      retry: { backoffMs: [1] },
    };

    const dag = defineDagFromArray({
      id: "retry-trace",
      nodes: [flaky],
      edges: [{ from: DAG_INPUT, to: "flaky" }],
      defaultRetryLimit: 2,
    });

    const traces: TraceEvent<DagPhase, DagEvent>[] = [];
    const result = await runDagStateful(dag, {}, mkCtx(), {
      onTrace: (t) => traces.push(t),
    });

    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);

    const retryTraces = traces.filter((t) => t.outcome === "retry");
    expect(retryTraces.length).toBeGreaterThan(0);

    // The retry trace's next-state should be `retrying` (the DAG machine's
    // retry phase). The `isRetryTransition` predicate is what makes this
    // classification correct — bare state-equality would have missed it.
    const retryingTrace = retryTraces.find((t) => t.nextState.kind === "retrying");
    expect(retryingTrace).toBeDefined();
    expect(retryingTrace?.nextState.kind).toBe("retrying");
  });

  it("non-flaky DAG emits zero traces with outcome:'retry'", async () => {
    const happy: NodeDef<unknown, unknown> = {
      id: N("happy"),
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: [],
      sideEffects: { kind: "none" },
  confidence: { mode: "none" },
      run: async () => ok("done"),
    };

    const dag = defineDagFromArray({
      id: "no-retry",
      nodes: [happy],
      edges: [{ from: DAG_INPUT, to: "happy" }],
      defaultRetryLimit: 2,
    });

    const traces: TraceEvent<DagPhase, DagEvent>[] = [];
    const result = await runDagStateful(dag, {}, mkCtx(), {
      onTrace: (t) => traces.push(t),
    });

    expect(result.ok).toBe(true);
    expect(traces.filter((t) => t.outcome === "retry").length).toBe(0);
  });
});
