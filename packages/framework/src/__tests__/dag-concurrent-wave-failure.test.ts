// Test: concurrent failures in the same wave are surfaced correctly
//
// When 2+ nodes in a parallel wave fail simultaneously, the executor must:
//   1. Report all failures via observer events (node-error for siblings)
//   2. Return the primary failure as node-failed with coFailedNodeIds
//   3. Preserve partial outputs from successful siblings

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { defineDag } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { RecordingObserver } from "../observer/observer.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { ok, err } from "../types/result.js";
import type { NodeDef } from "../types/node.js";
import type { ObserverEvent } from "../types/events.js";
import { R, N, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [],
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
  run: async () => ok(null),
  ...overrides,
});

const mkCtx = (observer: RecordingObserver) =>
  makeNodeContext({ runId: R("cw-test"), dagId: D("cw"), observer });

describe("concurrent wave failures", () => {
  test("all failures are surfaced via observer events", async () => {
    const observer = new RecordingObserver();

    const dag = defineDag({
      id: "concurrent-fail",
      nodes: {
        start: makeNode("start", {
          outputSchema: z.literal("go"),
          run: async () => ok("go" as const),
        }),
        ok_node: makeNode("ok_node", {
          run: async () => ok("success"),
        }),
        fail_a: makeNode("fail_a", {
          run: async () => err({
            kind: "node-crash" as const,
            nodeId: N("fail_a"),
            retriability: "non-retriable" as const,
            message: "crash A",
          }),
        }),
        fail_b: makeNode("fail_b", {
          run: async () => err({
            kind: "node-crash" as const,
            nodeId: N("fail_b"),
            retriability: "non-retriable" as const,
            message: "crash B",
          }),
        }),
        sink: makeNode("sink"),
      },
      edges: [
        { from: DAG_INPUT, to: "start" },
        { from: "start", to: "ok_node" },
        { from: "start", to: "fail_a" },
        { from: "start", to: "fail_b" },
        { from: "ok_node", to: "sink" },
        { from: "fail_a", to: "sink" },
        { from: "fail_b", to: "sink" },
      ],
      outputNodeId: "sink",
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful(dag, {}, mkCtx(observer));

    // Run should fail
    expect(result.ok).toBe(false);

    // THE contract: exactly one `node-error` per failing node — no more, no
    // fewer. Both halves are load-bearing and both were once broken.
    //
    // Too few: a failure path that reports nothing leaves a buffered observer
    // watching the node simply disappear.
    //
    // Too many: `executeWave` used to re-emit for every non-primary failure on
    // top of the event the node had already raised for itself, so a co-failed
    // sibling produced TWO events and the primary one — every observer, metric
    // and alert keyed on `node-error` silently double-counted the sibling.
    // This assertion used to read `toBeGreaterThanOrEqual(1)`, which is exactly
    // why that survived sixteen review rounds. Counting is the point.
    const nodeErrors = observer.events.filter(
      (e: ObserverEvent) => e.type === "node-error",
    );

    const perNode = new Map<string, number>();
    for (const e of nodeErrors) {
      if (e.type === "node-error") perNode.set(e.nodeId, (perNode.get(e.nodeId) ?? 0) + 1);
    }

    expect(perNode.get(N("fail_a"))).toBe(1);
    expect(perNode.get(N("fail_b"))).toBe(1);
    // The node that succeeded never reports a failure.
    expect(perNode.has(N("ok_node"))).toBe(false);
    // …and nothing else raised one either.
    expect(nodeErrors.length).toBe(2);

    // Whichever failure became primary is still the one the run returns.
    if (!result.ok && "nodeId" in result.error) {
      expect([N("fail_a"), N("fail_b")] as string[]).toContain(result.error.nodeId as string);
    }
  });

  test("partial outputs from successful siblings are captured", async () => {
    const observer = new RecordingObserver();

    const dag = defineDag({
      id: "partial-out",
      nodes: {
        start: makeNode("start", { run: async () => ok("go") }),
        good: makeNode("good", { run: async () => ok("good-output") }),
        bad: makeNode("bad", {
          run: async () => err({
            kind: "node-crash" as const,
            nodeId: N("bad"),
            retriability: "non-retriable" as const,
            message: "boom",
          }),
        }),
        sink: makeNode("sink"),
      },
      edges: [
        { from: DAG_INPUT, to: "start" },
        { from: "start", to: "good" },
        { from: "start", to: "bad" },
        { from: "good", to: "sink" },
        { from: "bad", to: "sink" },
      ],
      outputNodeId: "sink",
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful(dag, {}, mkCtx(observer));
    expect(result.ok).toBe(false);

    // The run-end event should fire with error status
    const runEnds = observer.events.filter(
      (e: ObserverEvent) => e.type === "run-end",
    );
    expect(runEnds.length).toBe(1);
    expect((runEnds[0] as any).status).toBe("error");

    // good node should have completed (node-end event present)
    const nodeEnds = observer.events.filter(
      (e: ObserverEvent) => e.type === "node-end",
    );
    const goodEnded = nodeEnds.some((e: ObserverEvent) => e.type === "node-end" && "nodeId" in e && (e as { nodeId: string }).nodeId === N("good"));
    expect(goodEnded).toBe(true);
  });
});
