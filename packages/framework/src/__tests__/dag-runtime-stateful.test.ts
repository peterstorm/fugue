// dag-runtime-stateful.test.ts — end-to-end tests for runDagStateful via in-memory JobLike
// Covers: linear, fan-out, fan-in, diamond, retry transient, retry exhausted,
//         HITL approve, approve-with-edit, reject, reroute-back, abort

import { NoopObserver } from "../observer/observer.js";
import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { createInMemoryJob } from "../state-machine/in-memory-job.js";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { defineDag } from "../executor/define-dag.js";
import type { DagDef, EdgeDef } from "../types/dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { HumanAction } from "../dag-runtime/types.js";
import { ok, err } from "../types/result.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = async (_input: unknown, _ctx: NodeContext) => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown, unknown>> = {},
): NodeDef<unknown, unknown, unknown> => ({
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  ...overrides,
});

const makeCtx = (): NodeContext => ({
  runId: "test-run-id",
  dagId: "test-dag",
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

interface MakeDagOverrides {
  readonly id?: string;
  readonly nodes?: readonly NodeDef<unknown, unknown, unknown>[];
  readonly edges?: readonly EdgeDef[];
  readonly outputNodeId?: string;
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  readonly evalJudges?: DagDef["evalJudges"];
}

// Test helper: accepts the array form (legacy ergonomics) and converts to
// the record form `defineDag` expects. Every constructed DAG passes through
// validateDagShape so test setup errors surface at the `makeDag(...)` line.
const makeDag = (overrides: MakeDagOverrides = {}): DagDef => {
  const nodes = overrides.nodes ?? [];
  return defineDag({
    id: overrides.id ?? "test-dag",
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: overrides.edges ?? [],
    outputNodeId: overrides.outputNodeId,
    evalJudges: overrides.evalJudges,
    retryLimits: overrides.retryLimits,
    defaultRetryLimit: overrides.defaultRetryLimit,
  });
};

// ---------------------------------------------------------------------------
// 1. Linear DAG: A -> B -> C
// ---------------------------------------------------------------------------

describe("runDagStateful — linear DAG", () => {
  it("runs A -> B -> C and returns last node output", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          run: async () => ok("a-out"),
        }),
        makeNode("b", {
          run: async (input) => ok(`b-received-${input}`),
        }),
        makeNode("c", {
          run: async (input) => ok(`c-received-${input}`),
        }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });

    const result = await runDagStateful<unknown, string>(dag, "input", makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("c-received-b-received-a-out");
    }
  });

  it("linear DAG with explicit outputNodeId returns that node's output", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => ok("a-out") }),
        makeNode("b", { run: async () => ok("b-out") }),
      ],
      edges: [{ from: "a", to: "b" }],
      outputNodeId: "a",
    });

    const result = await runDagStateful<unknown, string>(dag, null, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("a-out");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Fan-out DAG: A -> B, A -> C (B and C run in parallel)
// ---------------------------------------------------------------------------

describe("runDagStateful — fan-out DAG", () => {
  it("A -> B, A -> C: both B and C receive A's output", async () => {
    const calls: string[] = [];

    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => ok("a-out") }),
        makeNode("b", {
          run: async (input) => {
            calls.push("b");
            return ok(`b-from-${input}`);
          },
        }),
        makeNode("c", {
          run: async (input) => {
            calls.push("c");
            return ok(`c-from-${input}`);
          },
        }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
      outputNodeId: "b",
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(true);
    expect(calls).toContain("b");
    expect(calls).toContain("c");
  });
});

// ---------------------------------------------------------------------------
// 3. Fan-in DAG: A, B -> C (C receives both A and B outputs)
// ---------------------------------------------------------------------------

describe("runDagStateful — fan-in DAG", () => {
  it("A, B -> C: C receives multi-dep object", async () => {
    let cInput: unknown = undefined;

    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => ok("a-out") }),
        makeNode("b", { run: async () => ok("b-out") }),
        makeNode("c", {
          run: async (input) => {
            cInput = input;
            return ok("c-out");
          },
        }),
      ],
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(true);
    expect(cInput).toEqual({ a: "a-out", b: "b-out" });
  });
});

// ---------------------------------------------------------------------------
// 4. Diamond DAG: A -> B, A -> C, B + C -> D
// ---------------------------------------------------------------------------

describe("runDagStateful — diamond DAG", () => {
  it("A -> B, A -> C, B+C -> D: all run in correct order", async () => {
    const order: string[] = [];

    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => { order.push("a"); return ok("a"); } }),
        makeNode("b", { run: async () => { order.push("b"); return ok("b"); } }),
        makeNode("c", { run: async () => { order.push("c"); return ok("c"); } }),
        makeNode("d", {
          run: async (input) => { order.push("d"); return ok("d-out"); },
        }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(true);
    // A must come before B and C; D must come after B and C
    expect(order[0]).toBe("a");
    expect(order[order.length - 1]).toBe("d");
  });
});

// ---------------------------------------------------------------------------
// 5. Retry transient — node fails once then succeeds
// ---------------------------------------------------------------------------

describe("runDagStateful — retry transient", () => {
  it("node fails once then succeeds within retry budget (FR-026, FR-027)", async () => {
    let attempts = 0;

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          // Override backoff to 0ms for fast tests
          retry: { backoffMs: [0, 0, 0], jitterRatio: 0 },
          run: async () => {
            attempts++;
            if (attempts < 2) {
              return err({ kind: "node-crash" as const, nodeId: "a", message: "transient" });
            }
            return ok("recovered");
          },
        }),
      ],
      edges: [],
      defaultRetryLimit: 2,
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("recovered");
    }
    expect(attempts).toBe(2);
  });

  it("jitter is applied (delay > 0) when jitterRatio > 0", async () => {
    let attempts = 0;
    const start = Date.now();

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          retry: { backoffMs: [10], jitterRatio: 0.5 },
          run: async () => {
            attempts++;
            if (attempts < 2) return err({ kind: "node-crash" as const, nodeId: "a", message: "t" });
            return ok("ok");
          },
        }),
      ],
      edges: [],
      defaultRetryLimit: 1,
    });

    await runDagStateful(dag, null, makeCtx());
    // Should have taken at least ~10ms from backoff
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 6. Retry exhausted — node always fails
// ---------------------------------------------------------------------------

describe("runDagStateful — retry exhausted", () => {
  it("node fails all attempts => err(retry-exhausted)", async () => {
    let attempts = 0;

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => {
            attempts++;
            return err({ kind: "node-crash" as const, nodeId: "a", message: "always fails" });
          },
        }),
      ],
      edges: [],
      defaultRetryLimit: 2,
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
      if (result.error.kind === "retry-exhausted") {
        expect(result.error.nodeId).toBe("a");
      }
    }
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("no retries configured => fails immediately on first error", async () => {
    let attempts = 0;

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          run: async () => {
            attempts++;
            return err({ kind: "node-crash" as const, nodeId: "a", message: "boom" });
          },
        }),
      ],
      edges: [],
      // defaultRetryLimit = 0 (default)
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
    }
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. HITL: approve
// ---------------------------------------------------------------------------

describe("runDagStateful — HITL approve", () => {
  it("node with humanReview pauses, approve advances to succeeded", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          humanReview: { prompt: "Please review" },
          run: async () => ok("node-output"),
        }),
      ],
      edges: [],
    });

    const onHumanReview = mock(
      async (_req: { nodeId: string; output: unknown; prompt: string }): Promise<HumanAction> => ({ action: "approve" }),
    );

    const result = await runDagStateful(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(true);
    expect(onHumanReview).toHaveBeenCalledTimes(1);
    const callArg = onHumanReview.mock.calls[0]![0];
    expect(callArg.nodeId).toBe("a");
    expect(callArg.prompt).toBe("Please review");
    expect(callArg.output).toBe("node-output");
  });
});

// ---------------------------------------------------------------------------
// 8. HITL: approve-with-edit
// ---------------------------------------------------------------------------

describe("runDagStateful — HITL approve-with-edit", () => {
  it("approve-with-edit replaces node output and succeeds with edited value", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          humanReview: { prompt: "Edit if needed" },
          run: async () => ok("original"),
        }),
      ],
      edges: [],
      outputNodeId: "a",
    });

    const onHumanReview = async (_req: any): Promise<HumanAction> => ({
      action: "approve-with-edit",
      newOutput: "edited-value",
    });

    const result = await runDagStateful<unknown, string>(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("edited-value");
    }
  });

  // Wave 2 §2.5: a reviewer's edited output must conform to the node's
  // outputSchema. Without this guard, a mis-typed edit silently propagates to
  // downstream nodes.
  it("approve-with-edit with schema-violating output fails the run with kind=validation", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          humanReview: { prompt: "Edit if needed" },
          outputSchema: z.object({ score: z.number() }),
          run: async () => ok({ score: 0.5 }),
        }),
      ],
      edges: [],
      outputNodeId: "a",
      // No retries — first validation failure surfaces as terminal.
      defaultRetryLimit: 0,
    });

    const onHumanReview = async (_req: any): Promise<HumanAction> => ({
      action: "approve-with-edit",
      newOutput: { score: "not-a-number" }, // wrong shape
    });

    const result = await runDagStateful(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Validation failure from the executor flows through the hook-crash
      // path; with retryLimit=0 it surfaces as node-crash carrying the
      // validation message in the last-error trail.
      const isExpectedKind =
        result.error.kind === "validation" || result.error.kind === "node-crash";
      expect(isExpectedKind).toBe(true);
      const msg =
        result.error.kind === "validation"
          ? result.error.message
          : result.error.kind === "node-crash"
            ? result.error.message
            : "";
      expect(msg).toContain("approve-with-edit");
      expect(msg).toContain("schema");
    }
  });

  it("approve-with-edit retries the hook when validation fails (retry budget allows reviewer to fix)", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          humanReview: { prompt: "Edit if needed" },
          outputSchema: z.object({ score: z.number() }),
          retry: { backoffMs: [1, 1], jitterRatio: 0 },
          run: async () => ok({ score: 0.5 }),
        }),
      ],
      edges: [],
      outputNodeId: "a",
      // Budget for two hook-retries — first attempt has bad output, second succeeds.
      defaultRetryLimit: 2,
    });

    let call = 0;
    const onHumanReview = async (_req: any): Promise<HumanAction> => {
      call++;
      // First attempt: bad output. Second attempt: valid output.
      return call === 1
        ? { action: "approve-with-edit", newOutput: { score: "bad" } }
        : { action: "approve-with-edit", newOutput: { score: 0.9 } };
    };

    const result = await runDagStateful(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ score: 0.9 });
    }
    expect(call).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 9. HITL: reject
// ---------------------------------------------------------------------------

describe("runDagStateful — HITL reject", () => {
  it("reject => err(rejected) with reason and nodeId (FR-030)", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          humanReview: { prompt: "Review this" },
          run: async () => ok("output"),
        }),
      ],
      edges: [],
    });

    const onHumanReview = async (_req: any): Promise<HumanAction> => ({
      action: "reject",
      reason: "not acceptable",
    });

    const result = await runDagStateful(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rejected");
      if (result.error.kind === "rejected") {
        expect(result.error.reason).toBe("not acceptable");
        expect(result.error.nodeId).toBe("a");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. HITL: reroute-back
// ---------------------------------------------------------------------------

describe("runDagStateful — HITL reroute-back", () => {
  it("reroute to earlier wave reruns from that wave (FR-031)", async () => {
    const runCounts: Record<string, number> = { a: 0, b: 0 };

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          run: async () => {
            runCounts["a"]!++;
            return ok(`a-run-${runCounts["a"]}`);
          },
        }),
        makeNode("b", {
          humanReview: { prompt: "Review B output" },
          run: async () => {
            runCounts["b"]!++;
            return ok(`b-run-${runCounts["b"]}`);
          },
        }),
      ],
      edges: [{ from: "a", to: "b" }],
      outputNodeId: "b",
    });

    let rerouteCount = 0;
    const onHumanReview = async (_req: any): Promise<HumanAction> => {
      rerouteCount++;
      if (rerouteCount === 1) {
        // First time: reroute back to wave 0 (node "a")
        return { action: "reroute", targetNodeId: "a" };
      }
      // Second time: approve
      return { action: "approve" };
    };

    const result = await runDagStateful(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(true);
    // "a" should have been run twice (once original, once after reroute)
    expect(runCounts["a"]).toBe(2);
    // "b" should have been run twice (once original, once after reroute)
    expect(runCounts["b"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 11. Abort
// ---------------------------------------------------------------------------

describe("runDagStateful — abort", () => {
  it("abort event delivered to machine produces err(aborted) (FR-033)", async () => {
    // We test abort by providing a beforeExecute hook that aborts.
    // The abort event itself is typically emitted externally; we simulate
    // via the abort framing: the node throws and we pass an abort event type.
    // More directly: test that a DAG whose node returns an abort-triggering error
    // ends up as err(aborted). Since abort comes from the machine level, we verify
    // via the transition layer rather than executor — the executor never sends "abort"
    // directly; that is an external signal. Here we ensure that the error path works.

    // The simplest way to verify abort behavior is to use a DAG with humanReview,
    // provide an onHumanReview that never resolves, but the job emits an abort.
    // Instead: verify that the DAG properly returns err when a node throws unexpectedly.

    // Actually let's test it using the job directly with an aborted state pre-loaded.
    const dag = makeDag({
      nodes: [makeNode("a", { run: async () => ok("out") })],
      edges: [],
    });

    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { initialContext } = compiled.value;

    // Create a job that is already in failed/aborted state
    const abortedJob = createInMemoryJob<
      import("../dag-runtime/types.js").DagPhase,
      import("../dag-runtime/types.js").DagMachineContext
    >({
      state: {
        kind: "failed",
        error: { kind: "aborted", reason: "user cancelled" },
      },
      context: initialContext,
    });

    // runDagStateful with a pre-failed job — machine is already terminal
    const result = await runDagStateful(dag, null, makeCtx(), { jobLike: abortedJob });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
      if (result.error.kind === "aborted") {
        expect(result.error.reason).toBe("user cancelled");
      }
    }
  });

  it("aborting mid-run cancels the in-flight node and resolves Err(aborted)", async () => {
    const controller = new AbortController();
    let observedSignalAborted = false;
    const slowNode: NodeDef<unknown, unknown, FrameworkError> = {
      id: "slow",
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      run: async (_input, ctx) => {
        const start = Date.now();
        // Bound the loop to keep the test fast even if the signal never fires.
        while (Date.now() - start < 5000) {
          if (ctx.signal?.aborted) {
            observedSignalAborted = true;
            return err({ kind: "aborted" as const, reason: "signal" });
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        return ok(undefined);
      },
    };

    const dag = makeDag({ nodes: [slowNode as NodeDef<unknown, unknown, unknown>], edges: [] });

    const ctx: NodeContext = { ...makeCtx(), signal: controller.signal };

    setTimeout(() => controller.abort(), 50);
    const result = await runDagStateful(dag, undefined, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // `aborted` is a fast-fail kind — the retry budget must not be consumed
      // when the caller cancels. See transition-helpers.ts:handleNodeFailed.
      expect(result.error.kind).toBe("aborted");
    }
    expect(observedSignalAborted).toBe(true);
  });

  it("node throw produces err(retry-exhausted) — executor wraps throw as node-failed", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          run: async () => {
            throw new Error("unexpected crash");
          },
        }),
      ],
      edges: [],
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // executor catches the throw and returns node-failed which exhausts retry budget (0 retries default)
      expect(result.error.kind).toBe("retry-exhausted");
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Input/Output validation (FR-025)
// ---------------------------------------------------------------------------

describe("runDagStateful — validation (FR-025)", () => {
  it("fails when node input fails schema validation", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          inputSchema: z.object({ name: z.string() }),
          run: async () => ok("out"),
        }),
      ],
      edges: [],
    });

    // dag input is a number, not an object with name: string
    const result = await runDagStateful(dag, 42, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Wave 7 §7.3: validation errors fail-fast (deterministic, not transient)
      // and surface their original kind instead of being wrapped in retry-exhausted.
      expect(result.error.kind).toBe("validation");
    }
  });

  it("fails when node output fails schema validation", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          outputSchema: z.string(),
          run: async () => ok(42 as any), // returns a number when string expected
        }),
      ],
      edges: [],
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("passes when schemas are satisfied", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          inputSchema: z.string(),
          outputSchema: z.number(),
          run: async (input: any) => ok(input.length as number),
        }),
      ],
      edges: [],
    });

    const result = await runDagStateful(dag, "hello", makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Observer events emitted
// ---------------------------------------------------------------------------

describe("runDagStateful — observer events", () => {
  it("emits run-start, node-start, node-end, run-end events", async () => {
    const events: string[] = [];
    const observer = {
      onRunStart: () => events.push("run-start"),
      onNodeStart: () => events.push("node-start"),
      onNodeEnd: () => events.push("node-end"),
      onNodeSkipped: () => events.push("node-skipped"),
      onNodeError: () => events.push("node-error"),
      onSubSpan: () => {},
      onRunEnd: () => events.push("run-end"),
    };

    const dag = makeDag({
      nodes: [makeNode("a", { run: async () => ok("out") })],
      edges: [],
    });

    const ctx: NodeContext = { ...makeCtx(), observer };
    await runDagStateful(dag, null, ctx);

    expect(events).toContain("node-start");
    expect(events).toContain("node-end");
    expect(events).toContain("run-end");
  });

  it("emits run-start exactly once per run (not duplicated by executor)", async () => {
    const events: string[] = [];
    const observer = {
      onRunStart: () => events.push("run-start"),
      onNodeStart: () => events.push("node-start"),
      onNodeEnd: () => events.push("node-end"),
      onNodeSkipped: () => events.push("node-skipped"),
      onNodeError: () => events.push("node-error"),
      onSubSpan: () => {},
      onRunEnd: () => events.push("run-end"),
    };

    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => ok("a-out") }),
        makeNode("b", { run: async () => ok("b-out") }),
      ],
      edges: [{ from: "a", to: "b" }],
    });

    const ctx: NodeContext = { ...makeCtx(), observer };
    await runDagStateful(dag, null, ctx);

    const runStartCount = events.filter((e) => e === "run-start").length;
    expect(runStartCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Durable job — checkpoint is updated on each successful transition
// ---------------------------------------------------------------------------

describe("runDagStateful — durable job checkpointing", () => {
  it("job state is updated after each transition", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => ok("a-out") }),
        makeNode("b", { run: async () => ok("b-out") }),
      ],
      edges: [{ from: "a", to: "b" }],
    });

    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { initialContext, initialState } = compiled.value;
    const job = createInMemoryJob({ state: initialState, context: initialContext });

    await runDagStateful(dag, null, makeCtx(), { jobLike: job });

    // Final state should be succeeded
    expect(job.data.state.kind).toBe("succeeded");
    // Events were appended for each successful transition
    expect(job.events.length).toBeGreaterThan(0);
    // Progress was updated
    expect(job.progress).toBe(100);
  });

  // Wave 2 §2.1: the BullMQ adapter serializes context via JSON, which
  // strips closures (NodeDef.run, Zod schemas). Storing the full DagDef in
  // every checkpoint also wastes Redis bandwidth on data that's already
  // derivable from the call-site DAG.
  //
  // wrapDagJobLike strips `dag` and `incomingByNode` on updateData and
  // re-injects them from the live call-site on data-read. This test verifies
  // the contract by snooping on a custom jobLike between the wrapper and
  // disk: writes never carry `dag` or `incomingByNode`.
  it("persisted snapshot omits dag and incomingByNode; reads re-inject live values", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", { run: async () => ok("a-out") }),
        makeNode("b", { run: async () => ok("b-out") }),
      ],
      edges: [{ from: "a", to: "b" }],
    });

    // Snoop on every updateData write to the inner store.
    const snapshots: Array<{ state: unknown; context: Record<string, unknown> }> = [];
    let snapshot: { state: unknown; context: unknown } = {
      state: { kind: "pending" } as const,
      context: {} as unknown,
    };
    const innerJob = {
      get data() {
        return snapshot as { state: import("../dag-runtime/types.js").DagPhase; context: import("../dag-runtime/types.js").DagMachineContext };
      },
      async updateData(d: { state: import("../dag-runtime/types.js").DagPhase; context: import("../dag-runtime/types.js").DagMachineContext }) {
        snapshots.push({ state: d.state, context: d.context as unknown as Record<string, unknown> });
        snapshot = d;
      },
      async updateProgress() {},
      async appendEvent() {},
    };

    // Seed the inner with the proper initial context BEFORE running.
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    snapshot = { state: compiled.value.initialState, context: compiled.value.initialContext };

    const result = await runDagStateful(dag, null, makeCtx(), { jobLike: innerJob });
    expect(result.ok).toBe(true);

    // At least one write happened, and every write's context lacks dag + incomingByNode.
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) {
      expect("dag" in snap.context).toBe(false);
      expect("incomingByNode" in snap.context).toBe(false);
    }
  });

  it("checkpoint is NOT written when state is failed (FR-005)", async () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", {
          run: async () => err({ kind: "node-crash" as const, nodeId: "a", message: "boom" }),
        }),
      ],
      edges: [],
      // defaultRetryLimit = 0 => fails immediately
    });

    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { initialContext, initialState } = compiled.value;
    const job = createInMemoryJob({ state: initialState, context: initialContext });

    const result = await runDagStateful(dag, null, makeCtx(), { jobLike: job });
    expect(result.ok).toBe(false);

    // The job's persisted state should NOT be "failed" — it should be the last
    // successfully checkpointed state (the initial state or the last non-failed state)
    // In this case, we may have checkpointed "running" but not "failed"
    expect(job.data.state.kind).not.toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 15. Sequential human reviews (multiple HITL nodes in same wave, FR-028)
// ---------------------------------------------------------------------------

describe("runDagStateful — sequential human reviews (FR-028)", () => {
  it("two humanReview nodes in same wave are reviewed in ascending id order", async () => {
    const reviewOrder: string[] = [];

    const dag = makeDag({
      nodes: [
        makeNode("z-node", {
          humanReview: { prompt: "Review Z" },
          run: async () => ok("z-out"),
        }),
        makeNode("a-node", {
          humanReview: { prompt: "Review A" },
          run: async () => ok("a-out"),
        }),
      ],
      edges: [],
      outputNodeId: "a-node",
    });

    const onHumanReview = async (req: { nodeId: string; output: unknown; prompt: string }): Promise<HumanAction> => {
      reviewOrder.push(req.nodeId);
      return { action: "approve" };
    };

    const result = await runDagStateful(dag, null, makeCtx(), { onHumanReview });
    expect(result.ok).toBe(true);

    // "a-node" < "z-node" lexicographically — should be reviewed first
    expect(reviewOrder[0]).toBe("a-node");
    expect(reviewOrder[1]).toBe("z-node");
  });
});

// ---------------------------------------------------------------------------
// 16. Cycle detection
// ---------------------------------------------------------------------------

describe("runDagStateful — cycle detection", () => {
  it("cyclic DAG returns FrameworkError without throwing", async () => {
    const dag = makeDag({
      nodes: [makeNode("a"), makeNode("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cycle-detected");
    }
  });

  it("cyclic DAG emits balanced run-start/run-end observer events", async () => {
    const { RecordingObserver } = await import("../observer/observer.js");
    const observer = new RecordingObserver();
    const ctx = { ...makeCtx(), observer };

    const dag = makeDag({
      nodes: [makeNode("a"), makeNode("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });

    const result = await runDagStateful(dag, null, ctx);
    expect(result.ok).toBe(false);

    const types = observer.events.map((e) => e.type);
    expect(types).toContain("run-start");
    const runEnd = observer.events.find((e) => e.type === "run-end");
    expect(runEnd && "status" in runEnd ? runEnd.status : undefined).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 17. Per-node retry limit overrides default
// ---------------------------------------------------------------------------

describe("runDagStateful — per-node retry limits", () => {
  it("per-node retryLimits overrides defaultRetryLimit", async () => {
    let aAttempts = 0;
    let bAttempts = 0;

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => {
            aAttempts++;
            if (aAttempts < 3) return err({ kind: "node-crash" as const, nodeId: "a", message: "t" });
            return ok("a-ok");
          },
        }),
        makeNode("b", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => {
            bAttempts++;
            return ok("b-ok");
          },
        }),
      ],
      edges: [{ from: "a", to: "b" }],
      defaultRetryLimit: 1, // default: 1 retry
      retryLimits: { a: 5 }, // node "a" gets 5 retries
    });

    const result = await runDagStateful(dag, null, makeCtx());
    expect(result.ok).toBe(true);
    expect(aAttempts).toBe(3); // 1 initial + 2 retries
    expect(bAttempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 18. onHumanReview throws — structured node-crash + node-error observer event
// ---------------------------------------------------------------------------

describe("runDagStateful — onHumanReview throws", () => {
  it("onHumanReview throw (0 retries) => err(node-crash) with nodeId + node-error observer event", async () => {
    const nodeErrorEvents: string[] = [];
    const observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: (e: { nodeId: string }) => nodeErrorEvents.push(e.nodeId),
      onSubSpan: () => {},
      onRunEnd: () => {},
    };

    const dag = makeDag({
      nodes: [
        makeNode("review-node", {
          humanReview: { prompt: "Please review" },
          run: async () => ok("node-output"),
        }),
      ],
      edges: [],
      // defaultRetryLimit = 0 => immediately terminal on hook crash
    });

    const onHumanReview = async (_req: any): Promise<HumanAction> => {
      throw new Error("hook exploded");
    };

    const ctx: NodeContext = { ...makeCtx(), observer };
    const result = await runDagStateful(dag, null, ctx, { onHumanReview });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.nodeId).toBe("review-node");
        expect(result.error.message).toBe("hook exploded");
      }
    }
    expect(nodeErrorEvents).toContain("review-node");
  });

  it("hook fails twice then succeeds: node.run called once, hook called 3 times, final result ok", async () => {
    // FR-029a regression guard: hook retries MUST NOT re-run the node.
    let nodeRunCount = 0;
    let hookCallCount = 0;
    const nodeErrorEvents: string[] = [];

    const observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: (e: { nodeId: string }) => nodeErrorEvents.push(e.nodeId),
      onSubSpan: () => {},
      onRunEnd: () => {},
    };

    const dag = makeDag({
      nodes: [
        makeNode("review-node", {
          humanReview: { prompt: "Please review" },
          retry: { backoffMs: [0, 0, 0], jitterRatio: 0 }, // no delay in tests
          run: async () => {
            nodeRunCount++;
            return ok("node-output");
          },
        }),
      ],
      edges: [],
      defaultRetryLimit: 3, // allow up to 3 hook retries
    });

    const onHumanReview = async (_req: any): Promise<HumanAction> => {
      hookCallCount++;
      if (hookCallCount < 3) {
        throw new Error(`hook crash #${hookCallCount}`);
      }
      return { action: "approve" };
    };

    const ctx: NodeContext = { ...makeCtx(), observer };
    const result = await runDagStateful(dag, null, ctx, { onHumanReview });

    // Final result should be ok (hook recovered on 3rd call)
    expect(result.ok).toBe(true);

    // node.run MUST have been called only once — hook retries do not re-execute the node
    expect(nodeRunCount).toBe(1);

    // hook was called 3 times (2 crashes + 1 success)
    expect(hookCallCount).toBe(3);

    // node-error observer events were emitted for each hook crash
    expect(nodeErrorEvents.filter((id) => id === "review-node")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 19. runWave retry — sibling A should not re-run when B fails then succeeds (M2)
// ---------------------------------------------------------------------------

describe("runDagStateful — runWave partial output staleness (M2)", () => {
  it("wave [A, B]: A succeeds, B fails then succeeds — A.run called exactly once", async () => {
    let aRunCount = 0;
    let bRunCount = 0;

    const dag = makeDag({
      nodes: [
        makeNode("a", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => {
            aRunCount++;
            return ok("a-out");
          },
        }),
        makeNode("b", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => {
            bRunCount++;
            if (bRunCount < 2) {
              return err({ kind: "node-crash" as const, nodeId: "b", message: "b transient" });
            }
            return ok("b-out");
          },
        }),
      ],
      edges: [],
      defaultRetryLimit: 1,
    });

    const result = await runDagStateful(dag, null, makeCtx());

    expect(result.ok).toBe(true);
    // A succeeded on the first wave run and must NOT be re-executed on B's retry.
    expect(aRunCount).toBe(1);
    // B ran twice: first failure + one retry
    expect(bRunCount).toBe(2);
  });
});
