// Routing tests for conditional edges — function-based predicates with
// bucketed confidence (Phase 2).

import { describe, it, expect } from "bun:test";
import type { RunId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { z } from "zod";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { RecordingObserver } from "../observer/observer.js";
import { ok } from "../types/result.js";
import { N } from "./_id-helpers.js";
import { testNodeContext } from "./_context-factories.js";

const noop = async () => ok(undefined as unknown);

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null
    ? value as Readonly<Record<string, unknown>>
    : {};

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

const ctx = (observer?: RecordingObserver): NodeContext =>
  testNodeContext({
    runId: "r" as RunId,
    dagId: "d" as DagId,
    ...(observer ? { observer } : {}),
  });

const twoWayRoutingDag = (routerOutput: unknown) => defineDag({
  id: "two-way",
  nodes: {
    router: makeNode("router", { run: async () => ok(routerOutput) }),
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
      run: async (input: unknown) => {
        const branches = recordOf(input);
        return ok(branches["yes-branch"] ?? branches["no-branch"] ?? "neither");
      },
    }),
  },
  edges: [
    { from: DAG_INPUT, to: "router" },
    { from: "router", to: "yes-branch", when: { label: "kind-is-yes", version: 1, check: (value: unknown) => recordOf(value).kind === "yes" } },
    { from: "router", to: "no-branch", kind: "default" },
    { from: "yes-branch", to: "merge" },
    { from: "no-branch", to: "merge" },
  ],
  outputNodeId: "merge",
  defaultRetryLimit: 0,
});

describe("conditional edges — 2-way routing", () => {
  it("predicate matches: conditional branch picked; default skipped", async () => {
    const dag = twoWayRoutingDag({ kind: "yes" });

    const obs = new RecordingObserver();
    const result = await runDagStateful<unknown, string>(dag, null, ctx(obs));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("yes");

    const routeDecided = obs.events.filter((e) => e.type === "route-decided");
    expect(routeDecided).toHaveLength(1);
    if (routeDecided[0]?.type === "route-decided") {
      expect([...routeDecided[0].chosenTargets]).toEqual([N("yes-branch")]);
      expect([...routeDecided[0].prunedTargets]).toEqual([N("no-branch")]);
      expect(routeDecided[0].defaultTaken).toBe(false);
      // Phase 2: evidence colocated with routing decision
      expect(routeDecided[0].evidence.predicateResults).toHaveLength(1);
      expect(routeDecided[0].evidence.predicateResults[0]?.predicateLabel).toBe("kind-is-yes");
      expect(routeDecided[0].evidence.predicateResults[0]?.outcome).toBe("matched");
      expect(routeDecided[0].evidence.upstreamConfidence).toBeNull(); // router has confidence: none
    }

    const pruned = obs.events.filter((e) => e.type === "node-pruned");
    expect(pruned).toHaveLength(1);
    if (pruned[0]?.type === "node-pruned") {
      expect(pruned[0].nodeId).toBe(N("no-branch"));
    }
  });

  it("default fires when no predicate matches; all predicateResults show matched: false", async () => {
    const dag = twoWayRoutingDag({ kind: "other" });

    const obs = new RecordingObserver();
    const result = await runDagStateful<unknown, string>(dag, null, ctx(obs));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("no");

    const decided = obs.events.find((e) => e.type === "route-decided");
    if (decided?.type === "route-decided") {
      expect(decided.defaultTaken).toBe(true);
      // No predicate matched
      expect(decided.evidence.predicateResults.every((r) => r.outcome === "not-matched")).toBe(true);
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
          run: async (input: unknown) => {
            const branches = recordOf(input);
            return ok(branches.a ?? branches.b ?? branches.c ?? branches.d ?? "none");
          },
        }),
      },
      edges: [
        { from: DAG_INPUT, to: "router" },
        { from: "router", to: "a", when: { label: "kind-is-a", version: 1, check: (value: unknown) => recordOf(value).kind === "a" } },
        { from: "router", to: "b", when: { label: "kind-is-b", version: 1, check: (value: unknown) => recordOf(value).kind === "b" } },
        { from: "router", to: "c", when: { label: "kind-is-c", version: 1, check: (value: unknown) => recordOf(value).kind === "c" } },
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

  it("check function with multi-value matching (replaces oneOf)", async () => {
    const dag = defineDag({
      id: "multi-value",
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
        { from: DAG_INPUT, to: "router" },
        {
          from: "router",
          to: "match",
          when: {
            label: "kind-in-alpha-beta-gamma",
            version: 1,
            check: (value: unknown) =>
              ["alpha", "beta", "gamma"].includes(String(recordOf(value).kind)),
          },
        },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful<unknown, string>(dag, null, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("MATCHED");
  });

  it("multi-condition check requires every condition to match", async () => {
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
        { from: DAG_INPUT, to: "router" },
        {
          from: "router",
          to: "gold",
          when: {
            label: "kind-ok-tier-gold",
            version: 1,
            check: (value: unknown) => {
              const routed = recordOf(value);
              return routed.kind === "ok" && routed.tier === "gold";
            },
          },
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
          run: async (input: unknown) => {
            const branches = recordOf(input);
            return ok({ yes: branches.yes, no: branches.no });
          },
        }),
      },
      edges: [
        { from: DAG_INPUT, to: "router" },
        { from: "router", to: "yes", when: { label: "kind-is-yes", version: 1, check: (value: unknown) => recordOf(value).kind === "yes" } },
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

describe("conditional edges — malformed predicate at definition time", () => {
  it("predicate cast that introduces a non-function check throws DagDefinitionError", () => {
    // A malformed predicate smuggled via `as` casts: missing `check` function.
    // The validator rejects at defineDag time with a DagDefinitionError.
    expect(() => defineDag({
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
        {
          from: "router",
          to: "a",
          when: { label: "bad", version: 1, check: "not-a-function" } as any,
        } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      outputNodeId: "b",
      defaultRetryLimit: 0,
    })).toThrow(/check/);
  });

  it("predicate-malformed throws even with a retry budget", () => {
    expect(() => defineDag({
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
          when: { label: "bad", version: 1, check: 42 } as any,
        } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      outputNodeId: "b",
      defaultRetryLimit: 3,
    })).toThrow(/check/);
  });
});
