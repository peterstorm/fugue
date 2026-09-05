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
import { FE } from "./_freshness-helpers.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { RecordingObserver } from "../observer/observer.js";
import { brandAsValidatedNodeContext } from "../types/node.js";
import type { DagMachineContext } from "../dag-runtime/types.js";
import type { NodeDef } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import { z } from "zod";
import { err, ok } from "../types/result.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import { testRuntimeContext } from "./_context-factories.js";

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

// Only the four fields this suite actually varies are named; the rest come from
// `testRuntimeContext`, which is the one place a new DagMachineContext field has
// to be remembered. Hand-assembling all ~19 here is how a field added upstream
// silently keeps an old default in this file alone.
const makeMachineCtx = (waves: string[][] = [["a"]]): DagMachineContext =>
  testRuntimeContext({
    dag: makeDag(),
    waves: waves.map((w) => w.map(N)),
    activeNodeIds: new Set(waves.flat().map(N)),
    nodeById: new Map([[N("a"), makeNode("a")]]),
    freshnessExecutionEpoch: FE(),
  });

const makeConfig = (
  nodeMap?: Map<string, NodeDef<unknown, unknown>>,
  nowFn: () => number = Date.now,
): WaveConfig => ({
  dag: makeDag(),
  nodeMap: nodeMap
    ? new Map(Array.from(nodeMap.entries()).map(([k, v]) => [N(k), v]))
    : new Map([[N("a"), makeNode("a")]]),
  nodeCtx: makeValidatedCtx(),
  nowFn,
  freshnessIndex: new InMemoryFreshnessIndex(),
});

/** A clock that always throws — the hostile-clock property this suite pins. */
const throwingClock = (): number => {
  throw new Error("clock failed");
};

/**
 * A clock that fails its FIRST reading and works thereafter. Isolates one
 * emission's clock failure so the rest of the wave runs normally, which is what
 * makes "a broken diagnostic cost a sibling its output" observable.
 */
/**
 * A clock that serves the first `healthy` readings and throws thereafter, and
 * reports how many readings it served. Used to target ONE emission site: the
 * count is calibrated by a first healthy run rather than hard-coded, so an
 * unrelated change to how often the runtime reads the clock re-targets the test
 * instead of silently pointing it somewhere else.
 */
const countingClock = (healthy: number): { clock: () => number; reads: () => number } => {
  let reads = 0;
  return {
    clock: () => {
      reads += 1;
      if (reads > healthy) throw new Error("clock failed");
      return Date.now();
    },
    reads: () => reads,
  };
};

const throwOnceClock = (): (() => number) => {
  let thrown = false;
  return () => {
    if (!thrown) {
      thrown = true;
      throw new Error("clock failed");
    }
    return Date.now();
  };
};

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

  it("a throwing logger cannot replace the out-of-bounds invariant failure", async () => {
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => { throw new Error("logger failed"); },
    });
    try {
      const result = await executeWave(99, makeMachineCtx(), makeConfig());
      expect(result.event.type).toBe("node-failed");
      if (result.event.type === "node-failed" && result.event.error.kind === "node-crash") {
        expect(result.event.error.message).toContain("out-of-bounds");
        expect(result.event.error.retriability).toBe("non-retriable");
      }
    } finally {
      __resetFrameworkLogger();
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

  // ── Hostile clock (round-13 C1) ────────────────────────────────────────────
  // `executeWave` builds every event with `timestamp: stamp()`, and `stamp()`
  // runs `nowFn()` as an ARGUMENT — evaluated before `emit` is entered, so a
  // throwing clock is NOT contained by anything inside `emit`. Unfenced, the
  // throw in the per-node catch handler escapes the `.map()` callback and
  // rejects the `Promise.all`, so `executeWave` REJECTS instead of returning a
  // `WaveResult` — and every already-completed sibling in the wave loses its
  // output, so a retry re-runs its side effects.

  it("a hostile clock cannot turn a wave into a rejection", async () => {
    // The reproduction: input validation fails pre-span (the one clock site
    // `withTracedNodeSpan`'s try/catch cannot cover), so the failure lands in
    // `executeWave`'s catch handler — whose own `stamp()` then throws again.
    const nodes = new Map<string, NodeDef<unknown, unknown>>([
      ["a", { ...makeNode("a"), inputSchema: z.string() }],
    ]);

    const result = await executeWave(
      0,
      makeMachineCtx(),
      makeConfig(nodes, throwingClock),
    );

    // The contract is a resolved WaveResult, never a rejected promise.
    expect(result.event.type).toBe("node-failed");
    expect(result.outcomes).toBeDefined();
  });

  it("a failed emission does not cost a completed sibling its carried output", async () => {
    // Throws only on the emission that fires first (`a`'s pre-span
    // `node-error`), so `b` runs on a working clock and completes.
    const nodes = new Map<string, NodeDef<unknown, unknown>>([
      ["a", { ...makeNode("a"), inputSchema: z.string() }],
      ["b", { ...makeNode("b"), run: async () => ok("b-out") }],
    ]);

    const result = await executeWave(
      0,
      makeMachineCtx([["a", "b"]]),
      makeConfig(nodes, throwOnceClock()),
    );

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      // `b` completed; its output must be carried so the retry does not re-run it.
      expect(result.event.partialOutputs?.get(N("b"))).toBe("b-out");
    }
  });

  it("a failed node-skipped emission still completes the wave", async () => {
    // `priorOutputs.has(nodeId)` — the carried-output path. Its emission is a
    // diagnostic; unfenced it turned a wave-done into a node-failed.
    const machineCtx = {
      ...makeMachineCtx([["a", "b"]]),
      outputs: new Map([[N("a"), "carried"]]),
    };
    const nodes = new Map<string, NodeDef<unknown, unknown>>([
      ["a", makeNode("a")],
      ["b", { ...makeNode("b"), run: async () => ok("b-out") }],
    ]);

    const result = await executeWave(0, machineCtx, makeConfig(nodes, throwOnceClock()));

    expect(result.event.type).toBe("wave-done");
    if (result.event.type === "wave-done") {
      expect(result.event.outputs.get(N("a"))).toBe("carried");
      expect(result.event.outputs.get(N("b"))).toBe("b-out");
    }
  });

  it("a failed co-failure emission still returns the primary node-failed", async () => {
    // Round-13 C1 fenced THREE emit sites; the tests above drive a hostile clock
    // through only two. This is the third: the co-failed-siblings loop, which
    // runs AFTER `Promise.all` has resolved — so a throw there escapes the async
    // function body directly, rejecting `executeWave` and discarding both the
    // primary `node-failed` event and the `partialOutputs` that keep a retry
    // from re-running the wave's completed nodes.
    const primary: FrameworkError = {
      kind: "validation",
      nodeId: N("a"),
      message: "primary failure",
    };
    const sibling: FrameworkError = {
      kind: "validation",
      nodeId: N("b"),
      message: "sibling failure",
    };
    const nodes = (): Map<string, NodeDef<unknown, unknown>> =>
      new Map<string, NodeDef<unknown, unknown>>([
        ["a", { ...makeNode("a"), run: async () => err(primary) }],
        ["b", { ...makeNode("b"), run: async () => err(sibling) }],
        ["c", { ...makeNode("c"), run: async () => ok("c-out") }],
      ]);
    const wave = [["a", "b", "c"]];

    // Calibrate: a healthy run tells us how many readings this wave takes. Two
    // failures mean the siblings loop runs, and a failure path returns straight
    // after it — so the LAST reading is that loop's emission.
    const healthy = countingClock(Number.MAX_SAFE_INTEGER);
    await executeWave(0, makeMachineCtx(wave), makeConfig(nodes(), healthy.clock));
    const total = healthy.reads();
    expect(total).toBeGreaterThan(1);

    // Re-run serving every reading but that last one.
    const hostile = countingClock(total - 1);
    const result = await executeWave(0, makeMachineCtx(wave), makeConfig(nodes(), hostile.clock));

    expect(result.event.type).toBe("node-failed");
    if (result.event.type === "node-failed") {
      expect(result.event.error).toBe(primary);
      // `c` ran fine and `b` is still reported as the co-failure — proof the
      // clock failed on the emission, not on any node's own execution.
      expect(result.event.coFailedNodeIds).toEqual([N("b")]);
      expect(result.event.partialOutputs?.get(N("c"))).toBe("c-out");
    }
  });
});
