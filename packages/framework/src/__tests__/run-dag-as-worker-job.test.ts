// runDagAsWorkerJob — wraps runDagStateful so worker queues see failures
// and apply retry/DLQ policy (codex finding #1).

import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { type NodeOverride, brandedOverride } from "./_node-override.js";
import { runDagAsWorkerJob } from "../executor/run-dag.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { createInMemoryBackend } from "../queue/in-memory.js";
import { defineDagFromArray } from "../executor/define-dag.js";

const noop = async (_input: unknown, _ctx: NodeContext) => ok(undefined as unknown);

const mkNode = (
  id: string,
  overrides: NodeOverride = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...brandedOverride(overrides),
});

const mkCtx = (): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null, clock: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("runDagAsWorkerJob", () => {
  it("returns the DAG output on success", async () => {
    const dag = defineDagFromArray({
      id: "ok",
      nodes: [mkNode("a", { run: async () => ok("a-out") })],
      edges: [{ from: DAG_INPUT, to: "a" }],
      defaultRetryLimit: 0,
    });
    const out = await runDagAsWorkerJob<unknown, string>(dag, null, mkCtx());
    expect(out).toBe("a-out");
  });

  it("throws on terminal failure (queue can retry/DLQ)", async () => {
    const dag = defineDagFromArray({
      id: "fail",
      nodes: [
        mkNode("a", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => err({ kind: "node-crash" as const, retriability: "retriable" as const, nodeId: "a" as NodeId, message: "boom" }),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "a" }],
      defaultRetryLimit: 0,
    });
    await expect(runDagAsWorkerJob(dag, null, mkCtx())).rejects.toThrow(/DAG 'fail' failed/);
  });

  it("worker using runDagAsWorkerJob: onFailed fires mid-retry, onExhausted fires on the final", async () => {
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<unknown, unknown>("q");

    const dag = defineDagFromArray({
      id: "fail",
      nodes: [
        mkNode("a", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => err({ kind: "node-crash" as const, retriability: "retriable" as const, nodeId: "a" as NodeId, message: "boom" }),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "a" }],
      defaultRetryLimit: 0,
    });

    const failedCalls: Array<{ attempts: number; max: number }> = [];
    const exhaustedCalls: Array<{ attempts: number }> = [];
    const worker = backend.createWorker("q", async (_job) => {
      await runDagAsWorkerJob(dag, null, mkCtx());
    });
    worker.onFailed((_id, _err, attempts, max) => {
      failedCalls.push({ attempts, max });
    });
    worker.onExhausted((_id, _err, attempts) => {
      exhaustedCalls.push({ attempts });
    });

    await queue.enqueue("job-1", { state: { kind: "pending" }, context: {} }, { attempts: 3 });
    await queue.drain();

    // Mid-retry (attempts 1, 2) → onFailed; exhausted attempt 3 → onExhausted.
    expect(failedCalls).toEqual([
      { attempts: 1, max: 3 },
      { attempts: 2, max: 3 },
    ]);
    expect(exhaustedCalls).toEqual([{ attempts: 3 }]);

    await worker.close();
  });

  it("HITL pre-flight: throws contract error when DAG declares humanReview but no onHumanReview hook", async () => {
    const dag = defineDagFromArray({
      id: "hitl-no-hook",
      nodes: [
        mkNode("a", {
          humanReview: { prompt: "review me" },
          run: async () => ok("a-out"),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "a" }],
      defaultRetryLimit: 0,
    });
    await expect(runDagAsWorkerJob(dag, null, mkCtx())).rejects.toThrow(/humanReview node\(s\)/);
  });

  it("worker using raw runDagStateful: onFailed does NOT fire (regression guard)", async () => {
    // This test documents the footgun: callers who skip the helper get silent
    // ack-on-failure. If this ever changes (e.g. runDagStateful re-throws),
    // delete this test along with the helper's necessity.
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<unknown, unknown>("q-raw");

    const dag = defineDagFromArray({
      id: "fail",
      nodes: [
        mkNode("a", {
          retry: { backoffMs: [0], jitterRatio: 0 },
          run: async () => err({ kind: "node-crash" as const, retriability: "retriable" as const, nodeId: "a" as NodeId, message: "boom" }),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "a" }],
      defaultRetryLimit: 0,
    });

    const failedCalls: number[] = [];
    const worker = backend.createWorker("q-raw", async (_job) => {
      // INTENTIONALLY wrong: ignore the err Result.
      await runDagStateful(dag, null, mkCtx());
    });
    worker.onFailed((_id, _err, attempts, _max) => {
      failedCalls.push(attempts);
    });

    await queue.enqueue("job-2", { state: { kind: "pending" }, context: {} }, { attempts: 3 });
    await queue.drain();

    expect(failedCalls.length).toBe(0); // queue saw success — no retries

    await worker.close();
  });
});
