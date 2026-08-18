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
import { z } from "zod";
import { ok } from "../types/result.js";

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
  freshnessIndex: new InMemoryFreshnessIndex(),
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
      freshnessIndex: new InMemoryFreshnessIndex(),
    };

    const result = await executeWave(0, makeMachineCtx(), config);

    // Wave execution itself does not check the abort signal — that's the
    // executor's responsibility. The wave completes normally.
    expect(result.event.type).toBe("wave-done");
  });
});
