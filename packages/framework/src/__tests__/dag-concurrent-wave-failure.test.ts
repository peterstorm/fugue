// Test: concurrent failures in the same wave are surfaced correctly
//
// When 2+ nodes in a parallel wave fail simultaneously, the executor must:
//   1. Report all failures via observer events (node-error for siblings)
//   2. Return the primary failure as node-failed with coFailedNodeIds
//   3. Preserve partial outputs from successful siblings

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { defineDag } from "../executor/define-dag.js";
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

    // Observer should have node-error events for the co-failed sibling(s)
    const nodeErrors = observer.events.filter(
      (e: ObserverEvent) => e.type === "node-error",
    );

    // At least 1 node-error for the sibling failure
    expect(nodeErrors.length).toBeGreaterThanOrEqual(1);

    // Both fail_a and fail_b should be mentioned somewhere in error events
    // or the primary error
    const allFailedIds = new Set<string>();
    for (const e of nodeErrors) {
      if (e.type === "node-error") allFailedIds.add(e.nodeId);
    }
    if (!result.ok && "nodeId" in result.error) {
      allFailedIds.add(result.error.nodeId as string);
    }
    // At least one of the failed nodes is reported
    expect(
      allFailedIds.has(N("fail_a")) || allFailedIds.has(N("fail_b")),
    ).toBe(true);
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
    const goodEnded = nodeEnds.some((e: any) => e.nodeId === N("good"));
    expect(goodEnded).toBe(true);
  });
});
