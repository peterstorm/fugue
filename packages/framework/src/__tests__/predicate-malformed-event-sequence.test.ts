// Wave 6 §6.13 — regression test for §3.6.
//
// Before §3.6, a malformed conditional-edge predicate produced this observer
// sequence: node-start → node-error → wave-done → run-end(error) — a
// contradictory mix from the operator's view (wave-done after node-error).
// §3.6 made runWave short-circuit on predicate-malformed and emit node-failed
// directly. The expected sequence is now:
//   run-start → node-start → node-end (router succeeded)
//              → node-error (router decideRoute malformed)
//              → run-end(error)
// with NO intervening wave-done event.

import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";
import { ok } from "../types/result.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { RecordingObserver } from "../observer/observer.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async () => ok(undefined as unknown),
  requires: [],
  ...overrides,
});

const mkCtx = (observer: RecordingObserver): NodeContext => ({
  runId: "pred-malformed-run" as RunId,
  dagId: "pred-malformed-dag" as DagId,
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("§6.13 — predicate-malformed observer event sequence (regression for §3.6)", () => {
  it("emits node-error and run-end(error) with NO intervening wave-done", async () => {
    const dag = defineDag({
      id: "malformed",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "x" }) }),
        a: makeNode("a", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("A"),
        }),
        b: makeNode("b", {
          inputSchema: z.any(),
          run: async () => ok("B"),
        }),
      },
      edges: [
        // Array value is not part of the predicate vocabulary — surfaces at
        // decideRoute as predicate-malformed.
        {
          from: "router",
          to: "a",
          when: { kind: ["x", "y"] } as unknown as Record<string, never>,
        } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      outputNodeId: "b",
      defaultRetryLimit: 0,
    });

    const observer = new RecordingObserver();
    const result = await runDagStateful<unknown, string>(dag, null, mkCtx(observer));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("predicate-malformed");
    }

    const types = observer.events.map((e) => e.type);

    // Observer must NOT emit wave-done before run-end. Before §3.6, the
    // legacy fall-through produced a wave-done in the stream.
    // (`wave-done` is a DagEvent, not an ObserverEvent — but a hypothetical
    // emission via dispatchEvent would surface as that literal type tag.)
    expect(types).not.toContain("wave-done");

    // Required structural ordering: run-start first, then a node-error
    // for "router", then run-end with status error.
    expect(types[0]).toBe("run-start");

    const nodeErrorIdx = types.findIndex((t) => t === "node-error");
    const runEndIdx = types.findIndex((t) => t === "run-end");
    expect(nodeErrorIdx).toBeGreaterThan(-1);
    expect(runEndIdx).toBeGreaterThan(nodeErrorIdx);

    // The node-error must be for the router, and the run-end status is "error".
    const nodeErrEvt = observer.events[nodeErrorIdx];
    expect(nodeErrEvt && "nodeId" in nodeErrEvt && nodeErrEvt.nodeId).toBe(N("router"));
    const runEndEvt = observer.events[runEndIdx];
    expect(runEndEvt && "status" in runEndEvt && runEndEvt.status).toBe("error");
  });
});
