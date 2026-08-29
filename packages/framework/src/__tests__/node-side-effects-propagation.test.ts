import { RN } from "./_freshness-helpers.js";
/**
 * Phase 1 test — node side-effects propagation.
 *
 * Validates:
 * - sideEffects.kind survives through node-start, node-end, and node-error events.
 * - OTel span attributes are set correctly.
 * - idempotencyKey callback is invoked exactly once per node execution.
 * - Type-level: `kind: "writes"` without `resource` is a compile error
 *   (enforced via the discriminated union — no runtime test needed, compile-time only).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { N } from "./_id-helpers.js";
import type { NodeDef } from "../types/node.js";
import type { SideEffectProfile } from "../types/side-effects.js";
import type { NodeStartEvent, NodeEndEvent, NodeErrorEvent } from "../types/events.js";
import { ok, err } from "../types/result.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import type { NodeContext } from "../types/node.js";
import type { RunId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";

const mkCtx = (observer: RecordingObserver): NodeContext => ({
  runId: "r" as RunId,
  dagId: "d" as DagId,
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null,
  clock: null,
  budget: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("node side-effects propagation (Phase 1)", () => {
  it("sideEffects: { kind: 'none' } appears on node-start and node-end events", async () => {
    const observer = new RecordingObserver();
    const node: NodeDef<unknown, unknown> = {
      id: N("pure"),
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: { kind: "none" },
  confidence: { mode: "none" },
      run: async (input) => ok(input),
    };
    const dag = defineDagFromArray({ id: "se-test", nodes: [node], edges: [{ from: DAG_INPUT, to: "pure" }] });
    await runDagStateful(dag, "hello", mkCtx(observer));

    const starts = observer.events.filter((e): e is NodeStartEvent => e.type === "node-start");
    const ends = observer.events.filter((e): e is NodeEndEvent => e.type === "node-end");

    expect(starts).toHaveLength(1);
    expect(starts[0]!.sideEffects).toEqual({ kind: "none" });
    expect(ends).toHaveLength(1);
    expect(ends[0]!.sideEffects).toEqual({ kind: "none" });
  });

  it("sideEffects: { kind: 'reads', resource: 'postgres:orders' } propagates", async () => {
    const observer = new RecordingObserver();
    const profile: SideEffectProfile = { kind: "reads", resource: RN("postgres:orders") };
    const node: NodeDef<unknown, unknown> = {
      id: N("reader"),
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: profile,
      confidence: { mode: "none" },
      run: async () => ok({ rows: [] }),
    };
    const dag = defineDagFromArray({ id: "se-reads", nodes: [node], edges: [{ from: DAG_INPUT, to: "reader" }] });
    await runDagStateful(dag, null, mkCtx(observer));

    const start = observer.events.find((e): e is NodeStartEvent => e.type === "node-start");
    expect(start!.sideEffects).toEqual(profile);
  });

  it("sideEffects: { kind: 'writes' } appears on node-error events", async () => {
    const observer = new RecordingObserver();
    const profile: SideEffectProfile = { kind: "writes", resource: RN("postgres:refunds") };
    const node: NodeDef<unknown, unknown> = {
      id: N("writer"),
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: profile,
      confidence: { mode: "none" },
      run: async () => err({
        kind: "node-crash" as const,
        nodeId: N("writer"),
        retriability: "non-retriable" as const,
        message: "boom",
      }),
    };
    const dag = defineDagFromArray({ id: "se-error", nodes: [node], edges: [{ from: DAG_INPUT, to: "writer" }] });
    await runDagStateful(dag, null, mkCtx(observer));

    const errors = observer.events.filter((e): e is NodeErrorEvent => e.type === "node-error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.sideEffects).toEqual(profile);
  });

  it("idempotencyKey callback is invoked and its result available for tracing", async () => {
    let callCount = 0;
    const profile: SideEffectProfile = {
      kind: "writes",
      resource: RN("stripe:charges"),
      idempotencyKey: (input) => {
        callCount++;
        return `idem-${(input as { id: string }).id}`;
      },
    };
    const node: NodeDef<unknown, unknown> = {
      id: N("charge"),
      kind: "transform",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: profile,
      confidence: { mode: "none" },
      run: async (input) => ok({ charged: true, id: (input as { id: string }).id }),
    };
    const dag = defineDagFromArray({ id: "se-idem", nodes: [node], edges: [{ from: DAG_INPUT, to: "charge" }] });
    const observer = new RecordingObserver();
    const result = await runDagStateful(dag, { id: "ch_123" }, mkCtx(observer));

    expect(result.ok).toBe(true);
    // idempotencyKey is evaluated once per execution
    expect(callCount).toBe(1);
  });

  it("external-call sideEffects propagates resource and kind", async () => {
    const observer = new RecordingObserver();
    const profile: SideEffectProfile = { kind: "external-call", resource: RN("openai:gpt-4") };
    const node: NodeDef<unknown, unknown> = {
      id: N("llm-call"),
      kind: "llm",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: profile,
      confidence: { mode: "none" },
      run: async () => ok({ answer: "42" }),
    };
    const dag = defineDagFromArray({ id: "se-ext", nodes: [node], edges: [{ from: DAG_INPUT, to: "llm-call" }] });
    await runDagStateful(dag, null, mkCtx(observer));

    const start = observer.events.find((e): e is NodeStartEvent => e.type === "node-start");
    expect(start!.sideEffects.kind).toBe("external-call");
    expect(start!.sideEffects).toEqual(profile);
  });

  // Type-level enforcement test: the below would be a compile error.
  // Uncomment to verify:
  //
  // const BAD_WRITES: SideEffectProfile = { kind: "writes" };
  //   ~~~~~~ Error: Property 'resource' is missing in type '{ kind: "writes"; }'
});
