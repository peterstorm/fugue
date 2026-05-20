/**
 * Test: Confidence-gated routing end-to-end
 *
 * Validates that when a predicate declares `minConfidence` and the upstream
 * node's confidence is below that threshold, the predicate is NOT evaluated
 * and the default edge is taken instead.
 */

import { describe, it, expect } from "bun:test";
import { defineDagFromArray } from "../executor/define-dag.js";
import { runDag } from "../executor/run-dag.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { RecordingObserver } from "../observer/observer.js";
import { confidence } from "../types/confidence.js";
import { resourceName } from "../types/freshness.js";
import type { NodeDef } from "../types/node.js";
import type { Confidence } from "../types/confidence.js";
import { runId, dagId, nodeId } from "../types/ids.js";
import { z } from "zod";
import { ok } from "../types/result.js";

const makeNode = <O>(id: string, output: O, opts?: {
  confidence?: Confidence;
}): NodeDef<unknown, O> => ({
  id: nodeId(id),
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown() as z.ZodType<O>,
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: opts?.confidence
    ? { mode: "value", extract: () => opts.confidence! }
    : { mode: "none" },
  run: async () => ok(output),
});

describe("confidence-gated routing — end-to-end", () => {
  it("below-min-confidence takes default edge (predicate not evaluated)", async () => {
    let predicateWasCalled = false;

    const dag = defineDagFromArray({
      id: "confidence-gate-test",
      nodes: [
        makeNode("router", { value: "routed" }, {
          confidence: confidence("low", "heuristic"),
        }),
        makeNode("high-confidence-path", "high"),
        makeNode("fallback-path", "fallback"),
      ],
      edges: [
        {
          from: "router",
          to: "high-confidence-path",
          kind: "conditional" as const,
          when: {
            label: "high-confidence-only",
            version: 1,
            check: () => {
              predicateWasCalled = true;
              return true; // Would match, but should never be called
            },
            minConfidence: "high" as const, // Requires "high", upstream is "low"
          },
        },
        { from: "router", to: "fallback-path", kind: "default" as const },
      ],
      outputNodeId: "fallback-path",
    });

    const obs = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: runId("test-run"),
      dagId: dagId("confidence-gate-test"),
      observer: obs,
      logger: { warn: () => {}, error: () => {} },
    });

    const result = await runDag(dag, {}, ctx, { suppressRoutingWarnings: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("fallback");
    }

    // The predicate should NOT have been called due to confidence gating
    expect(predicateWasCalled).toBe(false);

    // Verify route-decided event shows below-min-confidence
    const routeEvents = obs.events.filter((e) => e.type === "route-decided");
    expect(routeEvents.length).toBeGreaterThan(0);

    const routeEvent = routeEvents[0]!;
    if (routeEvent.type === "route-decided") {
      const predicateResults = routeEvent.evidence.predicateResults;
      expect(predicateResults.length).toBeGreaterThan(0);
      expect(predicateResults[0]!.outcome).toBe("below-min-confidence");
    }
  });

  it("meets-min-confidence evaluates predicate normally", async () => {
    let predicateWasCalled = false;

    const dag = defineDagFromArray({
      id: "confidence-meets-test",
      nodes: [
        makeNode("router", { value: "routed" }, {
          confidence: confidence("high", "classifier-probability", 0.95),
        }),
        makeNode("confident-path", "confident"),
        makeNode("fallback-path", "fallback"),
      ],
      edges: [
        {
          from: "router",
          to: "confident-path",
          kind: "conditional" as const,
          when: {
            label: "always-match",
            version: 1,
            check: () => {
              predicateWasCalled = true;
              return true;
            },
            minConfidence: "medium" as const, // Requires "medium", upstream is "high" — passes
          },
        },
        { from: "router", to: "fallback-path", kind: "default" as const },
      ],
    });

    const obs = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: runId("test-run-2"),
      dagId: dagId("confidence-meets-test"),
      observer: obs,
      logger: { warn: () => {}, error: () => {} },
    });

    const result = await runDag(dag, {}, ctx, { suppressRoutingWarnings: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The conditional path was taken since confidence meets threshold
      expect(result.value).toBe("confident");
    }

    // The predicate SHOULD have been called since confidence meets threshold
    expect(predicateWasCalled).toBe(true);
  });
});
