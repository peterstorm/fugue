import { witness, witnessValue, RN } from "./_freshness-helpers.js";
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
import { N, R, D } from "./_id-helpers.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type {
  WitnessCapturedEvent,
  WriteAttemptedEvent,
  FreshnessViolationEvent,
} from "../types/events.js";
import { ok } from "../types/result.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";
import { testNodeContext } from "./_context-factories.js";

const mkCtx = (observer: RecordingObserver): NodeContext =>
  testNodeContext({ runId: R("fresh-r1"), dagId: D("fresh-d"), observer });

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
    const dag = defineDagFromArray({ id: "fw-read", nodes: [readNode], edges: [{ from: DAG_INPUT, to: "reader" }] });
    await runDagStateful(dag, null, mkCtx(observer));

    const witnessCaptured = observer.events.filter(
      (e): e is WitnessCapturedEvent => e.type === "witness-captured",
    );
    expect(witnessCaptured).toHaveLength(1);
    expect(witnessCaptured[0]!.nodeId).toBe(N("reader"));
    expect(witnessCaptured[0]!.witness).toEqual(witness("version", RN("postgres:orders"), "42"));
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
      sideEffects: { kind: "writes", resource: RN("postgres:orders"), extractConditionedOn: (input: unknown) => witness("version", RN("postgres:orders"), String((input as { version: number }).version)), extractNewWitness: (output: unknown) => witnessValue("version", String((output as { newVersion: number }).newVersion)) },
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 43 }),
    };

    const dag = defineDagFromArray({
      id: "fw-write",
      nodes: [readNode, writeNode],
      edges: [{ from: DAG_INPUT, to: "reader" }, { from: "reader", to: "writer" }],
    });
    await runDagStateful(dag, null, mkCtx(observer));

    const writeAttempted = observer.events.filter(
      (e): e is WriteAttemptedEvent => e.type === "write-attempted",
    );
    expect(writeAttempted).toHaveLength(1);
    expect(writeAttempted[0]!.nodeId).toBe(N("writer"));
    expect(writeAttempted[0]!.conditionedOn).toEqual(witness("version", RN("postgres:orders"), "42"));
    expect(writeAttempted[0]!.newWitness).toEqual(witness("version", RN("postgres:orders"), "43"));

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
    const dag = defineDagFromArray({ id: "fw-no-witness", nodes: [readNode], edges: [{ from: DAG_INPUT, to: "reader-no-witness" }] });
    await runDagStateful(dag, null, mkCtx(observer));

    const witnessCaptured = observer.events.filter(
      (e): e is WitnessCapturedEvent => e.type === "witness-captured",
    );
    expect(witnessCaptured).toHaveLength(0);
  });

  it("reads node resumed from a node-output checkpoint still completes owed freshness bookkeeping", async () => {
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
    const dag = defineDagFromArray({ id: "fw-checkpoint", nodes: [readNode], edges: [{ from: DAG_INPUT, to: "reader" }] });

    // Provide a checkpoint so the node is skipped
    const checkpoint = new Map<string, unknown>([["reader", { version: 99 }]]);
    await runDagStateful(dag, null, mkCtx(observer), { resumeCheckpoint: checkpoint });

    // The computation was skipped, but the node-output checkpoint is written
    // before post-wave freshness. Resume must therefore reconstruct the witness.
    const witnessCaptured = observer.events.filter(
      (e): e is WitnessCapturedEvent => e.type === "witness-captured",
    );
    expect(witnessCaptured).toHaveLength(1);
    expect(witnessCaptured[0]?.nodeId).toBe(N("reader"));

    // Verify only the node computation was skipped.
    const skipped = observer.events.filter(
      (e) => e.type === "node-skipped",
    );
    expect(skipped).toHaveLength(1);
  });
});
