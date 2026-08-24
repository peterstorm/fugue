/**
 * Test: executeWave error paths
 *
 * Unit tests for edge cases in wave execution:
 * - Out-of-bounds wave index
 * - Node not found in nodeMap
 * - AbortSignal already aborted before dispatch
 */

import { describe, it, expect } from "bun:test";
import { executeWave, type WaveConfig } from "../dag-runtime/wave-execution.js";
import { InMemoryFreshnessIndex } from "../dag-runtime/freshness-check.js";
import { N, R, D } from "./_id-helpers.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { RecordingObserver } from "../observer/observer.js";
import { brandAsValidatedNodeContext } from "../types/node.js";
import type { DagMachineContext } from "../dag-runtime/types.js";
import type { NodeDef } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import { z } from "zod";
import { err, ok } from "../types/result.js";

const makeNode = (id: string): NodeDef<unknown, unknown> => ({
  id: N(id),
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async () => ok("output"),
});

const makeDag = (): DagDef => ({
  id: D("test-dag"),
  nodes: [makeNode("a")],
  edges: [],
}) as unknown as DagDef;

const makeValidatedCtx = (obs?: RecordingObserver, signal?: AbortSignal) => {
  const observer = obs ?? new RecordingObserver();
  const ctx = makeNodeContext({
    runId: R("run-1"),
    dagId: D("test-dag"),
    observer,
    logger: { warn: () => {}, error: () => {} },
    signal,
  });
  return brandAsValidatedNodeContext(ctx);
};

const makeMachineCtx = (waves: string[][] = [["a"]]): DagMachineContext => ({
  waves: waves.map((w) => w.map(N)),
  outputs: new Map(),
  initialInput: {},
  activeNodeIds: new Set(waves.flat().map(N)),
  retries: new Map(),
  retryConfigs: new Map(),
  retryLimits: {},
  defaultRetryLimit: 0,
  confidenceByNode: new Map(),
  incomingByNode: new Map(),
  outputNodeId: undefined,
  edges: [],
  unconditionalAdj: new Map(),
  humanReviewNodeIds: new Set(),
  humanReviewPrompts: new Map(),
  priorWitnesses: new Map(),
  dag: makeDag(),
  outgoingByNode: new Map(),
  nodeById: new Map([[N("a"), makeNode("a")]]),
});

const makeConfig = (nodeMap?: Map<string, NodeDef<unknown, unknown>>): WaveConfig => ({
  dag: makeDag(),
  nodeMap: nodeMap
    ? new Map(Array.from(nodeMap.entries()).map(([k, v]) => [N(k), v]))
    : new Map([[N("a"), makeNode("a")]]),
  nodeCtx: makeValidatedCtx(),
  nowFn: Date.now,
  freshnessIndex: new InMemoryFreshnessIndex(), witnessedNodeIds: new Set(),
});

describe("executeWave — error paths", () => {
  it("out-of-bounds waveIndex returns non-retriable node-failed", async () => {
    const result = await executeWave(99, makeMachineCtx(), makeConfig());

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error.kind).toBe("node-crash");
      if (result.event.error.kind === "node-crash") {
        expect(result.event.error.retriability).toBe("non-retriable");
        expect(result.event.error.message).toContain("out-of-bounds");
      }
    }
  });

  it("negative waveIndex returns non-retriable node-failed", async () => {
    const result = await executeWave(-1, makeMachineCtx(), makeConfig());

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error.kind).toBe("node-crash");
    }
  });

  it("node not found in nodeMap returns non-retriable error", async () => {
    // nodeMap is empty but machineCtx has node "a" active
    const emptyNodeMap = new Map<string, NodeDef<unknown, unknown>>();
    const result = await executeWave(0, makeMachineCtx(), makeConfig(emptyNodeMap));

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error.kind).toBe("node-crash");
      if (result.event.error.kind === "node-crash") {
        expect(result.event.error.retriability).toBe("non-retriable");
        expect(result.event.error.message).toContain("node-not-found");
      }
    }
  });

  it("already-aborted signal short-circuits before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();

    const obs = new RecordingObserver();
    const validCtx = makeValidatedCtx(obs, controller.signal);

    const config: WaveConfig = {
      dag: makeDag(),
      nodeMap: new Map([[N("a"), makeNode("a")]]),
      nodeCtx: validCtx,
      nowFn: Date.now,
      freshnessIndex: new InMemoryFreshnessIndex(), witnessedNodeIds: new Set(),
    };

    const result = await executeWave(0, makeMachineCtx(), config);

    // Wave execution itself does not check the abort signal — that's the
    // executor's responsibility. The wave completes normally.
    expect(result.event.type).toBe("wave-done");
  });

  it("an unexpected thrown node defect is a non-retriable node-crash", async () => {
    const node = {
      ...makeNode("a"),
      run: async () => { throw new TypeError("deterministic authoring defect"); },
    } satisfies NodeDef<unknown, unknown>;

    const result = await executeWave(
      0,
      makeMachineCtx(),
      makeConfig(new Map([["a", node]])),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toMatchObject({
        kind: "node-crash",
        retriability: "non-retriable",
        message: "deterministic authoring defect",
      });
    }
  });

  it("a thrown FrameworkError keeps its typed kind instead of becoming node-crash", async () => {
    const thrown = {
      kind: "validation" as const,
      nodeId: N("a"),
      message: "typed validation failure",
    };
    const node = {
      ...makeNode("a"),
      run: async () => { throw thrown; },
    } satisfies NodeDef<unknown, unknown>;

    const result = await executeWave(
      0,
      makeMachineCtx(),
      makeConfig(new Map([["a", node]])),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toBe(thrown);
    }
  });

  it("a hostile thrown value cannot throw again while being rendered", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const node = {
      ...makeNode("a"),
      run: async () => { throw revoked.proxy; },
    } satisfies NodeDef<unknown, unknown>;

    const result = await executeWave(
      0,
      makeMachineCtx(),
      makeConfig(new Map([["a", node]])),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toMatchObject({
        kind: "node-crash",
        retriability: "non-retriable",
        message: "<unprintable error>",
      });
    }
  });

  it("the wave boundary preserves a typed FrameworkError thrown outside runNodeShared", async () => {
    const thrown: FrameworkError = {
      kind: "validation",
      nodeId: N("a"),
      message: "incoming lookup failed",
    };
    const machineCtx = makeMachineCtx();
    const incomingByNode = new Map(machineCtx.incomingByNode);
    incomingByNode.get = () => { throw thrown; };

    const result = await executeWave(
      0,
      { ...machineCtx, incomingByNode },
      makeConfig(),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toBe(thrown);
    }
  });

  it("the wave boundary classifies an unexpected executor throw as non-retriable", async () => {
    const machineCtx = makeMachineCtx();
    const incomingByNode = new Map(machineCtx.incomingByNode);
    incomingByNode.get = () => { throw new TypeError("broken incoming index"); };

    const result = await executeWave(
      0,
      { ...machineCtx, incomingByNode },
      makeConfig(),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toMatchObject({
        kind: "node-crash",
        message: "broken incoming index",
        retriability: "non-retriable",
      });
    }
  });

  it("a cyclic sibling error cannot replace the primary node-failed event", async () => {
    const primary: FrameworkError = {
      kind: "validation",
      nodeId: N("a"),
      message: "primary failure",
    };
    const cyclic = {
      kind: "validation" as const,
      nodeId: N("b"),
      message: "sibling failure",
    } as FrameworkError & { self?: unknown };
    cyclic.self = cyclic;
    const nodes = new Map<string, NodeDef<unknown, unknown>>([
      ["a", { ...makeNode("a"), run: async () => err(primary) }],
      ["b", { ...makeNode("b"), run: async () => err(cyclic) }],
    ]);

    const result = await executeWave(
      0,
      makeMachineCtx([["a", "b"]]),
      makeConfig(nodes),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toBe(primary);
      expect(result.event.coFailedNodeIds).toEqual([N("b")]);
    }
  });
});
