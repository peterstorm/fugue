import { witness, witnessValue, RN } from "./_freshness-helpers.js";
import { afterEach, describe, it, expect } from "bun:test";
import { emitFreshnessWitnessEvents } from "../dag-runtime/freshness-emission.js";
import { InMemoryFreshnessIndex, type FreshnessIndex } from "../dag-runtime/freshness-check.js";
import { RecordingObserver } from "../observer/observer.js";
import { nodeId, runId, dagId } from "../types/ids.js";
import type { NodeDef } from "../types/node.js";
import type { DagMachineContext } from "../dag-runtime/types.js";
import type { PostWaveContext } from "../dag-runtime/post-wave-context.js";
import type { WitnessCapturedEvent, WriteAttemptedEvent, FreshnessViolationEvent } from "../types/events.js";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";

afterEach(() => {
  __resetFrameworkLogger();
});

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
  tracer: { startActiveSpan: (_n: string, _o: unknown, fn: (span: unknown) => unknown) => fn({ setAttribute: () => {}, addEvent: () => {}, setStatus: () => {}, end: () => {} }) } as unknown as import("../types/tracer.js").Tracer,
  observer,
  cache: null,
  llm: null, http: null,
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
  unconditionalAdj: new Map(),
  nodeById: new Map(),
  retryConfigs: new Map(),
  outputNodeId: undefined,
  defaultRetryLimit: undefined,
  retryLimits: undefined,
  humanReviewNodeIds: new Set(),
  humanReviewPrompts: new Map(),
  edges: [],
  confidenceByNode: new Map(),
});

/** Build a PostWaveContext from test parameters. */
const makePostWaveCtx = (
  waveNodeIds: typeof NID_READ[],
  nodeMap: Map<typeof NID_READ, NodeDef<unknown, unknown>>,
  machineCtx: DagMachineContext,
  observer: RecordingObserver,
  freshnessIndex: FreshnessIndex,
  witnessAccumulator?: Map<string, any>,
): PostWaveContext => ({
  waveNodeIds,
  nodeMap,
  nodeCtx: makeCtx(observer) as any,
  machineCtx,
  dagId: DID,
  nowFn: Date.now,
  freshnessIndex,
  witnessAccumulator,
  priorOutputs: machineCtx.outputs,
});

describe("emitFreshnessWitnessEvents", () => {
  it("emits witness-captured for reads node with extractWitness", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: RN("pg:orders"), extractWitness: (output: unknown) => witnessValue("version", String((output as { version: number }).version)) },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, { version: 42 }]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_READ], nodeMap as any, makeMachineCtx(), obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    const captured = obs.events.filter((e) => e.type === "witness-captured") as WitnessCapturedEvent[];
    expect(captured).toHaveLength(1);
    expect(captured[0]!.witness.resource).toBe(RN("pg:orders"));
    expect(captured[0]!.witness.value).toBe("42");
  });

  it("emits write-attempted for writes node with both extractors", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: { kind: "writes", resource: RN("pg:orders"), extractConditionedOn: () => (witness("version", RN("pg:orders"), "42")), extractNewWitness: () => (witnessValue("version", "43")) },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    // Provide the read node's output so input can be assembled
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 42 }]]) };
    const newOutputs = new Map([[NID_WRITE, { ok: true }]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_WRITE], nodeMap as any, ctxWithOutput, obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    const writes = obs.events.filter((e) => e.type === "write-attempted") as WriteAttemptedEvent[];
    expect(writes).toHaveLength(1);
    expect(writes[0]!.conditionedOn.value).toBe("42");
    expect(writes[0]!.newWitness.value).toBe("43");
  });

  it("emits freshness-violation when conflict detected", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: { kind: "writes", resource: RN("pg:orders"), extractConditionedOn: () => (witness("version", RN("pg:orders"), "42")), extractNewWitness: () => (witnessValue("version", "44")) },
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
      conditionedOn: witness("version", RN("pg:orders"), "41"),
      newWitness: witness("version", RN("pg:orders"), "43"),
      succeededAtMs: Date.now() - 1000,
      timestamp: new Date(),
    });

    const ctx = makePostWaveCtx([NID_WRITE], nodeMap as any, ctxWithOutput, obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    const violations = obs.events.filter((e) => e.type === "freshness-violation") as FreshnessViolationEvent[];
    expect(violations).toHaveLength(1);
    expect(violations[0]!.conditionedOnWitness.value).toBe("42");
    expect(violations[0]!.conflictingWrite.newWitness.value).toBe("43");
  });

  it("does not emit events for nodes without extractors", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: RN("pg:orders") },
      // No extractWitness
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_READ], nodeMap as any, makeMachineCtx(), obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    expect(obs.events.filter((e) => e.type === "witness-captured")).toHaveLength(0);
  });

  it("skips freshness events for skipped nodes", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: RN("pg:orders"), extractWitness: () => (witnessValue("version", "1")) },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();
    const skipped = new Set([NID_READ]);

    const ctx = makePostWaveCtx([NID_READ], nodeMap as any, makeMachineCtx(), obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, skipped);

    expect(obs.events).toHaveLength(0);
  });

  it("returns Err when extractor throws (fail-closed)", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: RN("pg:orders"), extractWitness: () => { throw new Error("broken"); } },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_READ], nodeMap as any, makeMachineCtx(), obs, index);
    const result = await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    // Fail-closed: extractor failure aborts the wave
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
    expect(obs.events.filter((e) => e.type === "witness-captured")).toHaveLength(0);
    expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
  });

  it("preserves the fail-closed extractor result when error coercion and logging are hostile", async () => {
    const obs = new RecordingObserver();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const readNode = makeNodeDef("read-node", {
      sideEffects: {
        kind: "reads",
        resource: RN("pg:orders"),
        extractWitness: () => { throw revoked.proxy; },
      },
    });
    setFrameworkLogger({
      debug() {},
      info() {},
      warn() { throw new Error("logger transport failed"); },
      error() {},
    });
    const ctx = makePostWaveCtx(
      [NID_READ],
      new Map([[NID_READ, readNode]]) as any,
      makeMachineCtx(),
      obs,
      new InMemoryFreshnessIndex(),
    );

    const result = await emitFreshnessWitnessEvents(
      ctx,
      new Map([[NID_READ, {}]]),
      new Set(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: "node-crash",
        message: expect.stringContaining("<unprintable error>"),
      });
    }
    expect(obs.events.some((event) => event.type === "node-error")).toBe(true);
  });

  it("no events for pure transform (kind: none)", async () => {
    const obs = new RecordingObserver();
    const pureNode = makeNodeDef("pure-node", {
      sideEffects: { kind: "none" },
    });
    const nodeMap = new Map([[NID_PURE, pureNode]]);
    const newOutputs = new Map([[NID_PURE, {}]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_PURE], nodeMap as any, makeMachineCtx(), obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    expect(obs.events).toHaveLength(0);
  });

  it("populates witness accumulator map by resource", async () => {
    const obs = new RecordingObserver();
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: RN("pg:orders"), extractWitness: () => (witnessValue("version", "99")) },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();
    const accumulator = new Map<string, any>();

    const ctx = makePostWaveCtx([NID_READ], nodeMap as any, makeMachineCtx(), obs, index, accumulator);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    expect(accumulator.has("pg:orders")).toBe(true);
    expect(accumulator.get("pg:orders")!.value).toBe("99");
  });

  it("returns Err when freshnessIndex.recordWrite fails", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: {
        kind: "writes",
        resource: RN("pg:orders"),
        extractConditionedOn: () => (witness("version", RN("pg:orders"), "1")),
        extractNewWitness: () => (witnessValue("version", "2")),
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

    const ctx = makePostWaveCtx([NID_WRITE], nodeMap as any, ctxWithOutput, obs, failingIndex);
    const result = await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
    expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
  });

  it("returns Err when writes extractor throws (fail-closed)", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: {
        kind: "writes",
        resource: RN("pg:orders"),
        extractConditionedOn: () => { throw new Error("broken extractor"); },
        extractNewWitness: () => (witnessValue("version", "2")),
      },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    // Provide read node output so buildNodeInput succeeds (Step 1)
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 1 }]]) };
    const newOutputs = new Map([[NID_WRITE, {}]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_WRITE], nodeMap as any, ctxWithOutput, obs, index);
    const result = await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    // Fail-closed: extractor failure aborts the wave
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
    expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
  });

  it("returns Err and synthesizes no freshness-violation when findConflict fails (fail-closed)", async () => {
    const obs = new RecordingObserver();
    const writeNode = makeNodeDef("write-node", {
      sideEffects: {
        kind: "writes",
        resource: RN("pg:orders"),
        extractConditionedOn: () => (witness("version", RN("pg:orders"), "1")),
        extractNewWitness: () => (witnessValue("version", "2")),
      },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 1 }]]) };
    const newOutputs = new Map([[NID_WRITE, {}]]);

    // findConflict fails (e.g. a Redis outage). Fail-closed: the wave must
    // abort rather than synthesize a fake conflict with succeededAtMs: 0.
    const failingIndex: FreshnessIndex = {
      recordWrite: async () => ok(undefined),
      findConflict: async () => err({ kind: "cache-error", operation: "findConflict", message: "Redis down" }),
    };

    const ctx = makePostWaveCtx([NID_WRITE], nodeMap as any, ctxWithOutput, obs, failingIndex);
    const result = await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
    }
    expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
    // A failed conflict check must NOT be reported as a freshness-violation.
    expect(obs.events.some((e) => e.type === "freshness-violation")).toBe(false);
  });

  it("stamps the profile resource onto a resource-free read witness (stamping is not a no-op)", async () => {
    const obs = new RecordingObserver();
    // The extractor returns ONLY (kind, value) — it has no way to name a
    // resource. The emitted witness's resource can therefore *only* come from
    // the framework stamping se.resource. If stampWitness were a no-op the
    // resource would be absent and this assertion would fail.
    const readNode = makeNodeDef("read-node", {
      sideEffects: { kind: "reads", resource: RN("crm:customers"), extractWitness: () => witnessValue("etag", "abc123") },
    });
    const nodeMap = new Map([[NID_READ, readNode]]);
    const newOutputs = new Map([[NID_READ, {}]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_READ], nodeMap as any, makeMachineCtx(), obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    const captured = obs.events.filter((e) => e.type === "witness-captured") as WitnessCapturedEvent[];
    expect(captured).toHaveLength(1);
    // Resource came from the profile, not the extractor.
    expect(captured[0]!.witness.resource).toBe(RN("crm:customers"));
    expect(captured[0]!.witness.kind).toBe("etag");
    expect(captured[0]!.witness.value).toBe("abc123");
  });

  it("stamps newWitness with the node's own resource while conditionedOn keeps its upstream resource", async () => {
    const obs = new RecordingObserver();
    // The write's OWN resource is "pg:orders". It is conditioned on a DIFFERENT
    // resource ("pg:accounts") it read upstream: conditionedOn must pass that
    // through verbatim (its resource is a free variable), while the resource-free
    // newWitness is stamped with this node's own resource.
    const writeNode = makeNodeDef("write-node", {
      sideEffects: {
        kind: "writes",
        resource: RN("pg:orders"),
        extractConditionedOn: () => witness("version", RN("pg:accounts"), "7"),
        extractNewWitness: () => witnessValue("version", "8"),
      },
    });
    const nodeMap = new Map([[NID_WRITE, writeNode]]);
    const machineCtx = makeMachineCtx();
    const ctxWithOutput = { ...machineCtx, outputs: new Map([[NID_READ, { version: 7 }]]) };
    const newOutputs = new Map([[NID_WRITE, { ok: true }]]);
    const index = new InMemoryFreshnessIndex();

    const ctx = makePostWaveCtx([NID_WRITE], nodeMap as any, ctxWithOutput, obs, index);
    await emitFreshnessWitnessEvents(ctx, newOutputs, new Set());

    const writes = obs.events.filter((e) => e.type === "write-attempted") as WriteAttemptedEvent[];
    expect(writes).toHaveLength(1);
    // conditionedOn passes through verbatim — its resource is a free variable.
    expect(writes[0]!.conditionedOn.resource).toBe(RN("pg:accounts"));
    expect(writes[0]!.conditionedOn.value).toBe("7");
    // newWitness is stamped with this node's OWN resource, not the conditioned-on one.
    expect(writes[0]!.newWitness.resource).toBe(RN("pg:orders"));
    expect(writes[0]!.newWitness.value).toBe("8");
  });
});
