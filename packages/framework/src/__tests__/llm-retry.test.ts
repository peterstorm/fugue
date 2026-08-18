import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { NodeContext } from "../types/node.js";
import type { LlmRequest, LlmResponse } from "../types/llm.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import { createLlmNode } from "../nodes/llm.js";
import { stubSendWithTools } from "./_llm-mocks.js";
import { defineDag } from "../executor/define-dag.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { N } from "./_id-helpers.js";

const OutputSchema = z.object({ greeting: z.string() });

const mkLlmCtx = (outputs: unknown[]): NodeContext => {
  let callCount = 0;
  return {
    runId: "test" as RunId,
    dagId: "test" as DagId,
    observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null, http: null, clock: null,
    cache: null,
    logger: { warn: () => {}, error: () => {} },
    prompts: { get: (_name: string) => "prompt template" },
    llm: {
      sendWithTools: stubSendWithTools,
      sendStructured: async (_req: LlmRequest<any>): Promise<Result<LlmResponse<any>, FrameworkError>> => {
        const output = outputs[callCount++];
        return ok({
          output,
          tokensIn: 10,
          tokensOut: 5,
          rawText: JSON.stringify(output),
        });
      },
    },
  };
};

describe("LLM node retry", () => {
  it("retries once on output validation failure then succeeds", async () => {
    const node = createLlmNode({
      id: N("llm1"),
      inputSchema: z.object({ name: z.string() }),
      outputSchema: OutputSchema,
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });

    // First response invalid, second valid
    const ctx = mkLlmCtx([
      { greeting: 123 },        // fails zod validation
      { greeting: "hello" },    // passes
    ]);

    const result = await node.run({ name: "world" }, ctx as any);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ greeting: "hello" });
    }
  });

  it("second validation failure returns Err(retry-exhausted)", async () => {
    const node = createLlmNode({
      id: N("llm2"),
      inputSchema: z.object({ name: z.string() }),
      outputSchema: OutputSchema,
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });

    // Both responses invalid
    const ctx = mkLlmCtx([
      { greeting: 123 },
      { greeting: 456 },
    ]);

    const result = await node.run({ name: "world" }, ctx as any);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
    }
  });
});

// ---------------------------------------------------------------------------
// W5.6 — rate-limit → transient → DAG retry-exhausted, end to end.
//
// Pass-3 §2.1 added `rootErrorKind` to `retry-exhausted` so consumers can
// dispatch on the underlying cause without parsing `lastError` strings.
// pass-3-remediation.test.ts already covers transient → retry-exhausted at
// the *node* level (a node returning err(transient)). What's missing is the
// LLM-shape: the actual LLM-client path returning a 429-style transient, run
// through the full DAG executor — the wiring smoke that "the LLM client error
// surfaces correctly to the DAG retry policy" is otherwise untested.
// ---------------------------------------------------------------------------

const mkAlwaysTransientLlmCtx = (counter: { calls: number }): NodeContext => ({
  runId: "test" as RunId,
  dagId: "test" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null, http: null, clock: null,
  cache: null,
  logger: { warn: () => {}, error: () => {} },
  prompts: { get: (_name: string) => "prompt template" },
  llm: {
    sendWithTools: stubSendWithTools,
    sendStructured: async (
      _req: LlmRequest<any>,
    ): Promise<Result<LlmResponse<any>, FrameworkError>> => {
      counter.calls += 1;
      return err({
        kind: "transient",
        nodeId: "llm-rate-limited" as NodeId,
        message: `429 rate limited (attempt ${counter.calls})`,
      });
    },
  },
});

describe("LLM rate-limit → DAG retry-exhausted (W5.6)", () => {
  it("transient on every attempt → run terminates with retry-exhausted and rootErrorKind=transient", async () => {
    const counter = { calls: 0 };

    const llmNode = createLlmNode({
      id: N("llm-rate-limited"),
      inputSchema: z.object({ name: z.string() }),
      outputSchema: OutputSchema,
      promptName: "greet",
      model: "test-model",
      buildInput: (i) => i,
    });
    // Tighten the per-attempt backoff so the test exercises the retry path
    // without sleeping through the DAG executor's default [1s, 2s, 4s] curve.
    // The wave-resolution policy still gets to make its retry decisions; only
    // the wall-clock cost is removed.
    const fastLlmNode = { ...llmNode, retry: { backoffMs: [0, 0, 0], jitterRatio: 0 } };

    const dag = defineDag({
      id: "rate-limited-dag" as DagId,
      nodes: { "llm-rate-limited": fastLlmNode as any },
      edges: [{ from: DAG_INPUT, to: "llm-rate-limited" }],
      defaultRetryLimit: 2,
    });

    const ctx = mkAlwaysTransientLlmCtx(counter);

    // The fixed input that satisfies llmNode.inputSchema (DAG layer feeds the
    // initial value to root nodes verbatim).
    const result = await runDagStateful(
      dag,
      { name: "world" } as any,
      ctx as any,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
      if (result.error.kind === "retry-exhausted") {
        // The DAG retry-policy must unwrap the transient client error and
        // expose its `kind` via `rootErrorKind` — operators dispatch alerting
        // ("429 surges" vs "code crashes") on this field.
        expect(result.error.rootErrorKind).toBe("transient");
        expect(result.error.lastError).toContain("429 rate limited");
      }
    }

    // attempts=initial+retries — `createLlmNode` does one internal retry on
    // validation failure but here every transient is surfaced verbatim, so
    // the LLM client is called once per node attempt. With defaultRetryLimit=2,
    // the executor performs the initial attempt plus two retries = 3 calls.
    expect(counter.calls).toBeGreaterThanOrEqual(3);
  });
});
