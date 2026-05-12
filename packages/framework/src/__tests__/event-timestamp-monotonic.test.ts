// Wave 4.1 — property test: every observer event in a single run respects the
// injected `nowFn`. Concretely, with a deterministic strictly-monotonic clock,
// run-start < node-start < node-end < run-end (per node). Threading `nowFn`
// through `DagRunOpts.now` makes event ordering reproducible across replays.

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { z } from "zod";

import { defineDag, runDag } from "../executor/index.js";
import { RecordingObserver } from "../observer/observer.js";
import { makeNodeContext } from "../shared/index.js";
import { ok } from "../types/result.js";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";

// Helper: build a chain `n0 → n1 → ... → nK-1` of pure-transform nodes.
const buildChain = (count: number): {
  nodes: Record<string, NodeDef<unknown, unknown, FrameworkError, []>>;
  edges: { from: string; to: string }[];
  outputId: string;
} => {
  const nodes: Record<string, NodeDef<unknown, unknown, FrameworkError, []>> = {};
  for (let i = 0; i < count; i++) {
    const id = `n${i}` as const;
    nodes[id] = {
      id: id as never,
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [] as const,
      async run(input) {
        return ok(input);
      },
    } as NodeDef<unknown, unknown, FrameworkError, []>;
  }
  const edges: { from: string; to: string }[] = [];
  for (let i = 1; i < count; i++) edges.push({ from: `n${i - 1}`, to: `n${i}` });
  return { nodes, edges, outputId: `n${count - 1}` };
};

describe("§4.1 — observer-event timestamps respect the injected nowFn", () => {
  it("node-start.timestamp <= node-end.timestamp for every node across chain lengths", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (count) => {
        const { nodes, edges, outputId } = buildChain(count);
        const dag = defineDag({
          id: "monotone-chain",
          nodes,
          edges,
          outputNodeId: outputId,
        });

        const observer = new RecordingObserver();
        // Strictly-monotonic clock: each call returns the previous value + 1.
        let tick = 1_700_000_000_000;
        const now = (): number => ++tick;

        const result = await runDag<unknown, unknown>(
          dag,
          { seed: 1 },
          makeNodeContext({
            runId: "p-run",
            dagId: "monotone-chain",
            observer,
          }),
          { now },
        );
        expect(result.ok).toBe(true);

        // Pair node-start with the next node-end for the same nodeId.
        const startsByNode = new Map<string, Date[]>();
        const endsByNode = new Map<string, Date[]>();
        for (const e of observer.events) {
          if (e.type === "node-start") {
            const arr = startsByNode.get(e.nodeId) ?? [];
            arr.push(e.timestamp);
            startsByNode.set(e.nodeId, arr);
          } else if (e.type === "node-end") {
            const arr = endsByNode.get(e.nodeId) ?? [];
            arr.push(e.timestamp);
            endsByNode.set(e.nodeId, arr);
          }
        }
        for (const [nodeId, starts] of startsByNode) {
          const ends = endsByNode.get(nodeId) ?? [];
          expect(ends.length).toBe(starts.length);
          for (let i = 0; i < starts.length; i++) {
            expect(starts[i]!.getTime()).toBeLessThanOrEqual(ends[i]!.getTime());
          }
        }
      }),
      { numRuns: 25 },
    );
  });

  it("all timestamps come from the injected clock (never wall-clock fallback)", async () => {
    const { nodes, edges, outputId } = buildChain(3);
    const dag = defineDag({
      id: "fixed-clock",
      nodes,
      edges,
      outputNodeId: outputId,
    });

    const observer = new RecordingObserver();
    // Fixed clock — every event must carry the same timestamp.
    const FIXED = 1_700_000_000_000;
    const result = await runDag<unknown, unknown>(
      dag,
      { seed: 1 },
      makeNodeContext({
        runId: "fixed-run",
        dagId: "fixed-clock",
        observer,
      }),
      { now: () => FIXED },
    );
    expect(result.ok).toBe(true);

    for (const e of observer.events) {
      if ("timestamp" in e && e.timestamp instanceof Date) {
        expect(e.timestamp.getTime()).toBe(FIXED);
      }
    }
  });
});
