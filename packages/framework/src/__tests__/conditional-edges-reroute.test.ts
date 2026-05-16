// Reroute interaction with conditional edges (ADR 0015).

import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { HumanAction } from "../dag-runtime/types.js";
import { ok } from "../types/result.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

const noop = async () => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

const makeCtx = (): NodeContext => ({
  runId: "r" as RunId,
  dagId: "d" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("conditional edges — reroute", () => {
  it("reroute back to router re-decides; second decision picks the other branch", async () => {
    let routerRan = 0;
    const routerKinds = ["yes", "no"];
    // Defined without outputNodeId because the rerouted run prunes "no" and
    // we rely on the active-fallback path.
    const dag = defineDag({
      id: "reroute-conditional",
      nodes: {
        router: makeNode("router", {
          run: async () => {
            const k = routerKinds[routerRan++] ?? "no";
            return ok({ kind: k });
          },
        }),
        yes: makeNode("yes", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("Y"),
        }),
        no: makeNode("no", {
          inputSchema: z.any(),
          humanReview: { prompt: "review no" },
          run: async () => ok("N"),
        }),
      },
      edges: [
        { from: "router", to: "yes", when: { label: "kind-is-yes", version: 1, check: (v: any) => v?.kind === "yes" } as any },
        { from: "router", to: "no", kind: "default" },
      ],
      defaultRetryLimit: 1,
    });

    let onHumanReviewCalls = 0;
    const onHumanReview = async (): Promise<HumanAction> => {
      onHumanReviewCalls++;
      // First time: the "no" branch reached — reroute back to router. The
      // router's next call will return {kind: "yes"} and the "no" branch should
      // be pruned, so we should never see this hook fire again.
      if (onHumanReviewCalls === 1) {
        return { action: "reroute", targetNodeId: N("router") };
      }
      return { action: "approve" };
    };

    // Start with router emitting "no" so we land in awaiting-human, then
    // reroute back. After reroute, router emits "yes", "yes" branch fires,
    // "no" gets pruned, run succeeds with the active fallback ("yes").
    routerKinds[0] = "no";
    routerKinds[1] = "yes";

    const result = await runDagStateful<unknown, string>(dag, null, makeCtx(), {
      onHumanReview,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Y");
    expect(onHumanReviewCalls).toBe(1);
  });
});
