# ADR 0012: Tool-call surface for `LlmClient` + automatic GenAI tracing

**Status:** Accepted
**Date:** 2026-05-10
**Plan ref:** `docs/plans/2026-05-10-tool-call-surface-and-tracing.md`
**Related:** ADR 0001 (single-package layering).

## Context

`LlmClient` exposed only `sendStructured`, which forced a single hidden tool (`structured_output`) and parsed the result against a Zod schema. There was no surface for declaring user-defined tools that the model could call mid-completion. Any consumer who wanted real tool use (CRM lookup, calculator, search) had to:

1. Drop down to the raw `@anthropic-ai/sdk` or `openai` SDK.
2. Write the tool-use loop themselves (`while stop_reason === "tool_use"`).
3. Translate Zod schemas to provider-specific tool shapes (`input_schema` for Anthropic; `parameters` for OpenAI).
4. Wire OTel spans manually for each LLM call and each tool dispatch — without GenAI semantic conventions, MLflow's `SpanType.TOOL` rendering wouldn't fire.
5. Repeat all of the above to swap providers.

That's an unreasonable amount of boilerplate for a feature that's squarely the framework's responsibility. It also produces inconsistent tracing — every consumer picked slightly different span names and attributes, and MLflow's typed-span rendering only works when the GenAI semantic conventions (`gen_ai.operation.name = "execute_tool"` etc.) are followed exactly.

The framework already exports OTel via the OTLP→MLflow exporter; the substrate was in place. What was missing was the typed tool-dispatch loop and the convention-correct span emission.

## Options Considered

1. **Adopt the Vercel AI SDK as the canonical client.**
   - Pros: free `experimental_telemetry` GenAI semconv spans; large community.
   - Cons: forces every consumer onto Vercel's `tool({...})` idiom; changes our error model (Vercel throws, we use `Result`); new dependency on its abstraction churn.

2. **Adopt the Anthropic Agent SDK as the canonical client.**
   - Pros: handles the loop natively.
   - Cons: Anthropic-specific; would tie the abstraction to one provider's mental model and require an OpenAI escape hatch we'd own anyway.

3. **Auto-instrument via SDK monkey-patching (e.g., `mlflow.openai.autolog()`).**
   - Pros: zero code changes for callers.
   - Cons: opaque — span names and attributes depend on the patcher, not us; brittle across SDK upgrades; no determinism for tests.

4. **Framework-owned `ToolDef<I, O>` + `sendWithTools` on `LlmClient`; loop owned by framework; spans emitted by `withToolSpan`/`withLlmSpan` helpers using GenAI semconv.**
   - Pros: one mental model for consumers; provider swap is a one-line change; tracing is automatic and convention-correct; `Result`-typed error model preserved; tools see Zod-validated input regardless of provider.
   - Cons: framework owns the loop and must keep it correct against provider API drift.

## Decision

**Take option 4.**

Concrete shape (in `packages/framework/src/llm/`):

```ts
export interface ToolDef<I, O> {
  readonly name: string;             // ^[A-Za-z0-9_-]{1,64}$
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly run: (input: I, ctx: NodeContext) => Promise<O>;
}

export interface SendWithToolsRequest<O> {
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly tools: readonly ToolDef<any, any>[];
  readonly schema: z.ZodType<O>;
  readonly maxIterations?: number;          // default 10
  readonly thinking?: { type: "enabled"; budgetTokens: number };
  readonly signal?: AbortSignal;
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

Loop invariants (provider-agnostic — implemented identically in `AnthropicLlmClient`, `OpenAILlmClient`, and `FakeLlmClient`):

- **Errors don't abort the loop.** A tool that throws, returns Zod-invalid output, or doesn't exist becomes a `tool_result` block with `is_error: true`. The model gets a chance to recover.
- **Iteration cap is hard.** Default 10. Exceed → `Err({ kind: "transient", message })`. The retry policy (per ADR 0005) decides whether to retry the whole call.
- **Parallel dispatch within one turn** uses `Promise.all`. Both providers can return multiple tool calls per assistant message; that's free parallelism.
- **Cancellation** via `req.signal` short-circuits between turns with `Err({ kind: "aborted" })`. Long-running tools should also honor `ctx.signal`.

Span emission (in `packages/framework/src/llm/spans.ts`):

```ts
withLlmSpan(tracer, { provider, model, operation: "chat" }, async () => {
  const r = await callProvider(...);
  setLlmUsageAttributes(r.usage.input_tokens, r.usage.output_tokens);
  return r;
});

withToolSpan(tracer, { toolName, toolCallId }, async () => {
  const r = await dispatchToolCall(...);
  setToolIoAttributes(call.input, r.content, r.isError);
  return r;
});
```

Span types and attributes follow OpenTelemetry GenAI semantic conventions:

| Span        | Name                      | Type          | Attributes                                                                                       |
| ----------- | ------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| LLM call    | `chat <model>`            | `CHAT_MODEL`  | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.usage.{input,output}_tokens`, `gen_ai.response.{model,id,finish_reasons}` |
| Tool call   | `execute_tool <name>`     | `TOOL`        | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.tool.call.{arguments,result}`, `error.type` (on failure) |

Tool I/O is JSON-stringified into span attributes; payloads above 8 KiB are summarized as `{"truncated": <byte-count>}` to keep span size bounded. Tool errors set `error.type = "tool_execution_error"` and the span status to `ERROR` (ADR 0023 updates — the original `gen_ai.tool.{input,output,is_error}` names are gone).

## Consequences

**Positive:**

- Consumers get one mental model: declare tools as `ToolDef`, call `sendWithTools`. Provider swap is a one-line change.
- Tracing is automatic and renders correctly in MLflow's typed-span UI without per-consumer wiring. Trace looks like `LLM → TOOL → LLM → TOOL → LLM` out of the box.
- Tools see Zod-validated input and return Zod-validated output regardless of provider. OpenAI's JSON-string `arguments` and Anthropic's pre-parsed `input` are normalized inside the loop.
- The error model stays uniform (`Result<LlmResponse, FrameworkError>`). The `transient` error variant — added in this ADR — surfaces the iteration cap distinctly from `node-crash` so retry policies can react differently.

**Negative:**

- Framework owns the loop. When Anthropic or OpenAI changes their tool-call shape, the loop has to follow. Mitigated by integration tests gated on provider keys.
- The default `maxIterations: 10` may be wrong for some flows (1 for trivial, 30 for agentic). Library users can override per-call.
- Cost amplification risk: a buggy tool that always errors out can burn through tokens until `maxIterations`. The cap bounds the damage; consumers should monitor `gen_ai.usage.*` attributes per node.

## Non-goals

- **Streaming tool calls.** v1 returns `Promise<Result<…>>`; no `streamWithTools` yet.
- **Computer-use / browser-use / file-tool variants.** v1 supports `function`-type tools only. Future ADR may add a discriminated union on `ToolDef` for Anthropic's `computer_20241022` etc.
- **Cross-provider raw-response parity.** The framework normalizes tool inputs and outputs; raw provider responses remain provider-shaped.
- **Replacing `sendStructured`.** Both methods coexist. `sendStructured` remains the right answer when you only want a single structured-output round trip.
- **Tool registries shared across calls.** Tools are per-call (`req.tools`). Consumers can build a global registry and spread it.
