import { resourceName, witness, witnessValue, mkWitness, RN } from "./_freshness-helpers.js";
/**
 * Phase 3 test — freshness witness: conflict detected.
 *
 * Validates:
 * - When two DAG runs write to the same resource and the second is conditioned
 *   on a stale witness, a `freshness-violation` event is emitted.
 * - The violation event carries the correct conflicting write metadata.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { N, R, D } from "./_id-helpers.js";
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
import { InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import type { RunId, DagId } from "../types/ids.js";

const mkCtx = (observer: RecordingObserver, runId: string): NodeContext => ({
  runId: R(runId),
  dagId: D("conflict-d"),
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("freshness witness — conflict detected (Phase 3)", () => {
  it("detects stale-witness conflict across two sequential runs sharing a freshness index", async () => {
    // Shared freshness index across runs (simulates single-process multi-run)
    const freshnessIndex = new InMemoryFreshnessIndex();

    // --- Run 1: reads v42, writes v43 ---
    const observer1 = new RecordingObserver();
    const writeNodeRun1: NodeDef<unknown, { newVersion: number }> = {
      id: N("writer"),
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: { kind: "writes", resource: RN("postgres:orders"), extractConditionedOn: () => (witness("version", RN("postgres:orders"), "42")), extractNewWitness: (output: unknown) => witnessValue("version", String((output as { newVersion: number }).newVersion)) },
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 43 }),
    };

    const dag1 = defineDagFromArray({
      id: "conflict-dag",
      nodes: [writeNodeRun1],
      edges: [],
    });
    await runDagStateful(dag1, null, mkCtx(observer1, "run-1"), {
      freshnessIndex,
    } as any);

    // Run 1 should NOT have a violation (no prior writes)
    const violations1 = observer1.events.filter(
      (e): e is FreshnessViolationEvent => e.type === "freshness-violation",
    );
    expect(violations1).toHaveLength(0);

    // Run 1 should have written v43
    const writes1 = observer1.events.filter(
      (e): e is WriteAttemptedEvent => e.type === "write-attempted",
    );
    expect(writes1).toHaveLength(1);
    expect(writes1[0]!.newWitness.value).toBe("43");

    // --- Run 2: conditioned on v42 (stale!), writes v44 ---
    const observer2 = new RecordingObserver();
    const writeNodeRun2: NodeDef<unknown, { newVersion: number }> = {
      id: N("writer"),
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: { kind: "writes", resource: RN("postgres:orders"), extractConditionedOn: () => (witness("version", RN("postgres:orders"), "42")), extractNewWitness: (output: unknown) => witnessValue("version", String((output as { newVersion: number }).newVersion)) },
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 44 }),
    };

    const dag2 = defineDagFromArray({
      id: "conflict-dag",
      nodes: [writeNodeRun2],
      edges: [],
    });
    await runDagStateful(dag2, null, mkCtx(observer2, "run-2"), {
      freshnessIndex,
    } as any);

    // Run 2 SHOULD have a freshness violation
    const violations2 = observer2.events.filter(
      (e): e is FreshnessViolationEvent => e.type === "freshness-violation",
    );
    expect(violations2).toHaveLength(1);
    expect(violations2[0]!.nodeId).toBe(N("writer"));
    expect(violations2[0]!.resource).toBe("postgres:orders");
    expect(violations2[0]!.conditionedOnWitness.value).toBe("42");
    expect(violations2[0]!.conflictingWrite.newWitness.value).toBe("43");
    expect(violations2[0]!.conflictingWrite.runId).toBe(R("run-1"));

    // Run 2 should still have proceeded with the write (non-blocking)
    const writes2 = observer2.events.filter(
      (e): e is WriteAttemptedEvent => e.type === "write-attempted",
    );
    expect(writes2).toHaveLength(1);
    expect(writes2[0]!.newWitness.value).toBe("44");
  });

  it("no violation when conditioned-on witness matches latest write", async () => {
    const freshnessIndex = new InMemoryFreshnessIndex();

    // Run 1: writes v43
    const observer1 = new RecordingObserver();
    const writeNodeRun1: NodeDef<unknown, { newVersion: number }> = {
      id: N("writer"),
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: { kind: "writes", resource: RN("postgres:orders"), extractConditionedOn: () => (witness("version", RN("postgres:orders"), "42")), extractNewWitness: () => (witnessValue("version", "43")) },
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 43 }),
    };

    const dag1 = defineDagFromArray({
      id: "no-conflict",
      nodes: [writeNodeRun1],
      edges: [],
    });
    await runDagStateful(dag1, null, mkCtx(observer1, "run-a"), {
      freshnessIndex,
    } as any);

    // Run 2: conditioned on v43 (matches latest) — no violation
    const observer2 = new RecordingObserver();
    const writeNodeRun2: NodeDef<unknown, { newVersion: number }> = {
      id: N("writer"),
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.object({ newVersion: z.number() }),
      requires: [],
      sideEffects: { kind: "writes", resource: RN("postgres:orders"), extractConditionedOn: () => (witness("version", RN("postgres:orders"), "43")), extractNewWitness: () => (witnessValue("version", "44")) },
      confidence: { mode: "none" },
      run: async () => ok({ newVersion: 44 }),
    };

    const dag2 = defineDagFromArray({
      id: "no-conflict",
      nodes: [writeNodeRun2],
      edges: [],
    });
    await runDagStateful(dag2, null, mkCtx(observer2, "run-b"), {
      freshnessIndex,
    } as any);

    const violations2 = observer2.events.filter(
      (e): e is FreshnessViolationEvent => e.type === "freshness-violation",
    );
    expect(violations2).toHaveLength(0);
  });
});
