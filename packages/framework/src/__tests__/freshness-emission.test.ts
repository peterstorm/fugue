import { describe, it, expect } from "bun:test";
import { emitFreshnessWitnessEvents } from "../dag-runtime/freshness-emission.js";
import { InMemoryFreshnessIndex, type FreshnessIndex } from "../dag-runtime/freshness-check.js";
import { RecordingObserver } from "../observer/observer.js";
import { nodeId, runId, dagId } from "../types/ids.js";
import type { NodeDef } from "../types/node.js";
import type { DagMachineContext } from "../dag-runtime/types.js";
import type { WitnessCapturedEvent, WriteAttemptedEvent, FreshnessViolationEvent } from "../types/events.js";
import { z } from "zod";
import { ok, err } from "../types/result.js";

const NID_READ = nodeId("read-node");
const NID_WRITE = nodeId("write-node");
const NID_PURE = nodeId("pure-node");
const RID = runId("run-1");
const DID = dagId("dag-1");

const makeNodeDef = (id: string, overrides?: Partial<NodeDef<unknown, unknown>>): NodeDef<unknown, unknown> => ({
  id: nodeId(id),
  kind: "fetch",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [] as const,
  run: async () => ok(null),
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

const makeCtx = (observer: RecordingObserver) => ({
  runId: RID,
  dagId: DID,
  logger: { warn: () => {}, error: () => {} },
  tracer: { startActiveSpan: (_n: string, _o: any, fn: any) => fn({ setAttribute: () => {}, addEvent: () => {}, setStatus: () => {}, end: () => {} }) } as any,
  observer,
  cache: null,
  llm: null,
  prompts: null,
  judgeLlm: null,
});

const makeMachineCtx = (): DagMachineContext => ({
  dag: { id: DID, nodes: [], edges: [] } as any,
  waves: [[NID_READ, NID_WRITE, NID_PURE]],
  outputs: new Map(),
  retries: new Map(),
  initialInput: {},
  activeNodeIds: new Set([NID_READ, NID_WRITE, NID_PURE]),
  incomingByNode: new Map([
    [NID_READ, { required: [], optional: [] }],
    [NID_WRITE, { required: [NID_READ], optional: [] }],
    [NID_PURE, { required: [], optional: [] }],
  ]),
  outgoingByNode: new Map(),
  nodeById: new Map(),
  retryConfigs: new Map(),
  outputNodeId: undefined,
  defaultRetryLimit: undefined,
  retryLimits: undefined,
  humanReviewNodeIds: new Set(),
  humanReviewPrompts: new Map(),
  edges: [],
});

describe("emitFreshnessWitnessEvents", () => {
  it("emits witness-captured for reads node with extractWitness", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: "pg:orders", extractWitness: (output: any) => ({ kind: "version", resource: "pg:orders", value: String(output.version) }) },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, { version: 42 }]]);
    const index = new InMemoryFreshnessIndex();

    await emitFreshnessWitnessEvents(
      [NID_READ], newOutputs, nodeMap as any, makeMachineCtx(),
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    const captured = obs.events.filter((e) => e.type === "witness-captured") as WitnessCapturedEvent[];
    expect(captured).toHaveLength(1);
    expect(captured[0]!.witness.resource).toBe("pg:orders");
    expect(captured[0]!.witness.value).toBe("42");
  });

  it("emits write-attempted for writes node with both extractors", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: { kind: "writes", resource: "pg:orders", extractConditionedOn: () => ({ kind: "version", resource: "pg:orders", value: "42" }), extractNewWitness: () => ({ kind: "version", resource: "pg:orders", value: "43" }) },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    // Provide the read node's output so input can be assembled
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 42 }]]) };
    const newOutputs = new Map([[NID_WRITE, { ok: true }]]);
    const index = new InMemoryFreshnessIndex();

    await emitFreshnessWitnessEvents(
      [NID_WRITE], newOutputs, nodeMap as any, ctxWithOutput,
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    const writes = obs.events.filter((e) => e.type === "write-attempted") as WriteAttemptedEvent[];
    expect(writes).toHaveLength(1);
    expect(writes[0]!.conditionedOn.value).toBe("42");
    expect(writes[0]!.newWitness.value).toBe("43");
  });

  it("emits freshness-violation when conflict detected", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: { kind: "writes", resource: "pg:orders", extractConditionedOn: () => ({ kind: "version", resource: "pg:orders", value: "42" }), extractNewWitness: () => ({ kind: "version", resource: "pg:orders", value: "44" }) },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, {}]]) };
    const newOutputs = new Map([[NID_WRITE, {}]]);
    const index = new InMemoryFreshnessIndex();

    // Pre-record a conflicting write (version moved to 43, but our write is conditioned on 42)
    await index.recordWrite({
      type: "write-attempted",
      runId: runId("other-run"),
      dagId: DID,
      nodeId: nodeId("other-writer"),
      conditionedOn: { kind: "version", resource: "pg:orders", value: "41" },
      newWitness: { kind: "version", resource: "pg:orders", value: "43" },
      succeededAtMs: Date.now() - 1000,
      timestamp: new Date(),
    });

    await emitFreshnessWitnessEvents(
      [NID_WRITE], newOutputs, nodeMap as any, ctxWithOutput,
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    const violations = obs.events.filter((e) => e.type === "freshness-violation") as FreshnessViolationEvent[];
    expect(violations).toHaveLength(1);
    expect(violations[0]!.conditionedOnWitness.value).toBe("42");
    expect(violations[0]!.conflictingWrite.newWitness.value).toBe("43");
  });

  it("does not emit events for nodes without extractors", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: "pg:orders" },
      // No extractWitness
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();

    await emitFreshnessWitnessEvents(
      [NID_READ], newOutputs, nodeMap as any, makeMachineCtx(),
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    expect(obs.events.filter((e) => e.type === "witness-captured")).toHaveLength(0);
  });

  it("skips freshness events for skipped nodes", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: "pg:orders", extractWitness: () => ({ kind: "version", resource: "pg:orders", value: "1" }) },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();
    const skipped = new Set([NID_READ]);

    await emitFreshnessWitnessEvents(
      [NID_READ], newOutputs, nodeMap as any, makeMachineCtx(),
      makeCtx(obs) as any, DID, Date.now, index, skipped,
    );

    expect(obs.events).toHaveLength(0);
  });

  it("does not crash when extractor throws", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: "pg:orders", extractWitness: () => { throw new Error("broken"); } },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();

    // Should not throw — failure is logged and skipped
    await emitFreshnessWitnessEvents(
      [NID_READ], newOutputs, nodeMap as any, makeMachineCtx(),
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    expect(obs.events.filter((e) => e.type === "witness-captured")).toHaveLength(0);
  });

  it("no events for pure transform (kind: none)", async () => {
    const obs = new RecordingObserver();
    const pureNode = makeNodeDef("pure-node", {
      sideEffects: { kind: "none" },
    });
    const nodeMap = new Map([[NID_PURE, pureNode]]);
    const newOutputs = new Map([[NID_PURE, {}]]);
    const index = new InMemoryFreshnessIndex();

    await emitFreshnessWitnessEvents(
      [NID_PURE], newOutputs, nodeMap as any, makeMachineCtx(),
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    expect(obs.events).toHaveLength(0);
  });

  it("populates witness accumulator map by resource", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: "pg:orders", extractWitness: () => ({ kind: "version", resource: "pg:orders", value: "99" }) },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();
    const accumulator = new Map<string, any>();

    await emitFreshnessWitnessEvents(
      [NID_READ], newOutputs, nodeMap as any, makeMachineCtx(),
      makeCtx(obs) as any, DID, Date.now, index, new Set(), accumulator,
    );

    expect(accumulator.has("pg:orders")).toBe(true);
    expect(accumulator.get("pg:orders")!.value).toBe("99");
  });

  it("returns Err when freshnessIndex.recordWrite fails", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: {
        kind: "writes",
        resource: "pg:orders",
        extractConditionedOn: () => ({ kind: "version", resource: "pg:orders", value: "1" }),
        extractNewWitness: () => ({ kind: "version", resource: "pg:orders", value: "2" }),
      },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    // Provide read node output so buildNodeInput succeeds (Step 1)
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 1 }]]) };
    const newOutputs = new Map([[NID_WRITE, {}]]);

    // Failing freshness index — recordWrite returns Err
    const failingIndex: FreshnessIndex = {
      recordWrite: async () => err({ kind: "cache-error", operation: "recordWrite", message: "Redis down" }),
      findConflict: async () => ok(null),
    };

    const result = await emitFreshnessWitnessEvents(
      [NID_WRITE], newOutputs, nodeMap as any, ctxWithOutput,
      makeCtx(obs) as any, DID, Date.now, failingIndex, new Set(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
    expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
  });

  it("returns Ok when extractor throws (non-fatal authoring bug)", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: {
        kind: "writes",
        resource: "pg:orders",
        extractConditionedOn: () => { throw new Error("broken extractor"); },
        extractNewWitness: () => ({ kind: "version", resource: "pg:orders", value: "2" }),
      },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    // Provide read node output so buildNodeInput succeeds (Step 1)
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 1 }]]) };
    const newOutputs = new Map([[NID_WRITE, {}]]);
    const index = new InMemoryFreshnessIndex();

    const result = await emitFreshnessWitnessEvents(
      [NID_WRITE], newOutputs, nodeMap as any, ctxWithOutput,
      makeCtx(obs) as any, DID, Date.now, index, new Set(),
    );

    // Extractor failure is non-fatal — emits node-error but returns Ok
    expect(result.ok).toBe(true);
    expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
  });
});
