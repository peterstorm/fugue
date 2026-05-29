import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { ok, err, runDag, createTransformNode, FakeLlmClient, RecordingObserver, makeNodeContext, runId, nodeId, dagId, frameworkError } from "@fugue/framework";
import type { CheckpointWriter } from "@fugue/framework";
import type { NodeContext, DagDef } from "@fugue/framework";
import type { SummaryResponse } from "../schemas/response.js";
import type { SynthesisOutput } from "../schemas/summary.js";
import { JsonFixtureSource } from "../sources/json-fixture-source.js";
import { createSummaryDag } from "../dag/summary-dag.js";
import { join } from "node:path";
import { defineDag, defineDagFromArray } from "@fugue/framework";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures/customers");

// --- Helpers ---

const collectingObserver = () => {
  const observer = new RecordingObserver();
  return { observer, events: observer.events };
};

const fakeSynthesisOutput: SynthesisOutput = {
  overallSentiment: "positive",
  sentimentScore: 0.7,
  keyTopics: ["billing", "product"],
  summary: "Customer had positive interactions.",
  actionItems: ["Follow up"],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
};

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext =>
  makeNodeContext({
    runId: runId("test-run"),
    dagId: "test-dag",
    prompts: { get: (_name: string) => "prompt template" },
    llm: new FakeLlmClient((_req: any) => fakeSynthesisOutput),
    ...overrides,
  });

// --- Full observability flow ---

describe("E2E observability flow", () => {
  test("full DAG run emits RunStart, NodeStart/End per node, RunEnd(ok)", async () => {
    const { observer, events } = collectingObserver();
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "cust-001");

    const ctx = makeCtx({
      observer,
      runId: runId("e2e-obs-run"),
      dagId: dag.id,
    });

    const result = await runDag<{ customerId: string }, SummaryResponse>(
      dag,
      { customerId: "cust-001" },
      ctx,
    );

    expect(result.ok).toBe(true);

    // RunStart
    const runStart = events.find((e) => e.type === "run-start");
    expect(runStart).toBeDefined();
    expect(runStart!.runId).toBe(runId("e2e-obs-run"));
    expect(runStart!.dagId).toBe(dagId("customer-summary"));

    // RunEnd with ok
    const runEnd = events.find((e) => e.type === "run-end");
    expect(runEnd).toBeDefined();
    expect(runEnd!.status).toBe("ok");
    expect(typeof runEnd!.duration).toBe("number");

    // NodeStart/NodeEnd for each executed node
    const nodeStarts = events.filter((e) => e.type === "node-start");
    const nodeEnds = events.filter((e) => e.type === "node-end");
    expect(nodeStarts.length).toBeGreaterThanOrEqual(3);
    expect(nodeEnds.length).toBeGreaterThanOrEqual(3);

    // All events have required fields
    for (const ns of nodeStarts) {
      expect(ns.runId).toBe(runId("e2e-obs-run"));
      expect(ns.dagId).toBe(dagId("customer-summary"));
      expect(typeof ns.nodeId).toBe("string");
    }

    // Event order: run-start first, run-end last
    expect(events[0].type).toBe("run-start");
    expect(events[events.length - 1].type).toBe("run-end");

    // All 4 DAG nodes should appear in node-end events
    const endedIds = nodeEnds.map((e) => e.nodeId).sort();
    expect(endedIds).toContain(nodeId("fetch-crm"));
    expect(endedIds).toContain(nodeId("extract-features"));
    expect(endedIds).toContain(nodeId("assemble-response"));
  });
});

// --- Resume integration (SC-008) ---

describe("E2E resume integration (SC-008)", () => {
  test("resume skips checkpointed nodes, only re-runs uncompleted ones", async () => {
    const { observer, events } = collectingObserver();
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "cust-001");

    // First run the DAG normally to get real checkpoint data for first 2 nodes
    const firstRunObserver = new RecordingObserver();
    const firstCtx = makeCtx({
      observer: firstRunObserver,
      runId: runId("first-run"),
      dagId: dag.id,
    });

    const firstResult = await runDag<{ customerId: string }, SummaryResponse>(
      dag,
      { customerId: "cust-001" },
      firstCtx,
    );
    expect(firstResult.ok).toBe(true);

    // Extract actual outputs for fetch-crm and extract-features
    const fetchEndEvent = firstRunObserver.events.find((e) => e.type === "node-end" && (e as any).nodeId === "fetch-crm");
    const extractEndEvent = firstRunObserver.events.find((e) => e.type === "node-end" && (e as any).nodeId === "extract-features");
    expect(fetchEndEvent).toBeDefined();
    expect(extractEndEvent).toBeDefined();

    const checkpoint = new Map<string, unknown>([
      ["fetch-crm", (fetchEndEvent as any)!.output],
      ["extract-features", (extractEndEvent as any)!.output],
    ]);

    // Resume run
    const ctx = makeCtx({
      observer,
      runId: runId("resume-run"),
      dagId: dag.id,
    });

    const result = await runDag(dag, undefined, ctx, {
      resume: { runId: runId("resume-run"), checkpoint },
    });

    expect(result.ok).toBe(true);

    // Checkpointed nodes should be skipped
    const skipped = events.filter((e) => e.type === "node-skipped");
    const skippedIds = skipped.map((e) => e.nodeId).sort();
    expect(skippedIds).toContain(nodeId("fetch-crm"));
    expect(skippedIds).toContain(nodeId("extract-features"));

    // Skipped nodes should NOT have node-start events
    const startedIds = events.filter((e) => e.type === "node-start").map((e) => e.nodeId);
    expect(startedIds).not.toContain(nodeId("fetch-crm"));
    expect(startedIds).not.toContain(nodeId("extract-features"));

    // Remaining nodes should run
    expect(startedIds).toContain(nodeId("synthesize"));
    expect(startedIds).toContain(nodeId("assemble-response"));

    // All skipped events have reason "checkpoint"
    expect(skipped.every((e) => e.reason === "checkpoint")).toBe(true);

    // RunEnd with ok
    const runEnd = events.find((e) => e.type === "run-end");
    expect(runEnd!.status).toBe("ok");
  });

  test("resume with all nodes checkpointed does zero work", async () => {
    const { observer, events } = collectingObserver();
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "cust-001");

    // Run first to get all outputs
    const firstRunObserver2 = new RecordingObserver();
    const firstCtx = makeCtx({
      observer: firstRunObserver2,
      runId: runId("full-run"),
      dagId: dag.id,
    });
    const firstResult = await runDag<{ customerId: string }, SummaryResponse>(
      dag, { customerId: "cust-001" }, firstCtx,
    );
    expect(firstResult.ok).toBe(true);

    // Checkpoint ALL nodes
    const nodeEndEvents = firstRunObserver2.events.filter((e) => e.type === "node-end");
    const checkpoint = new Map<string, unknown>(
      nodeEndEvents.map((e) => [(e as any).nodeId as string, (e as any).output]),
    );

    const ctx = makeCtx({
      observer,
      runId: runId("full-resume"),
      dagId: dag.id,
    });

    const result = await runDag(dag, undefined, ctx, {
      resume: { runId: runId("full-resume"), checkpoint },
    });
    expect(result.ok).toBe(true);

    // All nodes should be skipped
    const skipped = events.filter((e) => e.type === "node-skipped");
    expect(skipped.length).toBe(5);

    // Zero node-start events (no re-execution)
    const starts = events.filter((e) => e.type === "node-start");
    expect(starts.length).toBe(0);
  });
});

// --- Framework-level resume with simple 3-node DAG ---

describe("Framework resume with InMemoryCheckpointer pattern", () => {
  test("3-node linear DAG: resume after node 2 failure skips completed nodes", async () => {
    const log: string[] = [];
    const { observer, events } = collectingObserver();

    const dag = defineDagFromArray({
      id: "resume-3node",
      nodes: ([
        createTransformNode({
          id: "N1",
          inputSchema: z.object({ v: z.number() }),
          outputSchema: z.object({ v: z.number() }),
          transform: (i: { v: number }) => { log.push("N1"); return ok({ v: i.v + 1 }); },
        }),
        createTransformNode({
          id: "N2",
          inputSchema: z.object({ v: z.number() }),
          outputSchema: z.object({ v: z.number() }),
          transform: (i: { v: number }) => { log.push("N2"); return ok({ v: i.v * 10 }); },
        }),
        createTransformNode({
          id: "N3",
          inputSchema: z.object({ v: z.number() }),
          outputSchema: z.object({ v: z.number() }),
          transform: (i: { v: number }) => { log.push("N3"); return ok({ v: i.v + 100 }); },
        }),
      ]),
      edges: [
        { from: "N1", to: "N2" },
        { from: "N2", to: "N3" },
      ],
    });

    // --- First run: N1 + N2 succeed, N3 fails ---
    const failDag = defineDagFromArray({
      ...dag,
      nodes: ([
        dag.nodes[0],
        dag.nodes[1],
        createTransformNode({
          id: "N3",
          inputSchema: z.object({ v: z.number() }),
          outputSchema: z.object({ v: z.number() }),
          transform: (_i: { v: number }) => {
            log.push("N3-fail");
            return err({ kind: "node-crash" as const, nodeId: nodeId("N3"), retriability: "retriable" as const, message: "transient failure" });
          },
        }),
      ]),
    });

    const checkpoints: Map<string, unknown> = new Map();
    const checkpointWriter: CheckpointWriter = {
      write: async (_runId, nid, output) => {
        checkpoints.set(nid, output);
      },
    };

    const ctx1: NodeContext = makeNodeContext({
      runId: runId("run-1"),
      dagId: "resume-3node",
      checkpointWriter,
    });

    const r1 = await runDag(failDag, { v: 1 }, ctx1);
    expect(r1.ok).toBe(false); // N3 failed

    // N1 and N2 checkpointed
    expect(checkpoints.has("N1")).toBe(true);
    expect(checkpoints.has("N2")).toBe(true);
    expect(checkpoints.has("N3")).toBe(false);

    // --- Resume run ---
    log.length = 0;

    const ctx2: NodeContext = makeNodeContext({
      runId: runId("run-1"),
      dagId: "resume-3node",
      observer,
      checkpointWriter,
    });

    const r2 = await runDag(dag, undefined, ctx2, {
      resume: { runId: runId("run-1"), checkpoint: checkpoints },
    });

    expect(r2.ok).toBe(true);
    if (r2.ok) {
      // N1: 1+1=2, N2: 2*10=20, N3: 20+100=120
      expect(r2.value).toEqual({ v: 120 });
    }

    // Only N3 executed
    expect(log).toEqual(["N3"]);

    // N1 and N2 emitted NodeSkipped
    const skipped = events.filter((e) => e.type === "node-skipped");
    expect(skipped.map((e) => e.nodeId).sort()).toEqual([nodeId("N1"), nodeId("N2")]);

    // N3 emitted node-start and node-end
    const starts = events.filter((e) => e.type === "node-start");
    expect(starts.length).toBe(1);
    expect(starts[0].nodeId).toBe(nodeId("N3"));
  });
});
