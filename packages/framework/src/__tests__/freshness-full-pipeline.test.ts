/**
 * Wave 6 — Test gap coverage for review remediation.
 *
 * 6.1: checkFreshness tested with non-empty witnessEvents
 * 6.2: Full pipeline: reads → witness → violation → human with priorWitnesses
 * 6.3: Extractor failure during DAG run (extractWitness throws)
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { N, R, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { checkFreshness, InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import { RecordingObserver } from "../observer/observer.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { ok } from "../types/result.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { WitnessCapturedEvent, WriteAttemptedEvent, FreshnessViolationEvent, HumanInterventionEvent } from "../types/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform" as const,
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async (input: unknown) => ok(input),
  requires: [] as const,
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 6.1 — checkFreshness with non-empty witnessEvents
// ---------------------------------------------------------------------------

describe("checkFreshness with witness events in timeline", () => {
  test("witness events interleaved with writes do not affect conflict detection", () => {
    const witnessEvents: WitnessCapturedEvent[] = [
      {
        type: "witness-captured",
        runId: R("r1"),
        dagId: D("d"),
        nodeId: N("reader"),
        witness: { kind: "version", resource: "postgres:orders", value: "1" },
        capturedAtMs: 100,
        timestamp: new Date(100),
      },
      {
        type: "witness-captured",
        runId: R("r1"),
        dagId: D("d"),
        nodeId: N("reader2"),
        witness: { kind: "version", resource: "postgres:orders", value: "2" },
        capturedAtMs: 300,
        timestamp: new Date(300),
      },
    ];

    const writeEvents: WriteAttemptedEvent[] = [
      {
        type: "write-attempted",
        runId: R("r1"),
        dagId: D("d"),
        nodeId: N("writer1"),
        conditionedOn: { kind: "version", resource: "postgres:orders", value: "1" },
        newWitness: { kind: "version", resource: "postgres:orders", value: "2" },
        succeededAtMs: 200,
        timestamp: new Date(200),
      },
      {
        type: "write-attempted",
        runId: R("r2"),
        dagId: D("d"),
        nodeId: N("writer2"),
        conditionedOn: { kind: "version", resource: "postgres:orders", value: "2" },
        newWitness: { kind: "version", resource: "postgres:orders", value: "3" },
        succeededAtMs: 400,
        timestamp: new Date(400),
      },
    ];

    // No conflicts — each write is conditioned on the latest version
    const result = checkFreshness(witnessEvents, writeEvents);
    expect(result.conflicts).toHaveLength(0);
  });

  test("witness events do not mask conflicts between writes", () => {
    const witnessEvents: WitnessCapturedEvent[] = [
      {
        type: "witness-captured",
        runId: R("r1"),
        dagId: D("d"),
        nodeId: N("reader"),
        witness: { kind: "version", resource: "postgres:orders", value: "1" },
        capturedAtMs: 50,
        timestamp: new Date(50),
      },
    ];

    const writeEvents: WriteAttemptedEvent[] = [
      {
        type: "write-attempted",
        runId: R("r1"),
        dagId: D("d"),
        nodeId: N("writer1"),
        conditionedOn: { kind: "version", resource: "postgres:orders", value: "1" },
        newWitness: { kind: "version", resource: "postgres:orders", value: "2" },
        succeededAtMs: 100,
        timestamp: new Date(100),
      },
      {
        type: "write-attempted",
        runId: R("r2"),
        dagId: D("d"),
        nodeId: N("writer2"),
        // Stale! Conditioned on "1" but "2" already written
        conditionedOn: { kind: "version", resource: "postgres:orders", value: "1" },
        newWitness: { kind: "version", resource: "postgres:orders", value: "3" },
        succeededAtMs: 200,
        timestamp: new Date(200),
      },
    ];

    const result = checkFreshness(witnessEvents, writeEvents);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.writeNodeId).toBe(N("writer2"));
    expect(result.conflicts[0]!.conditionedOnWitness.value).toBe("1");
    expect(result.conflicts[0]!.conflictingWrite.newWitness.value).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// 6.2 — Full pipeline: reads → witness → violation → human with priorWitnesses
// ---------------------------------------------------------------------------

describe("Full pipeline: reads → freshness violation → human intervention", () => {
  test("human-intervention event carries stale witness in priorWitnesses after violation", async () => {
    // Pre-seed the freshness index with a conflicting write (simulates another process)
    const freshnessIndex = new InMemoryFreshnessIndex();
    await freshnessIndex.recordWrite({
      type: "write-attempted",
      runId: R("other-run"),
      dagId: D("pipeline"),
      nodeId: N("other-writer"),
      conditionedOn: { kind: "version", resource: "postgres:orders", value: "42" },
      newWitness: { kind: "version", resource: "postgres:orders", value: "43" },
      succeededAtMs: 500,
      timestamp: new Date(500),
    });

    const dag = defineDag({
      id: "pipeline",
      nodes: {
        reader: makeNode("reader", {
          sideEffects: { kind: "reads", resource: "postgres:orders", extractWitness: (output: unknown) => ({
            kind: "version" as const,
            resource: "postgres:orders",
            value: String((output as { version: number }).version),
          }) },
          run: async () => ok({ version: 42 }),
        }),
        writer: makeNode("writer", {
          sideEffects: { kind: "writes", resource: "postgres:orders", extractConditionedOn: (input: unknown) => ({
            kind: "version" as const,
            resource: "postgres:orders",
            value: String((input as { version: number }).version),
          }), extractNewWitness: (output: unknown) => ({
            kind: "version" as const,
            resource: "postgres:orders",
            value: String((output as { newVersion: number }).newVersion),
          }) },
          run: async () => ok({ newVersion: 44 }),
        }),
        review: makeNode("review", {
          humanReview: { prompt: "Approve write?" },
        }),
      },
      edges: [
        { from: "reader", to: "writer" },
        { from: "writer", to: "review" },
      ],
    });

    const observer = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: R("run-pipeline"),
      dagId: D("pipeline"),
      observer,
    });

    const result = await runDagStateful(dag, null, ctx, {
      onHumanReview: async () => ({ action: "approve" as const, actor: "alice" }),
      freshnessIndex,
    });

    expect(result.ok).toBe(true);

    // Verify witness-captured event
    const witnessCaptured = observer.events.find(
      (e) => e.type === "witness-captured",
    ) as WitnessCapturedEvent | undefined;
    expect(witnessCaptured).toBeDefined();
    expect(witnessCaptured!.witness.value).toBe("42");

    // Verify freshness-violation event
    const violation = observer.events.find(
      (e) => e.type === "freshness-violation",
    ) as FreshnessViolationEvent | undefined;
    expect(violation).toBeDefined();
    expect(violation!.resource).toBe("postgres:orders");
    expect(violation!.conditionedOnWitness.value).toBe("42");
    expect(violation!.conflictingWrite.newWitness.value).toBe("43");

    // Verify write-attempted event
    const writeAttempted = observer.events.find(
      (e) => e.type === "write-attempted",
    ) as WriteAttemptedEvent | undefined;
    expect(writeAttempted).toBeDefined();
    expect(writeAttempted!.newWitness.value).toBe("44");

    // Verify human-intervention event carries stale witness in context
    const intervention = observer.events.find(
      (e) => e.type === "human-intervention",
    ) as HumanInterventionEvent | undefined;
    expect(intervention).toBeDefined();
    expect(intervention!.actor).toBe("alice");
    expect(intervention!.context.priorWitnesses).toContainEqual({
      kind: "version",
      resource: "postgres:orders",
      value: "42",
    });
  });
});

// ---------------------------------------------------------------------------
// 6.3 — Extractor failure during DAG run (fail-closed)
// Extractor failures are authoring bugs. Proceeding without witness data
// would allow stale writes downstream, so the run aborts.
// ---------------------------------------------------------------------------

describe("Freshness extractor failure (fail-closed)", () => {
  test("extractWitness throwing fails the run", async () => {
    const dag = defineDag({
      id: "extractor-fail",
      nodes: {
        reader: makeNode("reader", {
          sideEffects: { kind: "reads", resource: "postgres:orders", extractWitness: () => {
            throw new Error("extractor boom");
          } },
          run: async () => ok({ data: "read" }),
        }),
        next: makeNode("next"),
      },
      edges: [{ from: "reader", to: "next" }],
    });

    const observer = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: R("run-fail"),
      dagId: D("extractor-fail"),
      observer,
    });

    const result = await runDagStateful(dag, null, ctx);

    // Run fails — fail-closed: broken extractor aborts the wave
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }

    // node-error event emitted for the failure
    const nodeError = observer.events.find(
      (e) => e.type === "node-error",
    );
    expect(nodeError).toBeDefined();
  });

  test("extractConditionedOn throwing fails the run", async () => {
    const dag = defineDag({
      id: "conditioned-fail",
      nodes: {
        writer: makeNode("writer", {
          sideEffects: { kind: "writes", resource: "postgres:orders", extractConditionedOn: () => {
            throw new Error("conditionedOn boom");
          }, extractNewWitness: () => ({
            kind: "version" as const,
            resource: "postgres:orders",
            value: "99",
          }) },
          run: async () => ok({ written: true }),
        }),
      },
      edges: [],
    });

    const observer = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: R("run-conditioned-fail"),
      dagId: D("conditioned-fail"),
      observer,
    });

    const result = await runDagStateful(dag, null, ctx);

    // Run fails — fail-closed: broken extractor aborts the wave
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }

    // No write-attempted event emitted (failed before reaching write)
    const writeAttempted = observer.events.find(
      (e) => e.type === "write-attempted",
    );
    expect(writeAttempted).toBeUndefined();
  });
});
