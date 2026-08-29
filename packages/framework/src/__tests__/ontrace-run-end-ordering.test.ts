// ADR 0020 property test: for every run, every `onTrace` callback fires
// before the `run-end` observer event is dispatched.
//
// Generates 100 random DAGs covering foreground/background × succeeded/failed
// shapes, captures both onTrace events and observer events into one merged
// stream with a monotonic sequence counter, and asserts the contract:
//
//   for every traced event T and every run-end event R in the same run,
//   seq(T) < seq(R).

import { describe, expect, it } from "bun:test";
import { DAG_INPUT } from "../types/ids.js";
import { z } from "zod";
import type { NodeContext, NodeDef } from "../types/node.js";
import { ok, err } from "../types/result.js";
import { RecordingObserver } from "../observer/observer.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { createTransformNode } from "../nodes/transform.js";
import type { TraceEvent } from "../state-machine/types.js";
import type { DagPhase, DagEvent } from "../dag-runtime/types.js";
import { N, R, D } from "./_id-helpers.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG — seeded linear congruential generator. Test failures
// reproduce on the same seed; same seed yields the same 100 shapes.
// ---------------------------------------------------------------------------

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Recording {
  readonly traceCount: number;
  readonly runEndIndex: number;
  readonly lastTraceIndex: number;
  readonly entries: readonly { kind: "trace" | "observer"; idx: number; tag: string }[];
}

const mkCtx = (observer: RecordingObserver): NodeContext => ({
  runId: R(`r-${Math.floor(Math.random() * 1e9)}`),
  dagId: D("ontrace-ordering"),
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null, clock: null, budget: null,
  logger: { warn: () => {}, error: () => {} },
});

const mkNode = (id: string, kind: "ok" | "fail-once" | "fail-always", state: { calls: Record<string, number> }): NodeDef<unknown, unknown> => {
  if (kind === "ok") {
    return createTransformNode({
      id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      transform: (i) => ok(i),
    });
  }
  if (kind === "fail-once") {
    return {
      id: N(id),
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: [],
      sideEffects: { kind: "none" } as const,
      confidence: { mode: "none" } as const,
      run: async (i) => {
        state.calls[id] = (state.calls[id] ?? 0) + 1;
        if ((state.calls[id] ?? 0) < 2) {
          return err({ kind: "node-crash" as const, retriability: "retriable" as const, nodeId: N(id), message: "transient" });
        }
        return ok(i);
      },
      retry: { backoffMs: [1] },
    };
  }
  return {
    id: N(id),
    kind: "transform",
    inputSchema: z.any(),
    outputSchema: z.any(),
    requires: [],
    sideEffects: { kind: "none" } as const,
    confidence: { mode: "none" } as const,
    run: async () => err({ kind: "node-crash" as const, retriability: "retriable" as const, nodeId: N(id), message: "permanent" }),
    retry: { backoffMs: [1] },
  };
};

interface Shape {
  readonly nodeCount: number;
  readonly failNodeIdx: number; // -1 = no failures
  readonly failMode: "none" | "fail-once" | "fail-always";
  readonly background: boolean;
  readonly defaultRetryLimit: number;
}

const genShape = (rng: () => number): Shape => {
  const nodeCount = 2 + Math.floor(rng() * 4); // 2..5
  const r = rng();
  const failMode: Shape["failMode"] =
    r < 0.45 ? "none" : r < 0.85 ? "fail-once" : "fail-always";
  const failNodeIdx = failMode === "none" ? -1 : Math.floor(rng() * nodeCount);
  return {
    nodeCount,
    failNodeIdx,
    failMode,
    background: rng() < 0.5,
    defaultRetryLimit: failMode === "fail-once" ? 2 : 1,
  };
};

const buildDag = (shape: Shape, state: { calls: Record<string, number> }) => {
  const ids = Array.from({ length: shape.nodeCount }, (_, i) => `N${i}`);
  const nodes = ids.map((id, i) => {
    if (i === shape.failNodeIdx && shape.failMode !== "none") {
      return mkNode(id, shape.failMode === "fail-once" ? "fail-once" : "fail-always", state);
    }
    return mkNode(id, "ok", state);
  });
  const edges = [
    { from: DAG_INPUT as string, to: ids[0]! },
    ...ids.slice(1).map((to, i) => ({ from: ids[i]!, to })),
  ];
  return defineDagFromArray({
    id: `shape-${shape.nodeCount}-${shape.failNodeIdx}`,
    nodes,
    edges,
    defaultRetryLimit: shape.defaultRetryLimit,
  });
};

// ---------------------------------------------------------------------------
// One run: capture interleaved trace + observer events; check ordering.
// ---------------------------------------------------------------------------

const runOnce = async (shape: Shape, seedTag: number): Promise<Recording> => {
  const state = { calls: {} as Record<string, number> };
  const dag = buildDag(shape, state);

  let seq = 0;
  const entries: { kind: "trace" | "observer"; idx: number; tag: string }[] = [];

  // Custom recording observer that increments the shared counter.
  class SeqObserver extends RecordingObserver {
    observe(e: any) {
      const tag = e.type === "run-end" ? `run-end:${e.status}` : e.type;
      entries.push({ kind: "observer", idx: seq++, tag });
      super.observe(e);
    }
  }
  const observer = new SeqObserver();

  let bgPromise: Promise<void> | undefined;
  const onTrace = (t: TraceEvent<DagPhase, DagEvent>) => {
    entries.push({ kind: "trace", idx: seq++, tag: `trace:${t.nextState.kind}:${t.outcome}` });
  };

  void seedTag; // reserved for debug logging on failure

  await runDagStateful(
    dag,
    {},
    mkCtx(observer),
    {
      onTrace,
      onBackground: shape.background ? (p: Promise<any>) => { bgPromise = p; } : undefined,
    },
  );

  if (bgPromise) {
    await bgPromise; // ensure detached finalize completes before we inspect
  }

  // Compute summary stats over the merged stream.
  const traceEntries = entries.filter((e) => e.kind === "trace");
  const runEndEntries = entries.filter((e) => e.kind === "observer" && e.tag.startsWith("run-end"));

  // The contract permits at most one run-end per run; if observer dispatches
  // more, that's a separate bug. Pick the last for the strictest check.
  const runEndIndex = runEndEntries.length > 0
    ? runEndEntries[runEndEntries.length - 1]!.idx
    : -1;
  const lastTraceIndex = traceEntries.length > 0
    ? traceEntries[traceEntries.length - 1]!.idx
    : -1;

  return {
    traceCount: traceEntries.length,
    runEndIndex,
    lastTraceIndex,
    entries,
  };
};

// ---------------------------------------------------------------------------
// The property test
// ---------------------------------------------------------------------------

describe("ADR 0020: onTrace precedes run-end", () => {
  it("holds across 100 random DAG shapes (foreground + background, succeeded + failed)", async () => {
    const rng = lcg(0xC0DE_BEEF);
    const RUNS = 100;
    const violations: { seed: number; shape: Shape; recording: Recording }[] = [];

    for (let i = 0; i < RUNS; i++) {
      const shape = genShape(rng);
      const recording = await runOnce(shape, i);

      // Property: every onTrace event in this run has a sequence number
      // strictly less than the run-end's sequence number.
      // Equivalently: lastTraceIndex < runEndIndex (when both are present).
      const violated =
        recording.runEndIndex >= 0 &&
        recording.lastTraceIndex >= 0 &&
        recording.lastTraceIndex >= recording.runEndIndex;

      if (violated) {
        violations.push({ seed: i, shape, recording });
      }

      // Every successful run produces at least one onTrace (the terminal
      // transition into "succeeded") and exactly one run-end.
      if (shape.failMode === "none") {
        expect(recording.traceCount).toBeGreaterThan(0);
        expect(recording.runEndIndex).toBeGreaterThanOrEqual(0);
      }
    }

    if (violations.length > 0) {
      const sample = violations[0]!;
      const trail = sample.recording.entries
        .map((e) => `${e.idx} [${e.kind}] ${e.tag}`)
        .join("\n  ");
      throw new Error(
        `ADR 0020 ordering violated in ${violations.length}/${RUNS} runs. First violation (seed=${sample.seed}, shape=${JSON.stringify(sample.shape)}):\n  ${trail}`,
      );
    }
  });

  it("foreground: run-end is the last observer event after all traces", async () => {
    const shape: Shape = {
      nodeCount: 3,
      failNodeIdx: -1,
      failMode: "none",
      background: false,
      defaultRetryLimit: 1,
    };
    const rec = await runOnce(shape, 0);
    expect(rec.runEndIndex).toBeGreaterThan(rec.lastTraceIndex);
    // The very last entry in the stream is run-end.
    expect(rec.entries[rec.entries.length - 1]?.tag).toMatch(/^run-end/);
  });

  it("background: run-end fires after the detached finalize awaits, still after all traces", async () => {
    const shape: Shape = {
      nodeCount: 3,
      failNodeIdx: -1,
      failMode: "none",
      background: true,
      defaultRetryLimit: 1,
    };
    const rec = await runOnce(shape, 0);
    expect(rec.runEndIndex).toBeGreaterThan(rec.lastTraceIndex);
  });

  it("failed run: run-end(status=error) still follows the terminal failed trace", async () => {
    const shape: Shape = {
      nodeCount: 3,
      failNodeIdx: 1,
      failMode: "fail-always",
      background: false,
      defaultRetryLimit: 1,
    };
    const rec = await runOnce(shape, 0);
    expect(rec.runEndIndex).toBeGreaterThan(rec.lastTraceIndex);
    // The failed transition is in the trace stream before run-end.
    const lastTrace = rec.entries.filter((e) => e.kind === "trace").pop();
    expect(lastTrace?.tag).toMatch(/^trace:failed/);
  });
});
