# Plan: Finish remediation — outstanding waves from `feat/initial-setup`

**Created:** 2026-05-10
**Status:** Draft
**Predecessor:** `2026-05-10-pr-review-remediation.md` — Waves 1, 2, 4.1/4.3/4.4, 5.1/5.6, and 6.3/6.4 landed. This plan finishes everything else.

---

## What's left, at a glance

| Source wave | Item | Difficulty | Risk |
|---|---|---|---|
| 5.2 | `DagDef.nodes` `any → unknown` (redo with casts) | XS | low |
| 5.3 | `deserializeValue` validator hook on `adaptBullMQJob` | S | low |
| 5.4 | `ContextCacheAdapter.set` returns `Result<void, FrameworkError>` | S | breaking |
| 6.1 | `DagRunMeta` — drop mutable accumulator | M | medium (concurrency) |
| 6.2 | Live `AbortSignal` propagation test | S | low |
| 7.6 | Break `types/node.ts ↔ llm/client.ts` cycle | S | low |
| 7.4 | Remove `Machine.maxRetries` from kernel | XS | low |
| 7.2 | `LLM_TRACE_PROMPTS` via `NodeContext.includeContent` | S | low |
| 7.3 | `LlmNodeConfig.system` override | S | low |
| 7.1 | `createLlmWithToolsNode` factory | M | new public API |
| 7.5 | Boundary import rule for `@opentelemetry/*` | S | low |
| 4.2 | Idempotent `appendEvent` (Option A — deterministic key) | L | high |
| 3 | `anthropic-client.test.ts` + `openai-client.test.ts` (~25 each) | L | low |
| 8 | `code-simplifier` polish pass | S | low |

Total ~5–6 days of focused work. Independent enough to ship in 4 PRs.

---

## Sequencing rationale

Cycle break (7.6) goes first because the factory (7.1) wants the leaner `LlmClient.sendWithTools` signature — doing 7.1 first means redoing it. After 7.6 the kernel-side cleanups (7.4) and trace-context plumbing (7.2/7.3) are independent and can ship in parallel. Then the factory (7.1) lands on top. Boundary lint (7.5) lands last in the architecture batch because it asserts the boundary the prior changes establish.

The error-semantics + type-sharpening trio (5.2/5.3/5.4) is uncoupled from architecture and ships independently. 6.1 (concurrency) ships with 6.2 (its test) because the test is the acceptance gate.

4.2 (idempotent appendEvent) is its own PR — it's the highest-risk item and changes the `JobLike` shape.

Wave 3 (LLM client tests) ships last so the tests exercise the post-refactor code rather than tracking moving targets.

---

## PR 1 — Type sharpening + error semantics (waves 5.2, 5.3, 5.4)

### 5.2 `DagDef.nodes` — `any` → `unknown`, redo with casts

`packages/framework/src/types/dag.ts:11`. Change to `readonly NodeDef<unknown, unknown, unknown>[]`. Five sites need an `as` cast at the array literal:

- `apps/customer-summary/src/dag/summary-dag.ts:33`
- `apps/customer-summary/src/__tests__/observability-resume.test.ts` (~4 sites)
- `packages/framework/src/__tests__/executor.test.ts` (~10 sites)
- `packages/framework/src/__tests__/executor-eval-judge.test.ts` (~2 sites)
- `packages/framework/src/__tests__/second-dag.test.ts` (~1 site)

Approach: introduce `asDagNodes` helper in `types/dag.ts` (already drafted in the previous session before reverting):

```ts
export const asDagNodes = (
  nodes: readonly NodeDef<any, any, any>[],
): readonly NodeDef<unknown, unknown, unknown>[] =>
  nodes as readonly NodeDef<unknown, unknown, unknown>[];
```

Apply at each `nodes:` literal. The cast is honest — `unknown` is the right *outer* type, the helper localizes the variance leak to one place per site.

**Acceptance:** all sites compile, tests pass, no `nodes: [...] as any` shortcuts.

### 5.3 `deserializeValue` validator hook

`packages/framework/src/queue-bullmq/job.ts:51` casts `deserializeValue(bullJob.data) as { state: S; context: C }`. Add a validator option to `adaptBullMQJob`:

```ts
export interface AdaptBullMQJobOpts {
  readonly eventLog?: EventLogOpts;
  readonly validateData?: (raw: unknown) => Result<{ state: unknown; context: unknown }, FrameworkError>;
}
```

When `validateData` is supplied, run it on every `data` read; on failure surface `checkpoint-corrupt`. Default behavior unchanged. Add a JSDoc on the unsafe cast: "Without `validateData`, callers trust the producer side wrote a `{state, context}` envelope; mismatches surface only when consumers misinterpret."

**Acceptance:** existing tests pass; one new test asserts `validateData` invoked on each read; one new test asserts a failing validator surfaces `checkpoint-corrupt`.

### 5.4 `ContextCacheAdapter.set` returns `Result`

`packages/framework/src/types/node.ts:63-67`. Change the interface:

```ts
export interface ContextCacheAdapter {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly set: (key: string, value: unknown, ttlSec?: number) => Promise<Result<void, FrameworkError>>;
  readonly writeCheckpoint?: (runId: string, nodeId: string, value: unknown) => Promise<void>;
}
```

Update consumers:

- `packages/framework/src/nodes/llm.ts:147` — handle the Result; on `Err`, log and continue (cache write failures must never break a successful run).
- `apps/customer-summary/src/bootstrap.ts:99` — already returns the Result from `cache.set`, just stop awaiting `unknown`.
- `apps/customer-summary/src/dag/nodes/enrich-with-tools.example.ts:57` — same handling.

**Acceptance:** typecheck clean; cache-set failures appear in logs but do not propagate as run failures (existing fail-open semantics preserved).

---

## PR 2 — Concurrency + cancellation correctness (waves 6.1, 6.2)

### 6.1 `DagRunMeta` — drop mutable accumulator

`packages/framework/src/executor/node-span.ts:17,18,76,77`. Today `meta.guardrailFailed = true` and `meta.guardrailWarnings.push(...)` mutate shared state inside `withNodeSpan` callbacks that may run concurrently for sibling nodes.

Refactor:

1. Change `withNodeSpan` to *return* the guardrail outcome rather than mutating an external object:
   ```ts
   interface NodeSpanOutcome {
     readonly guardrailFailed: boolean;
     readonly guardrailWarnings: readonly string[];
   }
   ```
2. `runWave` collects outcomes from `await Promise.all(siblings)` and folds them into a fresh immutable `DagRunMeta` per wave.
3. Same treatment for `evalJudgeResults` — collect, don't mutate.
4. Drop `DagRunMeta` mutability: change to `interface DagRunMeta { readonly guardrailFailed: boolean; readonly guardrailWarnings: readonly string[]; readonly evalJudgeResults: readonly EvalJudgeResult[]; }`.

Touched files: `executor/node-span.ts`, `executor/executor.ts:192`, `dag-runtime/run-dag-stateful.ts:207-209`.

**Acceptance:** typecheck clean; all guardrail tests pass; no `meta.X = ...` or `meta.X.push(...)` left in the codebase (`grep` check in CI optional).

### 6.2 Live AbortSignal propagation test

Add to `packages/framework/src/__tests__/dag-runtime-stateful.test.ts`:

```ts
test("aborting mid-run cancels the in-flight node and resolves Err(aborted)", async () => {
  const controller = new AbortController();
  let observedSignalAborted = false;
  const slowNode: NodeDef<{}, {}, FrameworkError> = {
    id: "slow", kind: "transform", deps: [],
    inputSchema: z.object({}), outputSchema: z.object({}),
    run: async (_input, ctx) => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (ctx.signal?.aborted) {
          observedSignalAborted = true;
          return err({ kind: "aborted" as const, reason: "signal" });
        }
        await new Promise(r => setTimeout(r, 10));
      }
      return ok({});
    },
  };
  // ...build DAG with slowNode...
  setTimeout(() => controller.abort(), 50);
  const result = await runDagStateful(dag, {}, { signal: controller.signal, ... });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.kind).toBe("aborted");
  expect(observedSignalAborted).toBe(true);
});
```

**Acceptance:** the test fails today (signal not threaded all the way through to in-flight `run`), passes after fixing whatever that exposes.

---

## PR 3 — Architecture cleanups (waves 7.6, 7.4, 7.2, 7.3, 7.1, 7.5)

This is the biggest PR. Split internally into commits in the order below.

### 7.6 Break `types/node.ts ↔ llm/client.ts` cycle (commit 1)

Today: `types/node.ts:4` imports `LlmClient`; `llm/client.ts:4` imports `NodeContext`. The cycle compiles only because TypeScript resolves type-only imports lazily.

Approach (Option A from the source plan): change `LlmClient.sendWithTools` to accept `tracer` + `signal` directly:

```ts
export interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    runtime: { readonly tracer?: Tracer | null; readonly signal?: AbortSignal },
  ): Promise<Result<LlmResponse<O>, FrameworkError>>;
}
```

`Tracer` moves to its own module (`tracing/tracer.ts`) so neither side imports the other. Drop `import type { NodeContext }` from `llm/client.ts`. Update `anthropic-client.ts`, `openai-client.ts`, `fake-client.ts` to read `runtime.tracer` / `runtime.signal` instead of `ctx.tracer` / `ctx.signal`. Update three call sites in nodes (`nodes/llm.ts`, `nodes/eval-judge.ts`, `enrich-with-tools.example.ts`) to pass `{ tracer: ctx.tracer, signal: ctx.signal }`.

**Acceptance:** `madge --circular packages/framework/src` (or equivalent) reports zero cycles.

### 7.4 Remove `Machine.maxRetries` (commit 2)

`packages/framework/src/state-machine/types.ts:10`. Field is declared but no consumer reads it — the actual retry budget lives on `DagDef.retryLimits` and `NodeDef.retry`. Remove the field and the `maxRetries: {}` assignment in `compileDagToMachine`.

**Acceptance:** typecheck clean; grep finds no remaining references.

### 7.2 `LLM_TRACE_PROMPTS` via `NodeContext.includeContent` (commit 3)

Three `process.env.LLM_TRACE_PROMPTS` reads:

- `dag-runtime/eval-judges.ts:34`
- `executor/node-span.ts:53`
- `tracing/span-enrich.ts:31`

Add `readonly includeContent?: boolean` to `NodeContext`. Bootstrap reads the env var once and seeds every spawned context. Replace each env read with `ctx.includeContent ?? false`. For `span-enrich.ts` (which doesn't take a `NodeContext`), pass `includeContent` explicitly via the call site.

Update tests that previously mutated `process.env.LLM_TRACE_PROMPTS` — switch to passing `includeContent: true` on the test context.

**Acceptance:** no `process.env.LLM_TRACE_PROMPTS` reads outside `bootstrap.ts`; existing trace-content tests pass.

### 7.3 `LlmNodeConfig.system` override (commit 4)

`packages/framework/src/nodes/llm.ts:86`. Today the system prompt is the hard-coded "You are an AI assistant…". Add `readonly system?: string` to `LlmNodeConfig`. When set, use it; otherwise the existing default.

Migrate `apps/customer-summary/prompts/synthesis.txt` — extract the persona prelude into a separate `synthesis-system.txt`, register it via the prompt store, pass it as `system` on the synthesize node.

**Acceptance:** synthesize node behavior is byte-identical (compare a recorded run before/after); other tests unchanged.

### 7.1 `createLlmWithToolsNode` factory (commit 5)

New module `packages/framework/src/nodes/llm-with-tools.ts`. Mirror `createLlmNode` shape — see source plan §7.1 for the full config interface. Key requirements:

- Reads system + user prompts from `ctx.prompts` registry, or uses the inline `system`/`buildUser`.
- Calls `ctx.llm.sendWithTools(...)` passing `nodeId: config.id` (locks down wave-1.4 fix).
- Runs FR-021 validation-retry loop with a config dial to disable.
- Caches via `ctx.cache` keyed on `(promptHash, modelName, inputHash, toolNamesHash)`.
- Wraps in `withNodeSpan` with `enrichLlmSpan` + GenAI semconv attributes.

Migrate `apps/customer-summary/src/dag/nodes/enrich-with-tools.example.ts` to use the factory. Add a unit test in `packages/framework/src/__tests__/llm-with-tools-factory.test.ts` exercising the cache hit path.

**Acceptance:** factory test passes; example app still builds and the example node behaves identically; new public surface documented in `index.ts` exports.

### 7.5 Boundary import rule (commit 6)

`packages/framework/src/scripts/check-imports.ts`. Add:

```ts
{
  scope: ["state-machine/", "dag-runtime/transition.ts", "dag-runtime/transition-helpers.ts", "dag-runtime/machine.ts"],
  forbidden: ["@opentelemetry/"],
  reason: "Pure-core modules must not depend on OTel; tracing belongs to the imperative shell.",
}
```

Shell files (`run-dag-stateful.ts`, `dag-runtime/executor.ts`, `eval-judges.ts`) explicitly excluded.

**Acceptance:** lint script passes today (the prior commits should have already removed any stray `@opentelemetry` imports from pure-core); regressing it locally adds a lint failure.

---

## PR 4 — Idempotent appendEvent (wave 4.2)

The riskiest change. Isolated to its own PR so it can be reverted cleanly if it misbehaves under fault injection.

### Approach

The runner today calls `await job.appendEvent(event)` then `await job.updateData(...)`. A worker crash between the two produces a duplicate event on retry. Fix: derive a deterministic per-transition key in the runner; pass it to `appendEvent`; the adapter dedupes against the last stream entry.

#### 4.2.1 Extend `JobLike.appendEvent`

```ts
// state-machine/types.ts
appendEvent(event: unknown, dedupKey?: string): Promise<void>;
```

`dedupKey` is optional for back-compat. When supplied, the adapter must guarantee that a second call with the same key for the same job is a no-op.

#### 4.2.2 Compute the key in the runner

`packages/framework/src/state-machine/runner.ts:97`:

```ts
const dedupKey = await sha256Hex(`${runId}|${stateKey}|${attemptNumber}|${eventTypeOf(event)}`);
await job.appendEvent(event, dedupKey);
```

`stateKey` already exists at line 84. `attemptNumber` comes from the existing retry counter. Hash kept short (16 hex chars is plenty).

#### 4.2.3 BullMQ adapter dedup

`packages/framework/src/queue-bullmq/job.ts:76-127`. Wrap `XADD` in a Lua script:

```lua
-- KEYS[1] = stream key
-- ARGV[1] = dedupKey (or empty)
-- ARGV[2..] = field/value pairs for XADD
if ARGV[1] ~= "" then
  local last = redis.call("XREVRANGE", KEYS[1], "+", "-", "COUNT", 1)
  if #last > 0 then
    local fields = last[1][2]
    for i = 1, #fields, 2 do
      if fields[i] == "dedupKey" and fields[i+1] == ARGV[1] then
        return 0  -- already appended; no-op
      end
    end
  end
end
-- XADD with all remaining args
return redis.call("XADD", KEYS[1], unpack(ARGV, 2))
```

Cache via `SCRIPT LOAD` / `EVALSHA` like `RedisCheckpointer.saveNode`. Add the `dedupKey` field to the stored payload alongside `type` / `payload`.

#### 4.2.4 In-memory adapter dedup

`packages/framework/src/state-machine/in-memory-job.ts:49`. Track last `dedupKey` per stream; skip append if it matches.

#### 4.2.5 Tests

- `redis-event-log-dedup.test.ts` (Redis-gated): two calls with the same `dedupKey` produce one stream entry.
- `in-memory-job-dedup.test.ts`: same property for the in-memory backend.
- `runner-crash-resume.test.ts`: simulate a worker crash between `appendEvent` and `updateData`, restart, assert exactly one event in the log.

#### 4.2.6 ADR amendment

Update `docs/adr/0008-event-envelope-and-time.md` (or add ADR 0014) describing the dedup key shape and the at-most-once delivery guarantee. Remove the at-least-once docstring caveat from `runner.ts` added in the previous remediation pass.

**Acceptance:** the crash-resume test passes; existing event-log tests unchanged; Redis-gated tests pass when `REDIS_URL` is set.

---

## PR 5 — LLM client unit tests (wave 3)

### 5.1 `anthropic-client.test.ts` (~25 cases)

Stub `Anthropic.messages.create` (mock the constructor or inject a fake `Anthropic` instance via the client constructor). Cases:

**`sendStructured`**
- Schema → JSON Schema with `tool_choice: { type: "tool", name: "structured_output" }`.
- Successful `tool_use` parses against Zod.
- Schema validation failure → `node-crash` with `nodeId: req.nodeId ?? "<llm>"`.
- Pre-aborted signal → `aborted`.
- Missing `tool_use` block → `node-crash`.
- Token usage propagated.

**`sendWithTools`**
- Single-turn final answer (text block, fences stripped).
- Multi-turn loop: `tool_use` → dispatcher runs tool → next turn returns `end_turn`.
- Tool input becomes `input_schema` JSON Schema (no `$schema`).
- `toolChoice: "auto" | "any" | "none"` mapping.
- Iteration cap → `transient` with `nodeId`.
- Pre-aborted signal → `aborted`.
- `APIUserAbortError` mid-call → `aborted`.

**Helpers** (export them from `anthropic-client.ts` or test via behavior): `stripCodeFences`, `lastTextBlock`, `buildToolResultMessage`, `parseToolCalls`, `toolToAnthropicSpec`.

### 5.2 `openai-client.test.ts` (~25 cases)

Stub `globalThis.fetch`. Refactor `OpenAILlmClient` to take `baseUrl`, `apiKey`, `apiVersion?` as explicit constructor params (drops the `(openai as any)._options` reads — covered by source plan §3.3). Cases:

**`sendStructured`**
- `text.format = json_schema` body shape.
- `addAdditionalPropertiesFalse` recurses into nested objects.
- `buildRequestConfig` URL/headers for both standard OpenAI and Azure (`apiVersion` set).
- Reasoning summary extraction.
- Non-200 → `node-crash` with status + body.
- AbortError → `aborted`.

**`sendWithTools`**
- Multi-turn loop with `function_call` blocks; next call's `input` array contains prior `function_call` + `function_call_output`.
- Malformed `arguments` JSON → tool result is `is_error: true` with `__parse_error__`.
- `toolChoice: "any"` → `tool_choice: "required"`.
- Iteration cap → `transient`.

**Helpers**: `parseToolCalls`, `extractFinalText`, `extractReasoning`, `buildToolResultItems`, `addAdditionalPropertiesFalse`. Export and test directly.

**Acceptance:** ≥25 passing tests per file; coverage of the surface mutated in waves 1, 2, 4, 7.

---

## PR 6 — Final polish (wave 8)

After PRs 1–5 land, run the `code-simplifier` agent on the cumulative diff. Address its findings. Specifically:

- Strip section-divider comments around single-line `ts-pattern` arms in `executor.ts`.
- Pre-build `nodeId → waveIndex` map and reuse it where `transition-helpers.ts:421-434` rebuilds it (current O(N²) reroute clearing).
- Verify `transient` and `aborted` error variants are referenced consistently across the codebase post-wave-1 — fix any holdouts.

**No new tests.** This is cleanup-only.

---

## Test strategy across PRs

| PR | New tests | Existing tests |
|---|---|---|
| 1 | 2 (validateData round-trip, validateData failure) | adjust 1 cache assertion |
| 2 | 1 live-abort propagation test | DagRunMeta-touching tests pass unchanged |
| 3 | 1 factory cache-hit test; ~3 trace-content tests refactored | all existing tests still pass |
| 4 | 3 (Redis-gated + in-memory + crash-resume) | unchanged |
| 5 | ~50 client tests | unchanged |
| 6 | 0 | unchanged |

Total net new: ~57 tests.

---

## Risks + mitigations

- **PR 3 commit 1 (cycle break)** changes the `LlmClient.sendWithTools` signature — public API. Mitigate by exporting a `LlmRuntime` type so callers can construct it explicitly:
  ```ts
  export interface LlmRuntime { readonly tracer?: Tracer | null; readonly signal?: AbortSignal }
  ```
  Provide a `runtimeFromContext(ctx)` helper for migration ergonomics.

- **PR 4** is the biggest risk. Lua-based dedup must be stress-tested against fault injection. If `XREVRANGE` performance becomes a concern at high event volumes, fall back to a separate dedup-key index (`SET events:dedup:{jobId}:{key} 1 EX <ttl> NX`). Decide based on the Redis benchmark in commit 4.2.3.

- **PR 5** doubles the test count for `framework/src/__tests__/`. Watch for slow runs; if `bun test` exceeds 10s, split into a separate suite.

- **Wave 5.4 (cache.set Result)** is a breaking interface change. The two known callers are inside this repo, so it's safe — but `grep` for external usage in any consumer apps before merging.

---

## Rollout

| PR | Effort | Sequencing |
|---|---|---|
| 1 — Type/error sharpening | 0.5 day | Independent — ship first |
| 2 — Concurrency + abort test | 0.5 day | Independent — ship parallel with PR 1 |
| 3 — Architecture cleanups | 2 days | Ships after 1, 2 to keep diffs smaller |
| 4 — Idempotent appendEvent | 1.5 days | Independent of 1–3; can ship parallel with 3 |
| 5 — LLM client tests | 1 day | Last — exercises post-refactor code |
| 6 — Polish | 0.5 day | After all above |

Total: ~6 days for one engineer; ~3 calendar days with parallelism (PR 1 + 2 + 4 in parallel, then PR 3, then PR 5, then PR 6).

---

## Out of scope (still)

The deferrals from §10 of the predecessor plan remain deferred:

- Branded types for `runId` / `dagId` / `nodeId`.
- `stateProgress` 100-vs-failed cosmetic.
- `WorkerHandle.onFailed: err: unknown` vs `onError: err: Error` asymmetry.
- `GuardrailResult.value: T` discriminated-union refactor.
- `replayEvents` overload's `entry as E` cast.
- Two durability mechanisms (legacy per-node `RedisCheckpointer` vs state-machine `job.updateData`).
- In-memory queue resume divergence from BullMQ.
- Eval-judge fail-open *policy* itself (the v1 surfacing landed in wave 5.1).
- `serializeValue` cycle detection.
- `LlmRequest.thinking` for Anthropic (needs a streaming path).
- `HumanAction.approve-with-edit.newOutput` validation.

These remain candidates for follow-up PRs once this plan ships.
