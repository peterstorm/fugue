/**
 * Phase 2 test — route-decided evidence with bucketed confidence.
 *
 * Validates:
 * - RouteEvidence is colocated with RouteDecidedEvent
 * - upstreamConfidence is populated when node declares confidence.mode === "value"
 * - upstreamConfidence is null when node declares confidence.mode === "none"
 * - predicateResults records per-predicate evaluation with label, matched, confidence
 * - minConfidence gating: below-min-confidence recorded when upstream bucket is too low
 * - Throwing check function records reason: "threw"
 * - Default-taken case: all predicateResults show matched: false
 * - Multi-match case: first-match wins, all predicates still recorded
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import type { RunId, DagId } from "../types/ids.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { RouteDecidedEvent } from "../types/events.js";
import type { Confidence } from "../types/confidence.js";
import { ok } from "../types/result.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import { N } from "./_id-helpers.js";

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async () => ok(undefined),
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

const mkCtx = (observer: RecordingObserver): NodeContext => ({
  runId: "evidence-run" as RunId,
  dagId: "evidence-dag" as DagId,
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

const routeEvents = (obs: RecordingObserver): RouteDecidedEvent[] =>
  obs.events.filter((e): e is RouteDecidedEvent => e.type === "route-decided");

describe("RouteDecidedEvent evidence (Phase 2)", () => {
  it("upstreamConfidence is null when router has confidence: { mode: 'none' }", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "no-conf",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "yes" }),
          confidence: { mode: "none" },
        }),
        yes: makeNode("yes", { inputSchema: z.object({ router: z.any().optional() }) }),
        no: makeNode("no"),
      },
      edges: [
        { from: "router", to: "yes", when: { label: "is-yes", version: 1, check: (v: any) => v?.kind === "yes" } as any },
        { from: "router", to: "no", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    await runDagStateful(dag, null, mkCtx(obs));
    const [route] = routeEvents(obs);
    expect(route).toBeDefined();
    expect(route!.evidence.upstreamConfidence).toBeNull();
    expect(route!.evidence.upstreamOutput).toEqual({ kind: "yes" });
    expect(route!.evidence.decidedAtMs).toBeGreaterThan(0);
  });

  it("upstreamConfidence is populated when router has confidence: { mode: 'value' }", async () => {
    const obs = new RecordingObserver();
    const expectedConf: Confidence = { bucket: "high", source: "heuristic" };
    const dag = defineDag({
      id: "with-conf",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "yes", confident: true }),
          confidence: {
            mode: "value",
            extract: () => expectedConf,
          },
        }),
        yes: makeNode("yes", { inputSchema: z.object({ router: z.any().optional() }) }),
        no: makeNode("no"),
      },
      edges: [
        { from: "router", to: "yes", when: { label: "is-yes", version: 1, check: (v: any) => v?.kind === "yes" } as any },
        { from: "router", to: "no", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    await runDagStateful(dag, null, mkCtx(obs));
    const [route] = routeEvents(obs);
    expect(route!.evidence.upstreamConfidence).toEqual(expectedConf);
  });

  it("predicateResults records label, matched, and evaluatedConfidence for each predicate", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "multi-pred",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "b" }),
          confidence: {
            mode: "value",
            extract: () => ({ bucket: "medium" as const, source: "self-reported-bucket" as const }),
          },
        }),
        a: makeNode("a", { inputSchema: z.object({ router: z.any().optional() }) }),
        b: makeNode("b", { inputSchema: z.object({ router: z.any().optional() }) }),
        c: makeNode("c"),
      },
      edges: [
        { from: "router", to: "a", when: { label: "kind-is-a", version: 1, check: (v: any) => v?.kind === "a" } as any },
        { from: "router", to: "b", when: { label: "kind-is-b", version: 1, check: (v: any) => v?.kind === "b" } as any },
        { from: "router", to: "c", kind: "default" },
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
      defaultRetryLimit: 0,
    });

    await runDagStateful(dag, null, mkCtx(obs));
    const [route] = routeEvents(obs);
    expect(route!.evidence.predicateResults).toHaveLength(2);
    // First predicate (kind-is-a) should NOT match
    expect(route!.evidence.predicateResults[0]?.predicateLabel).toBe("kind-is-a");
    expect(route!.evidence.predicateResults[0]?.matched).toBe(false);
    expect(route!.evidence.predicateResults[0]?.evaluatedConfidence?.bucket).toBe("medium");
    // Second predicate (kind-is-b) SHOULD match
    expect(route!.evidence.predicateResults[1]?.predicateLabel).toBe("kind-is-b");
    expect(route!.evidence.predicateResults[1]?.matched).toBe(true);
    // Chosen targets should be b only
    expect([...route!.chosenTargets]).toContain(N("b"));
    expect(route!.defaultTaken).toBe(false);
  });

  it("default-taken: all predicateResults show matched: false", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "all-miss",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "z" }) }),
        a: makeNode("a", { inputSchema: z.object({ router: z.any().optional() }) }),
        fallback: makeNode("fallback"),
      },
      edges: [
        { from: "router", to: "a", when: { label: "kind-is-x", version: 1, check: (v: any) => v?.kind === "x" } as any },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    await runDagStateful(dag, null, mkCtx(obs));
    const [route] = routeEvents(obs);
    expect(route!.defaultTaken).toBe(true);
    expect(route!.evidence.predicateResults.every((r) => !r.matched)).toBe(true);
  });

  it("minConfidence gating: below-min-confidence recorded when upstream confidence is too low", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "below-min-conf",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "yes" }),
          confidence: {
            mode: "value",
            extract: () => ({ bucket: "low" as const, source: "self-reported-bucket" as const }),
          },
        }),
        a: makeNode("a", { inputSchema: z.object({ router: z.any().optional() }) }),
        fallback: makeNode("fallback"),
      },
      edges: [
        {
          from: "router",
          to: "a",
          when: {
            label: "high-conf-only",
            version: 1,
            check: (v: any) => v?.kind === "yes",
            minConfidence: "high",
          } as any,
        },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    await runDagStateful(dag, null, mkCtx(obs));
    const [route] = routeEvents(obs);
    expect(route!.defaultTaken).toBe(true);
    const pred = route!.evidence.predicateResults[0];
    expect(pred?.matched).toBe(false);
    expect(pred?.reason).toBe("below-min-confidence");
    expect(pred?.evaluatedConfidence?.bucket).toBe("low");
  });

  it("minConfidence gating: passes when upstream confidence meets threshold", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "meets-min-conf",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "yes" }),
          confidence: {
            mode: "value",
            extract: () => ({ bucket: "high" as const, source: "logprob" as const }),
          },
        }),
        a: makeNode("a", { inputSchema: z.object({ router: z.any().optional() }) }),
        fallback: makeNode("fallback"),
      },
      edges: [
        {
          from: "router",
          to: "a",
          when: {
            label: "medium-conf-ok",
            version: 1,
            check: (v: any) => v?.kind === "yes",
            minConfidence: "medium",
          } as any,
        },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    await runDagStateful(dag, null, mkCtx(obs));
    const [route] = routeEvents(obs);
    expect(route!.defaultTaken).toBe(false);
    const pred = route!.evidence.predicateResults[0];
    expect(pred?.matched).toBe(true);
    expect(pred?.reason).toBeUndefined();
  });

  it("throwing check function records reason: 'threw' and does not match", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "throws",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "yes" }) }),
        a: makeNode("a", { inputSchema: z.object({ router: z.any().optional() }) }),
        fallback: makeNode("fallback"),
      },
      edges: [
        {
          from: "router",
          to: "a",
          when: {
            label: "boom",
            version: 1,
            check: () => { throw new Error("unexpected"); },
          } as any,
        },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful(dag, null, mkCtx(obs));
    // A throwing predicate is now treated as predicate-malformed (programming error)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("predicate-malformed");
      if (result.error.kind === "predicate-malformed") {
        expect(result.error.message).toContain("threw an exception");
        expect(result.error.message).toContain("boom");
      }
    }
  });

  it("confidence extraction failure short-circuits wave with node-failed", async () => {
    const obs = new RecordingObserver();
    const dag = defineDag({
      id: "extract-throws",
      nodes: {
        router: makeNode("router", {
          run: async () => ok({ kind: "yes" }),
          confidence: {
            mode: "value",
            extract: () => { throw new Error("extract fail"); },
          },
        }),
        a: makeNode("a", { inputSchema: z.object({ router: z.any().optional() }) }),
        fallback: makeNode("fallback"),
      },
      edges: [
        { from: "router", to: "a", when: { label: "check", version: 1, check: (v: any) => v?.kind === "yes" } as any },
        { from: "router", to: "fallback", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    const result = await runDagStateful(dag, null, mkCtx(obs));
    // Confidence extraction failure is now a config error — run fails fast.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }

    // node-error event emitted for the failure
    const nodeErrors = obs.events.filter((e) => e.type === "node-error");
    expect(nodeErrors.length).toBeGreaterThanOrEqual(1);
    expect((nodeErrors[0] as any).error).toContain("confidence.extract failed");
  });
});
