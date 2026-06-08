import { resourceName, witness, witnessValue, mkWitness, RN } from "./_freshness-helpers.js";
/**
 * Phase 3 test — freshness witness: no-conflict case.
 *
 * Validates:
 * - A `reads` node with `extractWitness` emits a `witness-captured` event.
 * - A `writes` node with `extractConditionedOn` and `extractNewWitness` emits
 *   a `write-attempted` event.
 * - When there is no conflicting write, no `freshness-violation` event fires.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { N, R, D, NO_CONFIDENCE } from "./_id-helpers.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type {
  WitnessCapturedEvent,
  WriteAttemptedEvent,
  FreshnessViolationEvent,
  ObserverEvent,
} from "../types/events.js";
import type { Witness } from "../types/freshness.js";
import { ok } from "../types/result.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import type { RunId, DagId } from "../types/ids.js";

const mkCtx = (observer: RecordingObserver): NodeContext => ({
  runId: R("fresh-r1"),
  dagId: D("fresh-d"),
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("freshness witness — no conflict (Phase 3)", () => {
  it("reads node with extractWitness emits witness-captured event", async () => {
    const observer = new RecordingObserver();
    const readNode: NodeDef<unknown, { version: number }> = {
      id: N("reader"),
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.object({ version: z.number() }),
      requires: [],
      sideEffects: { kind: "reads", resource: RN("postgres:orders"), extractWitness: (output: unknown) => witnessValue("version", String((output as { version: number }).version)) },
      confidence: { mode: "none" },
      run: async () => ok({ version: 42 }),
    };
    const dag = defineDagFromArray({ id: "fw-read", nodes: [readNode], edges: [] });
    await runDagStateful(dag, null, mkCtx(observer));

    const witnessCaptured = observer.events.filter(
      (e): e is WitnessCapturedEvent => e.type === "witness-captured",
    );
    expect(witnessCaptured).toHaveLength(1);
    expect(witnessCaptured[0]!.nodeId).toBe(N("reader"));
    expect(witnessCaptured[0]!.witness).toEqual(witness("version", "postgres:orders", "42"));
    expect(witnessCaptured[0]!.capturedAtMs).toBeGreaterThan(0);
  });

  it("writes node with extractConditionedOn and extractNewWitness emits write-attempted event", async () => {
    const observer = new RecordingObserver();

    const readNode: NodeDef<unknown, { version: number; data: string }> = {
      id: N("reader"),
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.object({ version: z.number(), data: z.string() }),
      requires: [],
      sideEffects: { kind: "reads", resource: RN("postgres:orders"), extractWitness: (output: unknown) => witnessValue("version", String((output as { version: number }).version)) },
      confidence: { mode: "none" },
      run: async () => ok({ version: 42, data: "order-data" }),
    };

    const writeNode: NodeDef<{ version: number; data: string }, { newVersion: number }> = {
      id: N("writer"),
      kind: "transform",
      inputSchema: z.object({ version: z.number(), data: z.string() }),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: { kind: "writes", resource: RN("postgres:orders"), extractConditionedOn: (input: unknown) => witness("version", "postgres:orders", String((input as { version: number }).version)), extractNewWitness: (output: unknown) => witnessValue("version", String((output as { newVersion: number }).newVersion)) },
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 43 }),
    };

    const dag = defineDagFromArray({
      id: "fw-write",
      nodes: [readNode, writeNode],
      edges: [{ from: "reader", to: "writer" }],
    });
    await runDagStateful(dag, null, mkCtx(observer));

    const writeAttempted = observer.events.filter(
      (e): e is WriteAttemptedEvent => e.type === "write-attempted",
    );
    expect(writeAttempted).toHaveLength(1);
    expect(writeAttempted[0]!.nodeId).toBe(N("writer"));
    expect(writeAttempted[0]!.conditionedOn).toEqual(witness("version", "postgres:orders", "42"));
    expect(writeAttempted[0]!.newWitness).toEqual(witness("version", "postgres:orders", "43"));

    // No freshness violation expected
    const violations = observer.events.filter(
      (e): e is FreshnessViolationEvent => e.type === "freshness-violation",
    );
    expect(violations).toHaveLength(0);
  });

  it("reads node without extractWitness does NOT emit witness-captured", async () => {
    const observer = new RecordingObserver();
    const readNode: NodeDef<unknown, unknown> = {
      id: N("reader-no-witness"),
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: { kind: "reads", resource: RN("postgres:orders") },
      confidence: { mode: "none" },
      // No extractWitness — freshness tracking silently skipped
      run: async () => ok({ version: 42 }),
    };
    const dag = defineDagFromArray({ id: "fw-no-witness", nodes: [readNode], edges: [] });
    await runDagStateful(dag, null, mkCtx(observer));

    const witnessCaptured = observer.events.filter(
      (e): e is WitnessCapturedEvent => e.type === "witness-captured",
    );
    expect(witnessCaptured).toHaveLength(0);
  });

  it("reads node skipped via checkpoint does NOT emit witness-captured", async () => {
    const observer = new RecordingObserver();
    const readNode: NodeDef<unknown, { version: number }> = {
      id: N("reader"),
      kind: "fetch",
      inputSchema: z.unknown(),
      outputSchema: z.object({ version: z.number() }),
      requires: [],
      sideEffects: { kind: "reads", resource: RN("postgres:orders"), extractWitness: (output: unknown) => witnessValue("version", String((output as { version: number }).version)) },
      confidence: { mode: "none" },
      run: async () => { throw new Error("should not be called"); },
    };
    const dag = defineDagFromArray({ id: "fw-checkpoint", nodes: [readNode], edges: [] });

    // Provide a checkpoint so the node is skipped
    const checkpoint = new Map<string, unknown>([["reader", { version: 99 }]]);
    await runDagStateful(dag, null, mkCtx(observer), { resumeCheckpoint: checkpoint });

    // Node was skipped — extractWitness should NOT have been called
    const witnessCaptured = observer.events.filter(
      (e): e is WitnessCapturedEvent => e.type === "witness-captured",
    );
    expect(witnessCaptured).toHaveLength(0);

    // Verify the node was actually skipped
    const skipped = observer.events.filter(
      (e) => e.type === "node-skipped",
    );
    expect(skipped).toHaveLength(1);
  });
});
