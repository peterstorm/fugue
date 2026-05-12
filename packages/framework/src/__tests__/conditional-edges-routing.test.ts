// Routing tests for conditional edges (ADR 0015 + ADR 0016).
// Predicates are structural-match data; closures are no longer accepted.

import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { NoopObserver, RecordingObserver } from "../observer/observer.js";
import { ok } from "../types/result.js";

const noop = async () => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  ...overrides,
});

const ctx = (observer?: RecordingObserver): NodeContext => ({
  runId: "r" as RunId,
  dagId: "d" as DagId,
  observer: observer ?? new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

// Branch-target nodes whose only incoming edge is conditional MUST declare
// the dep as `optionalDeps` per the validator. The runtime input shape is
// then an object keyed by `deps ∪ optionalDeps`.
describe("conditional edges — 2-way routing", () => {
  it("predicate matches: conditional branch picked; default skipped", async () => {
    const dag = defineDag({
      id: "two-way",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "yes" }) }),
        "yes-branch": makeNode("yes-branch", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("yes"),
        }),
        "no-branch": makeNode("no-branch", {
          inputSchema: z.any(),
          run: async () => ok("no"),
        }),
        merge: makeNode("merge", {
          inputSchema: z.object({
            "yes-branch": z.string().optional(),
            "no-branch": z.string().optional(),
          }),
          run: async (input: any) =>
            ok(input["yes-branch"] ?? input["no-branch"] ?? "neither"),
        }),
      },
      edges: [
        { from: "router", to: "yes-branch", when: { kind: "yes" } as any },
        { from: "router", to: "no-branch", kind: "default" },
        { from: "yes-branch", to: "merge" },
        { from: "no-branch", to: "merge" },
      ],
      outputNodeId: "merge",
      defaultRetryLimit: 0,
    });

    const obs = new RecordingObserver();
    const result = await runDagStateful<unknown, string>(dag, null, ctx(obs));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("yes");

    const routeDecided = obs.events.filter((e) => e.type === "route-decided");
    expect(routeDecided).toHaveLength(1);
    if (routeDecided[0]?.type === "route-decided") {
      expect([...routeDecided[0].chosenTargets]).toEqual(["yes-branch"]);
      expect([...routeDecided[0].prunedTargets]).toEqual(["no-branch"]);
      expect(routeDecided[0].defaultTaken).toBe(false);
      expect(routeDecided[0].matchedPredicate).toEqual({ kind: "yes" });
    }

    const pruned = obs.events.filter((e) => e.type === "node-pruned");
    expect(pruned).toHaveLength(1);
    if (pruned[0]?.type === "node-pruned") {
      expect(pruned[0].nodeId).toBe("no-branch");
    }
  });

  it("default fires when no predicate matches; matchedPredicate is null", async () => {
    const dag = defineDag({
      id: "default-fires",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "other" }) }),
        "yes-branch": makeNode("yes-branch", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("yes"),
        }),
        "no-branch": makeNode("no-branch", {
          inputSchema: z.any(),
          run: async () => ok("no"),
        }),
        merge: makeNode("merge", {
          inputSchema: z.object({
            "yes-branch": z.string().optional(),
            "no-branch": z.string().optional(),
          }),
          run: async (input: any) =>
            ok(input["yes-branch"] ?? input["no-branch"] ?? "neither"),
        }),
      },
      edges: [
        { from: "router", to: "yes-branch", when: { kind: "yes" } as any },
        { from: "router", to: "no-branch", kind: "default" },
        { from: "yes-branch", to: "merge" },
        { from: "no-branch", to: "merge" },
      ],
      outputNodeId: "merge",
      defaultRetryLimit: 0,
    });

    const obs = new RecordingObserver();
    const result = await runDagStateful<unknown, string>(dag, null, ctx(obs));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("no");

    const decided = obs.events.find((e) => e.type === "route-decided");
    if (decided?.type === "route-decided") {
      expect(decided.defaultTaken).toBe(true);
      expect(decided.matchedPredicate).toBeNull();
    }
  });
});

describe("conditional edges — 3-way routing", () => {
  it("first-match wins by declaration order", async () => {
    const dag = defineDag({
      id: "three-way",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "b" }) }),
        a: makeNode("a", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("A"),
        }),
        b: makeNode("b", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("B"),
        }),
        c: makeNode("c", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("C"),
        }),
        d: makeNode("d", {
          inputSchema: z.any(),
          run: async () => ok("D"),
        }),
        merge: makeNode("merge", {
          inputSchema: z.object({
            a: z.string().optional(),
            b: z.string().optional(),
            c: z.string().optional(),
            d: z.string().optional(),
          }),
          run: async (input: any) =>
            ok(input.a ?? input.b ?? input.c ?? input.d ?? "none"),
        }),
      },
      edges: [
        { from: "router", to: "a", when: { kind: "a" } as any },
        { from: "router", to: "b", when: { kind: "b" } as any },
        { from: "router", to: "c", when: { kind: "c" } as any },
        { from: "router", to: "d", kind: "default" },
        { from: "a", to: "merge" },
        { from: "b", to: "merge" },
        { from: "c", to: "merge" },
        { from: "d", to: "merge" },
      ],
      outputNodeId: "merge",
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful<unknown, string>(dag, null, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("B");
  });

  it("oneOf matches any listed value", async () => {
    const dag = defineDag({
      id: "oneof",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "beta" }) }),
        match: makeNode("match", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("MATCHED"),
        }),
        fallback: makeNode("fallback", {
          inputSchema: z.any(),
          run: async () => ok("FALLBACK"),
        }),
      },
      edges: [
        {
          from: "router",
          to: "match",
          when: { kind: { oneOf: ["alpha", "beta", "gamma"] } } as any,
        },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful<unknown, string>(dag, null, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("MATCHED");
  });

  it("multi-key predicate requires every key to match", async () => {
    const dag = defineDag({
      id: "multi-key",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "ok", tier: "gold" }),
        }),
        gold: makeNode("gold", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("GOLD"),
        }),
        other: makeNode("other", {
          inputSchema: z.any(),
          run: async () => ok("OTHER"),
        }),
      },
      edges: [
        {
          from: "router",
          to: "gold",
          when: { kind: "ok", tier: "gold" } as any,
        },
        { from: "router", to: "other", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful<unknown, string>(dag, null, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("GOLD");
  });
});

describe("conditional edges — branch-then-rejoin via optionalDeps", () => {
  it("only the chosen branch's nodes run; merge sees undefined for pruned", async () => {
    let yesRan = 0;
    let noRan = 0;
    const dag = defineDag({
      id: "rejoin",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "yes" }) }),
        yes: makeNode("yes", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => {
            yesRan++;
            return ok("Y");
          },
        }),
        no: makeNode("no", {
          inputSchema: z.any(),
          run: async () => {
            noRan++;
            return ok("N");
          },
        }),
        merge: makeNode("merge", {
          inputSchema: z.object({
            yes: z.string().optional(),
            no: z.string().optional(),
          }),
          run: async (input: any) => ok({ yes: input.yes, no: input.no }),
        }),
      },
      edges: [
        { from: "router", to: "yes", when: { kind: "yes" } as any },
        { from: "router", to: "no", kind: "default" },
        { from: "yes", to: "merge" },
        { from: "no", to: "merge" },
      ],
      outputNodeId: "merge",
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful<unknown, { yes?: string; no?: string }>(
      dag,
      null,
      ctx(),
    );
    expect(yesRan).toBe(1);
    expect(noRan).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.yes).toBe("Y");
      expect(result.value.no).toBeUndefined();
    }
  });
});

describe("conditional edges — malformed predicate at runtime", () => {
  it("predicate cast that introduces an array value fails with predicate-malformed", async () => {
    // Module-load validator only checks `{}` for emptiness — a malformed
    // value smuggled in via `as` casts (here: an array under a key) surfaces
    // at decideRoute as a predicate-malformed error.
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
        // Array values are not part of the predicate vocabulary — must be a
        // literal or `{ oneOf: [...] }`. Cast through `unknown` to bypass
        // edit-time typing.
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

    const result = await runDagStateful<unknown, string>(dag, null, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("predicate-malformed");
      if (result.error.kind === "predicate-malformed") {
        expect(result.error.nodeId).toBe("router");
        expect(result.error.message).toContain("'kind'");
      }
    }
  });

  // Wave 3 §3.6: malformed predicate is a config error — fail-fast regardless
  // of retry budget. Previously runWave fell through to wave-done and
  // handleWaveDone failed the run; now runWave returns node-failed and
  // handleNodeFailed special-cases the kind to skip retry. This test pins the
  // fail-fast behavior — without §3.6, a non-zero retry budget would have
  // produced retry-exhausted.
  it("predicate-malformed is non-retriable even with a retry budget", async () => {
    const dag = defineDag({
      id: "malformed-retries",
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
        {
          from: "router",
          to: "a",
          when: { kind: ["x", "y"] } as unknown as Record<string, never>,
        } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      outputNodeId: "b",
      defaultRetryLimit: 3,
    });

    const result = await runDagStateful<unknown, string>(dag, null, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // §3.6: failure preserves the predicate-malformed kind, not wrapped in retry-exhausted.
      expect(result.error.kind).toBe("predicate-malformed");
    }
  });
});
