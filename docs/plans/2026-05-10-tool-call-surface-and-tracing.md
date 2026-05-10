---

# Plan: Tool-Call Surface for `LlmClient` + Automatic GenAI Tracing

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Give framework users a single, provider-agnostic API to declare tools and let an LLM node invoke them, with the full `LLM → TOOL → LLM → TOOL → …` trace tree appearing automatically in MLflow (via OTel GenAI semantic conventions). No raw Anthropic / OpenAI SDK code in user-land; no per-tool tracing boilerplate.

**Touches:**
- `packages/framework/src/llm/client.ts` (interface) — add `sendWithTools`
- `packages/framework/src/llm/tools.ts` *(new)* — `ToolDef<I, O>` + helpers
- `packages/framework/src/llm/spans.ts` *(new)* — `withToolSpan`, `withLlmSpan` (GenAI semconv)
- `packages/framework/src/llm/anthropic-client.ts` — implement `sendWithTools`
- `packages/framework/src/llm/openai-client.ts` — implement `sendWithTools`
- `packages/framework/src/llm/fake-client.ts` — implement `sendWithTools` (scriptable for tests)
- `packages/framework/src/llm/index.ts` — export new types/helpers
- `packages/framework/src/__tests__/llm-tool-call.test.ts` *(new)*
- `docs/library-ux.md` (new §7 "Tool calls in LLM nodes") + apps/customer-summary example
- `docs/adr/0009-tool-call-surface.md` *(new)*

---

## Problem

Today's `LlmClient` interface exposes one method:

```ts
sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
```

…which forces a single hidden tool (`structured_output`) and parses the result against a Zod schema. There is **no surface for declaring user-defined tools** that the model can call mid-completion. Any framework consumer who wants tools (CRM lookup, calculator, web search, etc.) has to:

1. Drop down to the raw `@anthropic-ai/sdk` or `openai` SDK.
2. Write the tool-use loop themselves (`while stop_reason === "tool_use" …`).
3. Translate between Zod schemas and provider-specific tool shapes (Anthropic's `input_schema`, OpenAI's JSON Schema in `parameters`).
4. Wire OTel spans manually for each LLM call and each tool dispatch — because if they don't, the MLflow trace shows one giant LLM span with no tool subdivision.
5. Repeat all of the above the moment they want to swap providers.

That's an unreasonable amount of boilerplate for a feature that is squarely the framework's responsibility. It also leads to inconsistent tracing — every consumer picks slightly different span names and attributes, and MLflow's `SpanType.TOOL` rendering only works when the GenAI semantic conventions (`gen_ai.operation.name = "execute_tool"` etc.) are followed exactly.

The framework already exports OTel via the OTLP→MLflow exporter, so the substrate is in place. What's missing is the typed tool-dispatch loop and the convention-correct span emission.

---

## Non-Goals

- **Streaming tool calls.** v1 returns `Promise<Result<…>>`; no `streamWithTools` yet.
- **Adopting the Anthropic Agent SDK or Vercel AI SDK as the canonical client.** They remain options for a future *additional* `LlmClient` implementation (a thin `VercelAiLlmClient` is a possible follow-up), but v1 builds the loop on the raw provider SDKs we already depend on. Adopting a higher-level SDK now would force every consumer onto its tool-definition idiom; we prefer the framework to own the canonical `ToolDef` shape.
- **Computer-use / browser-use / file-tool variants.** Anthropic exposes specialized tool types (`computer_20241022`, `text_editor_20241022`, `bash_20241022`); v1 supports `function`-type tools only. The plan leaves room to add these later via a discriminated union on `ToolDef`.
- **Cross-provider tool-call shape parity.** OpenAI returns tool args as JSON strings; Anthropic returns them as objects. The framework normalizes inside the loop; user-defined tools see typed Zod-validated input regardless of provider. We do **not** try to make the *raw* provider responses identical — that's the SDK's job.
- **Replacing `sendStructured`.** Both methods coexist. `sendStructured` is the right answer for "I want structured output, no external tools." `sendWithTools` is for "I want the model to call tools and ultimately return structured output."
- **Auto-instrumentation via SDK monkey-patching.** No `mlflow.openai.autolog()`-style runtime patching. We instrument inside our own loop, which gives us deterministic span names and attribute coverage.
- **Tool registries shared across LLM calls.** Tools are per-call (passed in `req.tools`). A consumer who wants a global registry can build one in user-land and spread it into each call.

---

## Design

### Provider-agnostic tool definition

A single `ToolDef<I, O>` shape works for both Anthropic and OpenAI:

```ts
// packages/framework/src/llm/tools.ts
export interface ToolDef<I, O> {
  /** Identifier sent to the model. Must match `^[A-Za-z0-9_-]{1,64}$` (Anthropic + OpenAI agree). */
  readonly name: string;
  /** Natural-language description shown to the model. Used by the model to decide when to call. */
  readonly description: string;
  /** Zod schema for the input. Translated to JSON Schema for the provider; Zod-validated on dispatch. */
  readonly inputSchema: z.ZodType<I>;
  /** Zod schema for the output. Validated post-dispatch before being passed back to the model. */
  readonly outputSchema: z.ZodType<O>;
  /**
   * Tool body. Receives Zod-validated input. May be async, may throw — thrown errors are
   * caught by the loop and surfaced back to the model as `is_error: true` results so it
   * can recover or re-plan rather than crashing the run.
   */
  readonly run: (input: I, ctx: NodeContext) => Promise<O>;
}
```

Constraints:
- `name` regex matches both providers' allowed tool-name shapes (`^[A-Za-z0-9_-]{1,64}$`). Validated at registration via `assertValidToolName(name)`.
- `inputSchema` translates to JSON Schema via `z.toJSONSchema(inputSchema)` (same path `sendStructured` already uses).
- `outputSchema` is validated *after* `run` returns; mismatches surface to the model the same way thrown errors do (so the model sees "your tool returned the wrong shape" and can retry or apologize).
- The `ctx: NodeContext` arg gives the tool body access to the same observer / logger / cache the parent node has. This matters because tools often want to memoize via `ctx.cache` for the same idempotency reasons documented in §4 of `library-ux.md`.

### `sendWithTools` on `LlmClient`

```ts
// packages/framework/src/llm/client.ts
export interface SendWithToolsRequest<O> {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly tools: readonly ToolDef<unknown, unknown>[];
  /** Final structured output schema. The loop ends when the model returns a parseable answer. */
  readonly schema: z.ZodType<O>;
  /** Cap on tool-use turns. Default: 10. Exceed → Err(transient). */
  readonly maxIterations?: number;
  /** Anthropic only — extended thinking. Ignored by other providers. */
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  /** Cancellation. Aborted mid-loop returns Err(cancelled). */
  readonly signal?: AbortSignal;
  /**
   * Tool-choice hint. Default: `auto` (model decides). `any` forces a tool call on first turn.
   * `none` disables tools. Provider-specific behavior beyond these three is intentionally not exposed.
   */
  readonly toolChoice?: "auto" | "any" | "none";
}

export interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>;
  sendWithTools<O>(
    req: SendWithToolsRequest<O>,
    ctx: NodeContext,
  ): Promise<Result<LlmResponse<O>, FrameworkError>>;
}
```

Why `ctx` is a separate arg (not folded into `req`):

- `req` is data the *caller* curated (prompts, tools, schema). `ctx` is the *node-runtime* surface (tracer, signal, observer). They have different lifecycles and different audit trails. Keeping them separate matches the existing `node.run(input, ctx)` pattern.
- Tools need `ctx` for `cache.writeCheckpoint`, `logger.warn`, and OTel span context; the loop also needs `ctx.tracer` to root the LLM/tool spans. One arg → one place to look for the OTel context.

### Tool-use loop (provider-agnostic shape)

The loop body is identical across providers; only the request/response translation differs. Pseudo-code:

```ts
async sendWithTools<O>(req, ctx) {
  ensureToolNames(req.tools);
  const messages: ProviderMessage[] = [{ role: "user", content: req.user }];
  let totalTokensIn = 0, totalTokensOut = 0;

  for (let turn = 0; turn < (req.maxIterations ?? 10); turn++) {
    const resp = await withLlmSpan(ctx.tracer, {
      provider: this.providerName,
      model: req.model,
      operation: "chat",
    }, () => this.callProvider({ ...req, messages, toolChoice: req.toolChoice ?? "auto" }));

    totalTokensIn  += resp.usage.input_tokens;
    totalTokensOut += resp.usage.output_tokens;
    messages.push(this.assistantMessageFrom(resp));

    if (!this.hasToolUse(resp)) {
      // Final turn — parse text against req.schema and return.
      return parseFinal(resp, req);
    }

    const calls = this.toolUseBlocks(resp);
    const results = await Promise.all(calls.map(call =>
      withToolSpan(ctx.tracer, {
        toolName: call.name,
        toolCallId: call.id,
      }, () => dispatchOne(call, req.tools, ctx)),
    ));

    messages.push(this.toolResultsMessage(results));
  }

  return err({ kind: "transient", message: `Tool-call iteration limit (${req.maxIterations ?? 10}) reached` });
}
```

Per-tool dispatch:

```ts
async function dispatchOne(call, tools, ctx) {
  const tool = tools.find(t => t.name === call.name);
  if (!tool) return { id: call.id, content: { error: "unknown_tool" }, isError: true };

  try {
    const input = tool.inputSchema.parse(call.input);
    const output = await tool.run(input, ctx);
    const validated = tool.outputSchema.parse(output);
    return { id: call.id, content: validated, isError: false };
  } catch (err) {
    // Surface the failure back to the model rather than aborting the run.
    return {
      id: call.id,
      content: { error: err instanceof Error ? err.message : String(err) },
      isError: true,
    };
  }
}
```

Key invariants:

- **Errors don't abort the loop.** A tool that throws (or returns a Zod-invalid output) becomes a `tool_result` block with `is_error: true`. The model gets to react. This matches both providers' contract for tool errors.
- **Unknown tool name** is also surfaced as `is_error: true` rather than throwing. (The model could hallucinate a tool name; we should let it apologize and pick again.)
- **Iteration cap is hard.** Default 10. Exceed → `Err({ kind: "transient", … })`. Caller's retry policy (per FR-007) decides whether to retry the whole call.
- **Parallel dispatch within one turn** uses `Promise.all`. Both providers can return multiple tool calls per assistant message; that's free parallelism. Dependencies between tool calls are encoded across *turns*, not within one.
- **Signal propagation.** `req.signal` is threaded into both the LLM-call layer (provider SDK accepts an `AbortSignal`) and any tool body that reads `ctx.signal`. The shell of the loop checks `signal.aborted` between turns and short-circuits with `Err({ kind: "cancelled" })`.

### Span emission (GenAI semconv)

Two helpers in `packages/framework/src/llm/spans.ts`:

```ts
export async function withLlmSpan<T>(
  tracer: Tracer,
  meta: { provider: string; model: string; operation: "chat" | "completion" | "embedding" },
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.withSpan(`${meta.operation} ${meta.model}`, "CHAT_MODEL", async () => {
    const span = otelTrace.getActiveSpan();
    span?.setAttributes({
      "gen_ai.operation.name": meta.operation,
      "gen_ai.system":          meta.provider,    // "anthropic" | "openai"
      "gen_ai.request.model":   meta.model,
    });
    const result = await fn();
    // Token usage attributes — populated by callers via span.setAttribute after they get the response.
    return result;
  });
}

export async function withToolSpan<T>(
  tracer: Tracer,
  meta: { toolName: string; toolCallId: string; toolType?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.withSpan(`execute_tool ${meta.toolName}`, "TOOL", async () => {
    const span = otelTrace.getActiveSpan();
    span?.setAttributes({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name":      meta.toolName,
      "gen_ai.tool.call.id":   meta.toolCallId,
      "gen_ai.tool.type":      meta.toolType ?? "function",
    });
    return fn();
  });
}
```

Notes:
- The framework's `Tracer.withSpan(name, spanType, fn)` interface (already in `types/node.ts`) takes a `spanType` string. We map our use cases to MLflow's vocabulary directly: `"CHAT_MODEL"` for LLM calls, `"TOOL"` for tool dispatches.
- Inside the span body we additionally set the `gen_ai.*` attributes via the OTel API, because MLflow's OTLP receiver maps those attributes into its native typed-span rendering. Belt-and-suspenders: the `spanType` string is for MLflow native; the GenAI attributes are for any other OTel consumer.
- `gen_ai.tool.input` and `gen_ai.tool.output` attributes are set by the loop after it sees the values (skipping if they're enormous — over a configurable byte cap they get summarized as `{"truncated": N}`).
- Token usage on the LLM span is set by the caller after the provider response: `span.setAttribute("gen_ai.usage.input_tokens", n)`, etc. This keeps the helper provider-agnostic.

### Provider-specific translation

**Anthropic** (`anthropic-client.ts`):
- Tool spec: `{ name, description, input_schema }` where `input_schema` is JSON Schema from Zod.
- Reading tool calls: filter `response.content` for `type === "tool_use"` blocks; each has `id`, `name`, `input` (already an object).
- Sending results: append a `{ role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] }` message. `content` is a string when the result is text, or a JSON-encoded object.
- `tool_choice`: maps `auto` → `{ type: "auto" }`, `any` → `{ type: "any" }`, `none` → `{ type: "none" }`.

**OpenAI** (`openai-client.ts`):
- Tool spec: `{ type: "function", function: { name, description, parameters } }` where `parameters` is JSON Schema from Zod.
- Reading tool calls: `response.choices[0].message.tool_calls` is an array with `id`, `function.name`, `function.arguments` (a JSON string — `JSON.parse` to object).
- Sending results: append per tool call: `{ role: "tool", tool_call_id, content }` (content is a string).
- `tool_choice`: `auto` → `"auto"`, `any` → `"required"`, `none` → `"none"`.
- Token usage: `response.usage.prompt_tokens` / `completion_tokens` (different field names from Anthropic).

These translations live in private methods on each client (`#toToolSpec`, `#parseToolCalls`, `#buildResultMessage`); the public `sendWithTools` is identical across providers.

### Final-output parsing

When the model returns `stop_reason === "end_turn"` (Anthropic) / `finish_reason === "stop"` (OpenAI), we parse its text against `req.schema`:

- **Anthropic**: scan `response.content` for the last `text` block; `JSON.parse` it; `req.schema.parse(...)`. If the block isn't valid JSON, return `Err({ kind: "node-crash", message: "Final response was not valid JSON for the requested schema" })`.
- **OpenAI**: read `response.choices[0].message.content` (string); `JSON.parse`; `req.schema.parse(...)`.
- For both, we instruct the model in the system prompt to "When you have the final answer, respond with a JSON object matching this schema: <serialized JSON Schema>." This is the same trick `sendStructured` already uses; we factor it into a shared helper `appendSchemaInstruction(systemPrompt, schema)`.
- Alternative considered: force a final `final_answer` tool with the structured schema. Rejected for v1 because it requires an extra "synthetic" tool that confuses the model's tool selection during normal turns. We can revisit this if free-form-text final answers prove unreliable.

---

## Tests

### Unit tests (no network, with `FakeLlmClient`)

`FakeLlmClient` gets a scriptable extension:

```ts
new FakeLlmClient({
  scripts: {
    sendWithTools: (call, turn) => {
      // turn 0: respond with two tool_use blocks
      // turn 1: respond with end_turn + final JSON
      ...
    },
  },
});
```

This lets us assert end-to-end loop behavior without real provider calls:

- **Single-turn (no tools needed).** Model returns `end_turn` immediately with parseable JSON → `Ok(parsed)`.
- **One tool call.** Turn 0 emits `tool_use`; turn 1 emits `end_turn`. Verify the tool's `run` was called once with Zod-validated input; the result was passed back; the final output is parsed.
- **Parallel tool calls in one turn.** Turn 0 emits two `tool_use` blocks; both `run`s called via `Promise.all`; both results in the next request's messages.
- **Tool throws.** Turn 0 emits `tool_use`; the tool's `run` throws; loop continues with `is_error: true` in the result; turn 1 emits `end_turn` with an apology.
- **Tool returns invalid output.** `outputSchema.parse` fails; same recovery path as throw.
- **Unknown tool name.** Model hallucinates a tool the user didn't declare; result is `{ error: "unknown_tool" }`, loop continues.
- **Iteration cap reached.** Script always returns `tool_use`; verify `Err({ kind: "transient", message: /iteration limit/ })` after `maxIterations` turns.
- **Cancellation.** `req.signal` aborted between turns; loop returns `Err({ kind: "cancelled" })`.
- **`toolChoice = "none"`.** Verify the loop never enters tool-dispatch even if the model would have wanted to.

### Property test

For any sequence of `K` tool-use turns followed by a final answer (where `K ≤ maxIterations - 1`) and any well-typed tools, `sendWithTools` terminates in `Ok(...)` with all tool results visible in the conversation transcript and total token usage = sum across all turns.

### Span emission unit tests

Stub `Tracer.withSpan` to record `(name, spanType)` plus the GenAI attributes set inside the body. Assert:

- LLM span named `chat <model>`, `spanType = "CHAT_MODEL"`, with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` set.
- Tool span named `execute_tool <name>`, `spanType = "TOOL"`, with `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type = "function"`.
- Tool spans nest under the LLM span (verified via `getActiveSpan()` parent chain in the stub).

### Provider integration tests (gated on env vars)

`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set → run a single end-to-end test against each provider:
- Tool: `add_numbers({a, b}) → {sum: a+b}`.
- Prompt: "What is 17 + 25? Use the add_numbers tool, then return the result as `{ result: number }`."
- Assert: tool was called exactly once with `{a: 17, b: 25}`; final output is `{ result: 42 }`.

These tests skip cleanly when keys aren't set, mirroring the `redisIt` pattern.

---

## Documentation updates

### `docs/library-ux.md` — new §7 "Tool calls in LLM nodes"

A new top-level section after §6 covering:

1. **The shape of a tool** — `ToolDef<I, O>` with a worked example (CRM lookup).
2. **Calling `sendWithTools` from an LLM node** — full code example showing a node that takes a customer ID, runs an LLM with two tools, returns a structured summary.
3. **What gets traced** — the `LLM → TOOL → LLM → TOOL → LLM` tree as it appears in MLflow, with a screenshot description.
4. **Error policy** — tools that throw or return invalid output don't crash the run; they surface to the model. Iteration cap is the hard stop.
5. **Idempotency** — same advice as §4 ("at-least-once for tools whose result isn't checkpointed"). Tools run inside an LLM node's execution; if the node retries, the tools run again. Use `ctx.cache` for memoization.

### Updated `docs/library-ux.md` §1 — author UX

Add a brief note on `tools` as an option for `llm`-kind nodes pointing to §7.

### Updated `apps/customer-summary` — example consumer

Add a worked tool-using node to the customer-summary app demonstrating real usage. This doubles as the integration test target and as the doc example. Probably an "enrich-with-deals" node that calls a `lookup_deals_by_customer` tool from inside the LLM summarization step rather than fetching deals upfront.

### New `docs/adr/0009-tool-call-surface.md`

ADR documenting:
- **Context**: structured-output-only `LlmClient`; consumers forced into raw SDK + manual OTel.
- **Decision**: `ToolDef<I, O>` + `sendWithTools` on `LlmClient`; loop owned by framework; GenAI semconv spans emitted by `withToolSpan`/`withLlmSpan`.
- **Alternatives considered**: Vercel AI SDK adoption, Anthropic Agent SDK adoption, monkey-patch instrumentation. Rejection rationale per the comparison table in the goal section.
- **Consequences**: framework owns the loop (maintenance), but consumers get a single mental model; provider swap is a one-line change; tracing is automatic.

---

## Rollout order

1. **PR 1: Types + helpers + FakeLlmClient + unit tests.** `ToolDef`, `SendWithToolsRequest`, `withToolSpan`, `withLlmSpan`, `LlmClient.sendWithTools` signature, `FakeLlmClient` scriptable implementation, all unit tests pass against the fake. No provider code yet.
2. **PR 2: AnthropicLlmClient.sendWithTools + provider integration test.** Implement the loop for Anthropic; gate the live integration test on `ANTHROPIC_API_KEY`.
3. **PR 3: OpenAILlmClient.sendWithTools + provider integration test.** Mirror PR 2 for OpenAI.
4. **PR 4: Docs + ADR + customer-summary example.** §7 in `library-ux.md`, ADR 0009, and the worked example in `apps/customer-summary`.

Each PR independently shippable.

---

## Risks and open questions

### Risks

- **`maxIterations` default of 10 may be wrong.** Some flows need 1, some need 30. Library users can override; default is a safety net. If we see frequent `transient` errors from this in practice, raise the default or expose a `maxIterations: number | "unlimited"` variant.
- **OpenAI's `tool_calls.function.arguments` is a JSON string.** Malformed JSON from the model is rare but possible (especially with smaller models). We catch it as `Err({ kind: "node-crash", message: "OpenAI returned malformed tool arguments" })` and let the node-level retry policy kick in. Documented as a known source of `node-crash` errors.
- **Cost amplification.** Every tool turn is a billed LLM call. A buggy tool that never terminates (always returns `is_error: true`, model keeps retrying) can burn through tokens until `maxIterations`. The cap bounds the damage, but consumers should monitor `gen_ai.usage.*` attributes per node and alert on excessive spend.
- **Anthropic's `thinking` mode and tool use have a documented interaction.** Extended thinking with tool use is supported but requires `betas: ["tools-2024-04-04"]` in some SDK versions; need to verify against `^0.91.1` and either gate on a `betas` opt-in or document the constraint.
- **Cancellation mid-tool.** If `req.signal` aborts while a tool's `run` is mid-execution, the loop returns `Err({ kind: "cancelled" })` but the tool itself doesn't see the signal unless the user reads `ctx.signal` inside `run`. We document the contract: tools that do long I/O should honor `ctx.signal`.

### Open questions

- **Tool-call output size truncation.** A tool that returns 5 MB of CRM data inflates the message-history payload on every subsequent turn. Should the loop summarize/truncate tool results above a configurable byte cap before re-sending? v1 ships with no truncation (caller's problem), but we should think about whether to add a `maxToolResultBytes` option.
- **Should `sendStructured` become a thin wrapper over `sendWithTools`?** Conceptually `sendStructured` is "no user tools, force a single synthetic structured-output tool, exit after one turn." We could implement it that way and delete the duplicated structured-output logic. Pro: less code. Con: changes `sendStructured`'s span emission shape (currently 1 LLM span, becomes 1 LLM span + 1 TOOL span for the synthetic structured_output tool). Decision deferred to PR 2/3.
- **A `VercelAiLlmClient` follow-up.** Worth doing as a *third* implementation once the canonical surface stabilizes? It would give consumers who already live in the Vercel ecosystem a familiar surface, and Vercel's `experimental_telemetry` would emit GenAI semconv spans for free. Tracked as a follow-up plan, not in scope for this one.
- **Streaming.** A `streamWithTools` variant is plausible but not in v1 — most production LLM-as-tool-orchestrator flows in this codebase don't need partial output, and streaming complicates the typed-final-answer parsing significantly.
- **Naming.** `sendWithTools` matches the existing `sendStructured` naming pattern. Alternatives considered: `chatWithTools`, `runWithTools`, `invokeWithTools`. `sendWithTools` wins on parity.
