---

# Plan: Remediation of `feat/initial-setup` PR review findings

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Fix the critical and important findings from the multi-agent PR review (`/loom:review-pr` against `main`) before the branch merges. Findings are grouped into ship-independent waves so each can be reviewed and merged on its own.

**Source review:** chat session 2026-05-10 — 22 critical, 38 advisory findings across code-reviewer / silent-failure-hunter / pr-test-analyzer / type-design-analyzer / comment-analyzer / architecture-tech-lead.

---

## Scope and triage

The review surfaced 60 findings. This plan tackles the ones where the cost of fixing now is much smaller than the cost of fixing later. Findings that were considered and deferred — with reasons — are listed in §10.

**Wave order is dependency-driven.** Cheap blockers ship first so wave-2+ work has a clean baseline. The big test gap (Anthropic / OpenAI clients) ships before the durability work so durability fixes are exercised against real behavior, not against unverified clients.

| Wave | Theme | Risk if deferred |
|------|-------|------------------|
| 1 | Quick blockers (ADR renumber, empty thinking branch, AbortError, nodeId, token namespace) | Wrong telemetry, wrong error routing, dead code |
| 2 | Observability foundation (TailSamplingProcessor, MlflowOtlpExporter) | Trace data-loss + silent shutdown failures |
| 3 | LLM client tests (Anthropic + OpenAI) | Tool-call paths fully untested in real-provider shape |
| 4 | Redis durability (checkpoint atomicity, event-log idempotency, connection lifecycle) | Audit/replay corruption, FD leaks |
| 5 | Error semantics + type sharpening (eval-judge skipped, transient.nodeId, DagDef.nodes any→unknown) | Quiet wrong-behavior in prod |
| 6 | Concurrency + doc accuracy (DagRunMeta, abort-signal propagation tests, two doc fixes, stale task labels) | Subtle races + stale guidance |
| 7 | Architecture cleanups (createLlmWithToolsNode factory, LLM_TRACE_PROMPTS, Machine.maxRetries, OpenAI private SDK access, boundary rules) | Friction for consumers, fragility on SDK upgrades |
| 8 | Final polish — `code-simplifier`, comment cleanup | n/a |

Each wave is a separate PR. Waves 1–4 are merge blockers; waves 5–8 are merge soft-blockers (should land but won't hold the branch up indefinitely).

---

## 1. Wave 1 — Quick blockers

Independent edits with low coupling and high signal.

### 1.1 Renumber duplicate ADR 0008

`docs/adr/0008-onhumanreview-hook-crash-retry.md` collides with `0008-event-envelope-and-time.md`. Both were merged in the same window. Rename the hook-crash-retry ADR to `0013-onhumanreview-hook-crash-retry.md` (next free slot after 0012 from this branch). Update any cross-references — `git grep "ADR 0008"` to find them.

### 1.2 OpenAI `AbortError` → `Err({ kind: "aborted" })`

In `packages/framework/src/llm/openai-client.ts`, the outer `catch` in `sendStructured` and `sendWithTools` wraps `AbortError` as `node-crash`. Add the classification:

```ts
if (error instanceof Error && error.name === "AbortError") {
  return err({ kind: "aborted", reason: "signal" });
}
```

Apply at every catch in the OpenAI client. Add a unit test in the new `openai-client.test.ts` (wave 3) that asserts a pre-aborted signal returns `kind: "aborted"`.

Also do the equivalent for the Anthropic client — verify whether the Anthropic SDK throws `APIUserAbortError` and handle it explicitly if so.

### 1.3 Remove the empty `thinking` branch in `AnthropicLlmClient.sendStructured`

`anthropic-client.ts:110-114`. The block is a no-op with a "future-task" comment. Two options:

- **Preferred:** delete the empty branch entirely. The `thinking` field will silently no-op for Anthropic until extended thinking gets a streaming-based implementation (out of scope for this remediation).
- **Document the no-op:** if we want to keep a placeholder, replace the `if` with a `logger.warn` in the imperative shell that calls `sendStructured` (e.g., the LLM node), so the operator sees a real signal.

Pick the first. Add a JSDoc on `LlmRequest.thinking`: "Anthropic ignores this in `sendStructured` (extended thinking requires streaming, not yet implemented). OpenAI maps it to `reasoning.effort: "high"`."

### 1.4 LLM client `nodeId` — stop using `req.model` as a node identifier

The 16 sites that build `FrameworkError.node-crash` with `nodeId: req.model` are wrong: `nodeId` is meant to identify a DAG node, not a model. Two paths:

- **Option A (preferred):** add `nodeId?: string` to both `LlmRequest` and `SendWithToolsRequest`. Default to `undefined`. The LLM node passes its own `id` when calling. The client uses `req.nodeId ?? "<llm>"` in error construction.
- **Option B:** introduce a dedicated `kind: "llm-error"` variant carrying `model`, `provider`, `message`. More invasive but more correct.

Option A is the smaller change and keeps the error union stable. Take it.

Also: `transient` variant currently has no `nodeId`. Add it: `{ kind: "transient"; nodeId: string; message: string }`. Same `req.nodeId ?? "<llm>"` resolution.

### 1.5 Token namespace alignment — fix `sendWithTools` MLflow blindness

`spans.ts:73-78` writes `gen_ai.usage.input_tokens` / `output_tokens`. `mlflow-otlp-exporter.ts:178-187` only reads `ai.llm.tokens_in` / `tokens_out`. Token usage from every `sendWithTools` call disappears in MLflow.

Fix in the exporter: read both namespaces. Prefer `gen_ai.usage.*` (modern OTel GenAI semconv); fall back to `ai.llm.*` for legacy `sendStructured`/`enrichLlmSpan` callers. A short helper:

```ts
const tokensIn  = (attrs["gen_ai.usage.input_tokens"]  as number | undefined)
              ?? (attrs["ai.llm.tokens_in"]            as number | undefined);
const tokensOut = (attrs["gen_ai.usage.output_tokens"] as number | undefined)
              ?? (attrs["ai.llm.tokens_out"]           as number | undefined);
```

Long-term we should pick one namespace. For this PR, dual-read is the smallest fix.

**Wave 1 exit:** ADR 0008 collision resolved. AbortError classified correctly. Anthropic empty branch removed. LLM errors carry real (or `<llm>`) node IDs. MLflow shows tokens for tool-call runs.

---

## 2. Wave 2 — Observability foundation

Three issues in two files. None block waves 3+ but shipping early prevents data-loss in the meantime.

### 2.1 `TailSamplingProcessor` — three fixes

**Public-field access:** replace `(span as any).parentSpanId` with the typed `span.parentSpanId` exposed publicly by `@opentelemetry/sdk-trace-base`. Drop the `as any`. If the field name has actually changed in the version we depend on, write a small adapter behind a typed helper that we can update in one place.

**Hot-path eviction throttle:** `evictStaleBuffers` runs O(M) per `onEnd` call. Track `_lastEvictedAt: number`; only run the scan when `Date.now() - _lastEvictedAt > 30_000`. The TTL semantics still hold within a 30s window.

**`forceFlush` actually waits:** convert the callback-based `exporter.export(...)` into a promise; `await Promise.all(exports)` before clearing buffers; then `await this.exporter.forceFlush?.()`. Same fix in `shutdown` — chain `forceFlush()` then `shutdown()` and propagate failures rather than logging-and-resolving.

### 2.2 `MlflowOtlpExporter` — stop mutating spans, fail loudly on import failure

**Stop mutating `ReadableSpan.attributes`:** the codebase already has `SpanAttributeRegistry` (`packages/framework/src/observer/span-attribute-registry.ts`) for this exact purpose. Wire it: during `transformSpan`, write the derived MLflow attributes to the registry keyed by `(traceId, spanId)`. The exporter reads from the registry when serializing the span for OTLP. The original `ReadableSpan` stays untouched.

**Failure semantics:** the lazy `getInner()` swallows import failures via `.catch(() => null)` and resets `innerPromise = null`, producing a thundering-herd of retries on permanent failures. Fix:

- Cache a `failedPermanently: Error | null` flag.
- On first import failure, set `failedPermanently` and resolve all subsequent `getInner()` calls to `null` immediately (no further imports).
- `shutdown` and `forceFlush` propagate `failedPermanently` rather than swallowing it.

**Tests:** add `mlflow-otlp-exporter.test.ts`:
- Span with `ai.span.type = "llm"` produces output with `mlflow.spanType` set correctly.
- Span with `gen_ai.usage.*` attributes produces correct `mlflow.chat.tokenUsage` (locks down the wave-1 namespace dual-read).
- `forceFlush` awaits the inner exporter.
- `shutdown` propagates a failed dynamic import rather than resolving `ok`.

### 2.3 `BufferedObserver` leak

`buffers` Map never evicts when `run-end` is missed. Add a TTL (default 1 hour) and a `setInterval`-based sweep, mirroring `TailSamplingProcessor.evictStaleBuffers`. Test: a buffer past TTL is dropped.

**Wave 2 exit:** trace pipeline is convention-correct, drop-safe, and tested. No silent data-loss on shutdown.

---

## 3. Wave 3 — LLM client unit tests

The big gap. Both clients ship completely untested at the unit level. Live integration tests gated on `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are out of scope for this wave (they belong to the original tool-call plan's PR 2/3 and can be added post-merge), but we ship comprehensive **stubbed** tests now.

### 3.1 `anthropic-client.test.ts`

Mock the `Anthropic` SDK with a stub that records request bodies and returns canned responses.

**`sendStructured`:**
- Schema → JSON Schema translation produces correct `tool_choice: { type: "tool", name: "structured_output" }`.
- Successful tool_use response parses against the Zod schema.
- Schema validation failure returns `node-crash` with the right `nodeId` (post-wave-1).
- Pre-aborted signal returns `aborted`.
- Missing tool_use block returns `node-crash`.

**`sendWithTools`:**
- Single-turn final answer: text block extracted, code-fenced JSON stripped, parsed.
- Multi-turn tool loop: stub returns `tool_use` block, dispatcher runs the user tool, next turn returns `end_turn`.
- Tool input → `input_schema` is JSON Schema from Zod (no `$schema`).
- `toolChoice: "auto" | "any" | "none"` maps to the right Anthropic shape.
- Iteration cap → `transient` error.
- Pre-aborted signal → `aborted`.

**Helpers (`stripCodeFences`, `lastTextBlock`, `buildToolResultMessage`, `parseToolCalls`, `toolToAnthropicSpec`):** unit-tested directly with hand-built fixtures. No SDK needed for these.

### 3.2 `openai-client.test.ts`

Stub `fetch` rather than the OpenAI SDK (the client uses raw fetch).

**`sendStructured`:**
- `text.format = json_schema` body shape correct.
- `addAdditionalPropertiesFalse` recursively annotates nested object schemas.
- `buildRequestConfig` produces the right URL and headers for both standard OpenAI and Azure (with `apiVersion` set).
- Reasoning summary extraction works when the model returns a `reasoning` block.
- Non-200 response → `node-crash` with status + body.
- AbortError → `aborted` (locks down wave 1.2).

**`sendWithTools`:**
- Multi-turn loop: stub `fetch` returns `function_call` blocks; dispatcher runs the tool; next call's `input` array contains the prior `function_call` + a `function_call_output` item.
- Malformed `arguments` JSON → tool result is `is_error: true` with `__parse_error__`-flavored content.
- `toolChoice: "any"` maps to `tool_choice: "required"`.
- Iteration cap → `transient`.

**Helpers:** `parseToolCalls`, `extractFinalText`, `extractReasoning`, `buildToolResultItems`, `addAdditionalPropertiesFalse` directly unit-tested.

### 3.3 OpenAI: stop reading SDK private internals

Once the tests are in place, refactor `OpenAILlmClient` to take `baseUrl`, `apiKey`, and `apiVersion?: string` as explicit constructor parameters. The bootstrap code already has these values from the env config — pass them in. Drop the four `(openai as any)._options...` reads. Tests written in 3.2 should not need changes (the stubbed fetch doesn't care).

**Wave 3 exit:** both clients have unit tests covering the surface area of waves 1–4. Future provider-API drift fails CI fast.

---

## 4. Wave 4 — Redis durability

Three issues, each independently dangerous.

### 4.1 `RedisCheckpointer.saveNode` atomic HSET + EXPIRE

The current sequence (`HSET nodes`, `EXPIRE nodes`, `EXPIRE meta`) is non-atomic. Replace with a Lua script:

```lua
-- KEYS[1] = nodes hash key
-- KEYS[2] = meta key
-- ARGV[1] = node id
-- ARGV[2] = serialized node value
-- ARGV[3] = TTL seconds
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], ARGV[3])
redis.call("EXPIRE", KEYS[2], ARGV[3])
return 1
```

Use `redis.eval(script, 2, nodesKey, metaKey, nodeId, payload, TTL)`. Cache the script SHA via `redis.script("LOAD", ...)` once at construction; use `EVALSHA` thereafter.

Test: kill the redis client between commands in a fault-injection style (or just verify with `MULTI`/`pipeline` that the three commands are sent atomically — Lua is atomic by definition).

### 4.2 `runStateMachine` — idempotent event append OR re-ordered persistence

Today: `appendEvent → updateData`. Crash between produces a duplicate event on retry. Two fixes:

- **Option A (preferred):** make `appendEvent` idempotent via a stable entry key. The event envelope already has `recordedAtMs` + the event payload — derive a deterministic key from `(jobId, currentStateHash, attemptNumber, eventTypeTag)`. Use Redis Streams `XADD` with `NOMKSTREAM` + a uniqueness check, or write a small Lua wrapper that `XADD`s only if the latest entry's deterministic key differs.
- **Option B:** flip to `updateData → appendEvent`. Crash between leaves the event missing on the next run; replay is incomplete but the state advances. This is semantically worse (event log is the audit source of truth).

Take A. The deterministic-key approach is more work but preserves the event log's "every transition has exactly one event" invariant. If A turns out to be too involved, ship B with a documented caveat in the runner's docstring and an ADR amendment.

### 4.3 `QueueBackend.close()` + `redis.quit()`

Add `close(): Promise<void>` to the `QueueBackend` interface. Implement in:
- `createBullMQBackend` — close all queues/workers, then `await redis.quit()` on the shared client.
- `createInMemoryBackend` — no-op, but implement for shape parity.

Update the bootstrap in `apps/customer-summary` to call `backend.close()` on `SIGTERM`/`SIGINT`.

Test: BullMQ-gated test that a closed backend frees the connection (verify via `redis.status === "end"` or by counting open clients in Redis `CLIENT LIST`).

### 4.4 `RedisCheckpointer` — separate corrupt-checkpoint kind, per-entry deserialize

Add an error variant:
```ts
| { readonly kind: "checkpoint-corrupt"; readonly runId: string; readonly nodeId?: string; readonly message: string }
```

In `load()`:
- Wrap `deserializeMeta(rawMeta)` in its own try/catch → `checkpoint-corrupt`.
- Iterate `hgetall` entries; per-entry try/catch around `deserializeNode`. On corrupt entry, log + skip + continue. Return the partial node map. The DAG re-executes the missing nodes (idempotency-safe by design).

Test: corrupt one HSET entry, assert `load()` returns the rest plus a structured warning.

**Wave 4 exit:** checkpoint TTLs are atomic, event log is duplicate-safe, the BullMQ backend frees connections cleanly, corrupt checkpoints are diagnosable.

---

## 5. Wave 5 — Error semantics + type sharpening

### 5.1 Eval-judge fail-open: surface `skipped`

`failOpenResult` sets `passed: true, score: 1.0` when the judge LLM fails. Operators can't tell "judge passed" from "judge couldn't run." Fix:

- Change `EvalJudgeResult` to `{ score: number | null; passed: boolean; skipped: boolean; reason: string; ... }`. `null` score means "not evaluated."
- `failOpenResult` sets `skipped: true, score: null, passed: true` (preserve the fail-open default).
- Emit a dedicated observer event `eval-judge-skipped` carrying the underlying error so dashboards can alert on it.

This fixes both the hard-cast `score: null as unknown as number` (type-design finding) and the silent-failure-hunter's bypassed quality gate.

### 5.2 `DagDef.nodes: NodeDef<unknown, unknown, unknown>[]`

Change the `any` to `unknown` in `types/dag.ts:11`. `unknown` is invariant, `any` is bivariant — this matters because every downstream `NodeDef<...>` consumer (e.g., `runNode`, `nodeMap`) currently accepts argument-position values that should be incompatible. Fix the resulting compile errors; most will need an explicit `as NodeDef<...>` cast at the actual call site, which is fine and localizes the unsafety.

### 5.3 `deserializeValue` schema validation OR documented unsafe boundary

`queue-bullmq/job.ts:51` casts `deserializeValue(...) as { state: S; context: C }` with no validation. Add `validateData?: (raw: unknown) => Result<{state: S; context: C}, FrameworkError>` to `adaptBullMQJob`'s options. When provided, run it on every read; on failure surface `checkpoint-corrupt`. Default behavior (no validator) keeps current behavior with a JSDoc warning.

### 5.4 `ContextCacheAdapter.set` returns `Promise<Result<void, FrameworkError>>`

Bring the public adapter in line with the internal `Cache` interface. Update all consumers to handle the `Result`.

### 5.5 `transient` already has `nodeId` (from wave 1.4) — confirm

If wave 1.4 added `nodeId` to `transient`, no further work. Otherwise add it here.

### 5.6 `ToolDef.name` validated at construction

Add a smart constructor:
```ts
export const tool = <I, O>(def: Omit<ToolDef<I, O>, "name"> & { name: string }): ToolDef<I, O> => {
  assertValidToolName(def.name);
  return def;
};
```

Migrate `enrich-with-tools.example.ts` and any test fixtures to use the constructor. The runtime check in `ensureToolNames` stays as a defense-in-depth at dispatch.

**Wave 5 exit:** the `FrameworkError` union is internally consistent. Failed evaluations are observable. The cast points where soundness ends are explicit.

---

## 6. Wave 6 — Concurrency + doc fixes

### 6.1 `DagRunMeta` — drop the mutable accumulator

Replace `meta.guardrailFailed = true` / `meta.guardrailWarnings.push(...)` with: each node returns its guardrail outcome from `withNodeSpan`; `runWave` collects the outcomes after `Promise.all` and merges into a fresh immutable `DagRunMeta` per wave. Same for `evalJudgeResults` if the eval-judge call ever runs concurrently with siblings.

### 6.2 Live `AbortSignal` propagation test

`dag-runtime-stateful.test.ts` only tests pre-loaded terminal abort state. Add a test that: starts a long-running DAG (e.g., `await new Promise(r => setTimeout(r, 5000))` inside one node's `run`), aborts the signal mid-execution, asserts the run returns `Err({ kind: "aborted" })` within ~100ms, and the in-flight node sees `ctx.signal.aborted === true`.

### 6.3 Documentation accuracy

- `executor.ts:203-205` — rewrite the comment to match `runWave`'s skip-by-output behavior: `// Re-run the wave; runWave skips nodes whose outputs are already in machineCtx.outputs, so only the failed node (and any other incomplete nodes) re-execute.`
- `library-ux.md:213` — change the claim. `node-failed` is a `DagEvent` consumed by the transition; the durable phase that gets checkpointed is `retrying` or `retrying-hook`. Adjust the surrounding paragraph too.
- `adapter.ts:107` — clarify BullMQ dedup: `// Dedup: BullMQ ignores duplicate jobIds while the original is still in waiting/delayed state. Once the original completes/fails and is removed (per retention), a re-enqueue with the same jobId proceeds.`
- `spans.ts` `withLlmSpan` docstring — drop the unverifiable claim about MLflow rendering. Keep the part about GenAI semconv.

### 6.4 Stale task labels

`git grep -n "Phase 3a\|codex finding\|M2 fix\|Fix 1"` and remove the labels. Keep the explanatory sentences attached to them; only delete the labels themselves.

### 6.5 Anthropic dead `if` block (already in wave 1.3) — confirm landed

**Wave 6 exit:** no race-prone shared state in the executor; live cancellation tested; comments match the code; commit-message references stripped from source.

---

## 7. Wave 7 — Architecture cleanups

The big-ticket items. Each is independently scoped.

### 7.1 `createLlmWithToolsNode` factory

Today `sendWithTools` is only usable via hand-rolled nodes (the `enrich-with-tools.example.ts` shows the boilerplate). Add a factory mirroring `createLlmNode`:

```ts
export interface LlmWithToolsNodeConfig<I, O> {
  readonly id: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly model: string;
  readonly system?: string;          // also resolves §7.3 below
  readonly systemPromptName?: string;
  readonly userPromptName?: string;  // required if no buildUser
  readonly buildUser?: (input: I) => string;
  readonly tools: readonly ToolDef<any, any>[];
  readonly maxIterations?: number;
  readonly toolChoice?: "auto" | "any" | "none";
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  readonly skipWhen?: (input: I) => boolean;
  readonly skipDefault?: O;
}
```

The factory:
- Reads system + user prompts from the registry (or uses the inline `system`/`buildUser`).
- Calls `ctx.llm.sendWithTools(...)` passing `nodeId: config.id` (locks down the wave-1.4 fix).
- Runs the same FR-021 validation-retry loop as `createLlmNode`, but with a config dial to disable it (and document the multiplier with DAG-level retries).
- Caches via `ctx.cache` keyed on `(promptHash, modelName, inputHash, toolNamesHash)`.
- Wraps in `withNodeSpan` with `enrichLlmSpan` + the new GenAI-semconv attributes.

Migrate `enrich-with-tools.example.ts` to use the factory. Add a unit test that exercises the cache hit path.

### 7.2 `LLM_TRACE_PROMPTS` via `NodeContext.includeContent`

Add `readonly includeContent?: boolean` to `NodeContext`. The bootstrap reads `config.LLM_TRACE_PROMPTS` and sets it on every spawned context. Replace the three `process.env.LLM_TRACE_PROMPTS` reads in `node-span.ts`, `span-enrich.ts`, `eval-judges.ts` with `ctx.includeContent ?? false`.

Tests: existing tests that mutate `process.env.LLM_TRACE_PROMPTS` switch to passing `includeContent` on the test context.

### 7.3 `LlmNodeConfig.system` override

Add `readonly system?: string` to `LlmNodeConfig`. When provided, use it instead of the generic stub. Migrate `apps/customer-summary/prompts/synthesis.txt` to extract its persona prelude into a separate system prompt; update the synthesize node to pass it.

### 7.4 Remove `Machine.maxRetries` from the kernel interface

`state-machine/types.ts:10`. Remove the field. Update `compileDagToMachine` to drop the `maxRetries: {}` assignment. Verify no consumer reads it (the review found none).

### 7.5 Boundary import rule for `@opentelemetry`

In `packages/framework/src/scripts/check-imports.ts`, add a rule:
```ts
{
  scope: ["state-machine/", "dag-runtime/transition.ts", "dag-runtime/transition-helpers.ts", "dag-runtime/machine.ts"],
  forbidden: ["@opentelemetry/"],
  reason: "Pure-core modules must not depend on OTel; tracing belongs to the imperative shell.",
}
```

The shell files (`run-dag-stateful.ts`, `executor.ts`, `eval-judges.ts`) are explicitly excluded. The boundary test covers this.

### 7.6 Break the `types/node.ts` ↔ `llm/client.ts` cycle

Currently `types/node.ts` imports `LlmClient` and `llm/client.ts` imports `NodeContext`. Two options:

- **Option A:** `LlmClient.sendWithTools` takes `tracer` + `signal` directly instead of `ctx: NodeContext`. The only fields used from `ctx` are `tracer` and `signal`. This breaks the cycle cleanly.
- **Option B:** extract a minimal `LlmClientLike` interface into `types/`; the full `LlmClient` extends it in `llm/`.

Take A. It also makes `sendWithTools` more honest about what it actually depends on.

### 7.7 Wave 7 NOT in scope

The architecture review listed two things this plan defers — see §10.

**Wave 7 exit:** consumer ergonomics fixed (factory exists, prompts overridable, env vars threaded through context). Pure-core boundary enforced by CI. Layering cycle broken.

---

## 8. Wave 8 — Final polish

After waves 1–7 land, run `code-simplifier` on the diff and address its findings. Specifically:

- Drop the section-divider comments around single-line `ts-pattern` arms in `executor.ts`.
- Spread/rebuild repeated `ReadonlyMap` constructions where a pre-built `nodeId → waveIndex` map saves work (also fixes the O(N²) reroute clearing — `transition-helpers.ts:421-434`).
- Verify the `transient` and `aborted` error variants are referenced consistently across the codebase post-wave-1.

No new tests; this is a cleanup-only pass.

---

## 9. Tests

Each wave ships with its own tests inline (described above). Aggregate test additions:

- `mlflow-otlp-exporter.test.ts` (wave 2)
- `tail-sampling-processor.test.ts` extensions for forceFlush + eviction throttle (wave 2)
- `anthropic-client.test.ts` (wave 3, ~25 cases)
- `openai-client.test.ts` (wave 3, ~25 cases)
- Redis-gated `redis-checkpointer.test.ts` extension for atomic Lua, corrupt-entry per-row resilience (wave 4)
- Redis-gated test for `QueueBackend.close()` (wave 4)
- Live abort-signal propagation test in `dag-runtime-stateful.test.ts` (wave 6)
- `createLlmWithToolsNode` cache-hit test (wave 7)

Provider integration tests against real `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are deliberately deferred — they belong to the original tool-call plan's PR 2/3 and can land post-merge.

---

## 10. Deferred / out of scope

The review surfaced findings whose fix is genuinely large or whose value is uncertain. These are explicitly **not** in this remediation plan; they're tracked here so reviewers can argue for moving them up.

| Finding | Why deferred |
|---------|--------------|
| Branded types for `runId` / `dagId` / `nodeId` | Cross-cutting refactor touching ~150 sites. Real value but better as its own focused PR with a single ADR, not bundled with remediation. |
| `stateProgress` returns 100 for both `succeeded` and `failed` | Cosmetic for any UI; consumers can read `state.kind` directly. Fix during the next observability iteration. |
| `WorkerHandle.onFailed: err: unknown` vs `onError: err: Error` | Asymmetry is annoying but not incorrect — `onFailed` is the BullMQ contract, `onError` is ours. Not worth a breaking change here. |
| `GuardrailResult.value: T` typed where it can be `undefined` in failure | Discriminated union refactor. Tracked as part of guardrail v2. |
| `replayEvents` overload's `entry as E` cast | The `isRecordedEvent` guard is correct in practice; tightening the type requires a symbol-tagged envelope. Worth doing but not urgent. |
| Two durability mechanisms (legacy `RedisCheckpointer` per-node vs state-machine `job.updateData`) | ADR 0007 calls the legacy path "legacy" but the canonical example app uses it. This needs a real architectural conversation — sunset date for legacy, or rename it to "fast path." Out of scope for remediation. |
| In-memory queue resume divergence from BullMQ | Real bug. Tracked as a separate task. The in-memory backend is a test-only surface today, so the divergence doesn't ship to prod. |
| Eval-judge fail-open policy itself | Wave 5 surfaces the skipped flag; whether fail-open is the right default at all is a product question. |
| BullMQ `jobId` dedup test against real Redis | Adds a Redis-gated test mirroring the in-memory one. Easy add but not gating merge. Schedule for a follow-up. |
| Concurrent sibling failure race in `runWave` | The current behavior is safe (Promise.all returns the first rejection; subsequent failures get logged but don't double-transition because `node-failed` is event-driven and the transition is single-threaded). Adding a test costs less than fixing — schedule for a follow-up wave. |
| `serializeValue` cycle detection | Defensive — circular refs in production state are a bug we'd rather see crash loudly than silently truncate. Add a `Set<object>` visited check only if we hit it in practice. |
| `LlmRequest.thinking` for Anthropic | Documented as ignored in wave 1.3. Real implementation needs a streaming Anthropic path, which is its own plan. |
| `HumanAction.approve-with-edit.newOutput` validation | The reviewer's `outputSchema` is the right validator but plumbing it through requires the transition function to know about per-node schemas. Sufficient for v1 to document the trust boundary. |

---

## 11. Rollout

| Wave | Estimated effort | Exit criteria |
|------|------------------|---------------|
| 1 | 0.5 day | All five quick fixes landed, `bun test` green |
| 2 | 1 day | TailSampling + MlflowOtlpExporter tested; data-loss paths closed |
| 3 | 1 day | Anthropic + OpenAI clients have ≥25 unit tests each |
| 4 | 1.5 days | Redis durability work tested under fault injection |
| 5 | 1 day | Error union internally consistent; type sharpening compiles |
| 6 | 0.5 day | Concurrency + doc accuracy fixes |
| 7 | 1.5 days | Factory + config plumbing + cycle break |
| 8 | 0.5 day | code-simplifier polish |

Total: ~7.5 days for one engineer. Waves 1, 2, 3 are independently shippable in parallel if multiple engineers are available.

---

## 12. Risks

- **Wave 4 idempotent-event-append (4.2)** is the highest-risk item. If the deterministic key derivation turns out to be hard to get right (e.g., needs more state than the runner exposes), fall back to flipping the order to `updateData → appendEvent` and document the audit-log gap. Don't block the wave on perfection.
- **Wave 7 createLlmWithToolsNode (7.1)** introduces a new public API surface. Get the shape right — review with another set of eyes before merging. Once shipped, every new tool-using node will use it, and changing the shape is a breaking change.
- **Wave 5 ContextCacheAdapter.set return type change (5.4)** is a breaking change for any external caller. Search for usages first; if the only caller is the framework itself, the change is internal and safe.
- The token-namespace dual-read in wave 1.5 is intentional churn. Pick a single namespace for v2 and remove the dual-read once `gen_ai.usage.*` is established as the canonical one.
