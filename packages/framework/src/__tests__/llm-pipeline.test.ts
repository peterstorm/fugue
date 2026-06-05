import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { runLlmCallPipeline } from "../nodes/llm-pipeline.js";
import type { LlmPipelineConfig, LlmCallFn } from "../nodes/llm-pipeline.js";
import type { NodeContext, ContextCacheAdapter, CacheLookup } from "../types/node.js";
import type { LlmResponse } from "../types/llm.js";
import type { FrameworkError } from "../types/errors.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { NodeId, RunId, DagId } from "../types/ids.js";
import { NoopObserver } from "../observer/observer.js";
import { N, R, D } from "./_id-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const schema = z.object({ answer: z.string() });
type Output = z.infer<typeof schema>;

const baseConfig: LlmPipelineConfig<Output> = {
  nodeId: N("test-llm"),
  model: "gpt-4o",
  outputSchema: schema,
  prompts: { system: "sys", user: "usr" },
  cacheKey: "test-key",
};

const makeLlmResponse = (output: Output): LlmResponse<Output> => ({
  output,
  rawText: JSON.stringify(output),
  tokensIn: 10,
  tokensOut: 20,
});

const makeCallFn = (output: Output): LlmCallFn<Output> =>
  async () => ok(makeLlmResponse(output));

const failingCallFn = (error: FrameworkError): LlmCallFn<Output> =>
  async () => err(error);

const makeCache = (overrides?: Partial<ContextCacheAdapter>): ContextCacheAdapter => ({
  get: async () => ({ hit: false }),
  set: async () => ok(undefined) as Result<void, FrameworkError>,
  ...overrides,
});

const warns: string[] = [];
const makeCtx = (cache?: ContextCacheAdapter | null): NodeContext => ({
  runId: R("r1"),
  dagId: D("d1"),
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: cache ?? null,
  prompts: null,
  llm: null, http: null,
  logger: { warn: (msg: string) => warns.push(msg), error: () => {} },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLlmCallPipeline", () => {
  it("cache hit with valid schema returns cached value, skips LLM call", async () => {
    let called = false;
    const cache = makeCache({
      get: async () => ({ hit: true, value: { answer: "cached" } }),
    });
    const callFn: LlmCallFn<Output> = async () => { called = true; return ok(makeLlmResponse({ answer: "fresh" })); };

    const result = await runLlmCallPipeline(baseConfig, callFn, makeCtx(cache));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ answer: "cached" });
    expect(called).toBe(false);
  });

  it("cache hit with schema mismatch treats as miss, calls LLM", async () => {
    let called = false;
    const cache = makeCache({
      get: async () => ({ hit: true, value: { wrong: "shape" } }),
    });
    const callFn: LlmCallFn<Output> = async () => { called = true; return ok(makeLlmResponse({ answer: "fresh" })); };

    warns.length = 0;
    const result = await runLlmCallPipeline(baseConfig, callFn, makeCtx(cache));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ answer: "fresh" });
    expect(called).toBe(true);
    expect(warns.some((w) => w.includes("schema validation"))).toBe(true);
  });

  it("cache read throws logs warning and falls through to LLM call", async () => {
    const cache = makeCache({
      get: async () => { throw new Error("redis down"); },
    });
    warns.length = 0;

    const result = await runLlmCallPipeline(baseConfig, makeCallFn({ answer: "ok" }), makeCtx(cache));

    expect(result.ok).toBe(true);
    expect(warns.some((w) => w.includes("Cache read failed"))).toBe(true);
  });

  it("successful LLM call returns output", async () => {
    const result = await runLlmCallPipeline(baseConfig, makeCallFn({ answer: "hi" }), makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ answer: "hi" });
  });

  it("cache write passes NO per-call TTL — the adapter's configured default governs", async () => {
    // Regression: a hardcoded TTL here silently overrode every DAG's
    // cacheTtlMs (the host adapter treats the per-call value as an override).
    let seenTtl: number | undefined | "unset" = "unset";
    const cache = makeCache({
      set: async (_key, _value, ttlSec) => {
        seenTtl = ttlSec;
        return ok(undefined) as Result<void, FrameworkError>;
      },
    });

    const result = await runLlmCallPipeline(baseConfig, makeCallFn({ answer: "hi" }), makeCtx(cache));

    expect(result.ok).toBe(true);
    expect(seenTtl).toBeUndefined(); // set was called, with no TTL argument
  });

  it("cache write .ok=false logs but still returns ok", async () => {
    const cache = makeCache({
      set: async () => err({ kind: "cache-error", operation: "SET", message: "disk full" }) as Result<void, FrameworkError>,
    });
    warns.length = 0;

    const result = await runLlmCallPipeline(baseConfig, makeCallFn({ answer: "ok" }), makeCtx(cache));

    expect(result.ok).toBe(true);
    expect(warns.some((w) => w.includes("Cache write failed"))).toBe(true);
  });

  it("cache write throws logs but still returns ok", async () => {
    const cache = makeCache({
      set: async () => { throw new Error("connection reset"); },
    });
    warns.length = 0;

    const result = await runLlmCallPipeline(baseConfig, makeCallFn({ answer: "ok" }), makeCtx(cache));

    expect(result.ok).toBe(true);
    expect(warns.some((w) => w.includes("Cache write threw"))).toBe(true);
  });

  it("output validation fails + retry succeeds on second attempt", async () => {
    let attempt = 0;
    const callFn: LlmCallFn<Output> = async () => {
      attempt++;
      if (attempt === 1) return ok(makeLlmResponse({ answer: 123 } as any)); // invalid
      return ok(makeLlmResponse({ answer: "valid" }));
    };

    const result = await runLlmCallPipeline(baseConfig, callFn, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ answer: "valid" });
    expect(attempt).toBe(2);
  });

  it("output validation fails both attempts → retry-exhausted", async () => {
    const callFn: LlmCallFn<Output> = async () =>
      ok(makeLlmResponse({ answer: 999 } as any)); // always invalid

    const result = await runLlmCallPipeline(baseConfig, callFn, makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("retry-exhausted");
      if (result.error.kind === "retry-exhausted") {
        expect(result.error.attempts).toBe(2);
        expect(result.error.rootErrorKind).toBe("validation");
      }
    }
  });

  it("disableValidationRetry=true → no retry on validation failure", async () => {
    let attempt = 0;
    const callFn: LlmCallFn<Output> = async () => {
      attempt++;
      return ok(makeLlmResponse({ answer: 999 } as any)); // invalid
    };

    const config = { ...baseConfig, disableValidationRetry: true };
    const result = await runLlmCallPipeline(config, callFn, makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
    expect(attempt).toBe(1); // no retry
  });

  it("callFn returns err → propagates error unchanged", async () => {
    const error: FrameworkError = { kind: "transient", nodeId: N("test-llm"), message: "rate limited" };
    const result = await runLlmCallPipeline(baseConfig, failingCallFn(error), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual(error);
  });

  it("no cache on context → skips cache entirely, calls LLM", async () => {
    const result = await runLlmCallPipeline(baseConfig, makeCallFn({ answer: "no-cache" }), makeCtx(null));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ answer: "no-cache" });
  });
});
