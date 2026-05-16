import { describe, it, expect } from "bun:test";
import { emitRoutingDecisions } from "../dag-runtime/route-emission.js";
import { RecordingObserver } from "../observer/observer.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { NodeId, DagId, RunId } from "../types/ids.js";
import type { EdgeDef } from "../types/dag.js";
import type { DagMachineContext } from "../dag-runtime/types.js";
import { N, R, D } from "./_id-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeNodeDef = (overrides?: Partial<NodeDef<unknown, unknown>>): NodeDef<unknown, unknown> => ({
  id: N("n"),
  kind: "transform",
  inputSchema: { safeParse: (v: any) => ({ success: true, data: v }) } as any,
  outputSchema: { safeParse: (v: any) => ({ success: true, data: v }) } as any,
  requires: [] as any,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async () => ({ ok: true, value: null } as any),
  ...overrides,
});

const makeCtx = (observer: RecordingObserver): NodeContext => ({
  runId: R("r1"),
  dagId: D("d1"),
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

const conditionalEdge = (from: string, to: string, check: (v: any) => boolean): EdgeDef => ({
  from: N(from),
  to: N(to),
  kind: "conditional",
  when: { label: "test-pred", version: 1, check },
});

const defaultEdge = (from: string, to: string): EdgeDef => ({
  from: N(from),
  to: N(to),
  kind: "default",
});

const unconditionalEdge = (from: string, to: string): EdgeDef => ({
  from: N(from),
  to: N(to),
  kind: "unconditional",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitRoutingDecisions", () => {
  it("empty waveNodeIds → empty decisions, no earlyFailure", () => {
    const obs = new RecordingObserver();
    const result = emitRoutingDecisions(
      [],
      new Map(),
      new Map(),
      { outgoingByNode: new Map() } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    expect(result.decisions.size).toBe(0);
    expect(result.earlyFailure).toBeUndefined();
    expect(obs.events).toHaveLength(0);
  });

  it("node in wave but not in newOutputs → skipped", () => {
    const obs = new RecordingObserver();
    const result = emitRoutingDecisions(
      [N("a")],
      new Map(), // a has no output
      new Map([[N("a"), makeNodeDef()]]),
      { outgoingByNode: new Map([[N("a"), [conditionalEdge("a", "b", () => true), defaultEdge("a", "c")]]]) } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    expect(result.decisions.size).toBe(0);
    expect(obs.events).toHaveLength(0);
  });

  it("node with only unconditional edges → skipped (no routing needed)", () => {
    const obs = new RecordingObserver();
    const result = emitRoutingDecisions(
      [N("a")],
      new Map([[N("a"), { value: 1 }]]),
      new Map([[N("a"), makeNodeDef()]]),
      { outgoingByNode: new Map([[N("a"), [unconditionalEdge("a", "b")]]]) } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    expect(result.decisions.size).toBe(0);
    expect(obs.events).toHaveLength(0);
  });

  it("conditional edge matches → decisions has entry, route-decided emitted", () => {
    const obs = new RecordingObserver();
    const edges: EdgeDef[] = [
      conditionalEdge("a", "yes", () => true),
      defaultEdge("a", "no"),
    ];

    const result = emitRoutingDecisions(
      [N("a")],
      new Map([[N("a"), { value: "hi" }]]),
      new Map([[N("a"), makeNodeDef()]]),
      { outgoingByNode: new Map([[N("a"), edges]]) } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    expect(result.decisions.size).toBe(1);
    expect(result.decisions.has(N("a"))).toBe(true);
    expect(result.earlyFailure).toBeUndefined();

    const routeDecided = obs.events.filter((e) => e.type === "route-decided");
    expect(routeDecided).toHaveLength(1);
    expect((routeDecided[0] as any).chosenTargets).toContain(N("yes"));
  });

  it("pruned targets emit node-pruned events", () => {
    const obs = new RecordingObserver();
    const edges: EdgeDef[] = [
      conditionalEdge("a", "yes", () => true),
      conditionalEdge("a", "no", () => false),
      defaultEdge("a", "fallback"),
    ];

    emitRoutingDecisions(
      [N("a")],
      new Map([[N("a"), { value: "hi" }]]),
      new Map([[N("a"), makeNodeDef()]]),
      { outgoingByNode: new Map([[N("a"), edges]]) } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    const pruned = obs.events.filter((e) => e.type === "node-pruned");
    expect(pruned.length).toBeGreaterThanOrEqual(1);
    expect((pruned[0] as any).nodeId).toBe(N("no"));
  });

  it("confidence.extract throws → earlyFailure with node-crash", () => {
    const obs = new RecordingObserver();
    const nodeDef = makeNodeDef({
      confidence: {
        mode: "value",
        extract: () => { throw new Error("bad extractor"); },
      },
    });
    const edges: EdgeDef[] = [
      conditionalEdge("a", "yes", () => true),
      defaultEdge("a", "no"),
    ];

    const result = emitRoutingDecisions(
      [N("a")],
      new Map([[N("a"), { value: 1 }]]),
      new Map([[N("a"), nodeDef]]),
      { outgoingByNode: new Map([[N("a"), edges]]) } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    expect(result.earlyFailure).toBeDefined();
    expect(result.earlyFailure!.type).toBe("node-failed");
    expect(result.earlyFailure!.error.kind).toBe("node-crash");

    const nodeErrors = obs.events.filter((e) => e.type === "node-error");
    expect(nodeErrors).toHaveLength(1);
  });

  it("predicate throws → predicate-malformed earlyFailure", () => {
    const obs = new RecordingObserver();
    const edges: EdgeDef[] = [
      conditionalEdge("a", "yes", () => { throw new Error("pred-boom"); }),
      defaultEdge("a", "no"),
    ];

    const result = emitRoutingDecisions(
      [N("a")],
      new Map([[N("a"), { value: 1 }]]),
      new Map([[N("a"), makeNodeDef()]]),
      { outgoingByNode: new Map([[N("a"), edges]]) } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    expect(result.earlyFailure).toBeDefined();
    expect(result.earlyFailure!.error.kind).toBe("predicate-malformed");
  });

  it("multiple nodes in wave: routing only for nodes with conditional edges", () => {
    const obs = new RecordingObserver();
    const edges: EdgeDef[] = [
      conditionalEdge("b", "target", () => true),
      defaultEdge("b", "fallback"),
    ];

    const result = emitRoutingDecisions(
      [N("a"), N("b")],
      new Map([[N("a"), "out-a"], [N("b"), "out-b"]]),
      new Map([[N("a"), makeNodeDef()], [N("b"), makeNodeDef()]]),
      {
        outgoingByNode: new Map([
          [N("a"), [unconditionalEdge("a", "c")]],  // no conditional edges
          [N("b"), edges],                            // has conditional edges
        ]),
      } as any,
      makeCtx(obs),
      D("d1"),
      Date.now,
    );

    // Only b gets routing decisions
    expect(result.decisions.size).toBe(1);
    expect(result.decisions.has(N("b"))).toBe(true);
    expect(result.decisions.has(N("a"))).toBe(false);
  });
});
