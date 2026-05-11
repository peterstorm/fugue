# ADR 0023: OTel GenAI semantic conventions as the source of truth for LLM telemetry

**Status:** Accepted
**Date:** 2026-05-11
**Related:** ADR 0012 (tool-call surface), supersedes namespace decisions in `docs/plans/2026-05-06-decouple-mlflow-instrumentation.md`.

## Context

Two prior decisions accreted into a parallel-namespace problem:

1. The **MLflow-decoupling plan** (2026-05-06) established the principle "the framework speaks generic semantic conventions; the exporter speaks vendor." It chose a framework-owned `ai.*` namespace as the source of truth and built the MLflow exporter as the vendor translator. Five attributes carried the LLM call: `ai.llm.model`, `ai.llm.provider`, `ai.llm.tokens_in`, `ai.llm.tokens_out`, `ai.llm.cost_usd`.

2. The **tool-call surface plan** (2026-05-10, ADR 0012) then layered the OTel GenAI semantic conventions on top, explicitly as "belt-and-suspenders" — `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.{input,output}_tokens` were emitted alongside the `ai.llm.*` versions of the same fields. Reason: MLflow's typed-span UI keys off the `gen_ai.*` names, and so does every other GenAI-aware backend (Phoenix, Langfuse, Honeycomb, Tempo).

The result was a dual-emit problem: every LLM span carried two copies of the same data. The exporter read `gen_ai.*` preferentially with `ai.llm.*` as fallback (see the `??` chains in `mlflow-otlp-exporter.ts`). Consumers couldn't tell which name was canonical. There was no formal "translator map" — translation was hard-coded imperative code inside the exporter.

Additional gaps the audit surfaced:

- Three custom `gen_ai.tool.*` attributes (`gen_ai.tool.input`, `gen_ai.tool.output`, `gen_ai.tool.is_error`) sat in the GenAI namespace without being in the spec. The OTel spec actually defines `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` for the first two, and uses the standard `error.type` attribute for the third.
- Standard GenAI request/response attributes were never emitted: `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.request.max_tokens`.
- Prompt and reasoning content rode on framework-custom events (`ai.llm.request`, `ai.llm.thinking`) rather than the spec's `gen_ai.{system,user,assistant}.message` family.

## Options Considered

1. **Keep `ai.*` as source of truth; emit `gen_ai.*` only at the MLflow exporter boundary.**
   - Pros: preserves the original decoupling intent.
   - Cons: every GenAI-aware backend (Phoenix, Langfuse, Honeycomb) needs its own translator. The `ai.*` intermediate adds friction with no payoff — it's not a recognized standard anywhere outside this repo. The MLflow exporter already speaks `gen_ai.*` correctly; routing through `ai.*` first is pure indirection.

2. **Keep both namespaces (the status quo).**
   - Pros: nothing breaks for existing consumers.
   - Cons: wasted span bytes on every call, two places to update when adding attributes, drift risk between the two emission sites, and confusion about which name is authoritative.

3. **Make `gen_ai.*` the source of truth. Keep `ai.*` only for things the GenAI spec does not cover (cost, DAG/run/node identity, guardrail outcomes, thinking-presence boolean). MLflow exporter translates `gen_ai.* → mlflow.*` via declarative tables.**
   - Pros: aligns with industry standard; any GenAI-aware backend works out of the box; clear ownership of each attribute; the MLflow exporter remains a thin vendor translator.
   - Cons: requires migrating attribute names across the framework and updating tests. Backend-portability claim depends on the spec staying stable (the GenAI semconv is still incubating, but the core attributes are stable and widely adopted).

## Decision

**Take option 3.** OTel GenAI semantic conventions (`gen_ai.*`) are the framework's source of truth for everything the spec covers. The framework-owned `ai.*` namespace survives only for things the spec genuinely does not address.

### Namespace split

| Source of truth | Attribute / event |
| --- | --- |
| `gen_ai.*` (OTel GenAI) | `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.request.{temperature,top_p,max_tokens}`, `gen_ai.response.{model,id,finish_reasons}`, `gen_ai.usage.{input,output}_tokens`, `gen_ai.tool.{name,call.id,type,call.arguments,call.result}`, `error.type` on tool spans, events `gen_ai.{system,user,assistant}.message` |
| `ai.*` (framework-owned) | `ai.llm.cost_usd`, `ai.llm.has_thinking`, `ai.guardrail.passed`, `ai.node.{id,kind}`, `ai.span.type`, `ai.dag.id`, `ai.run.id`, event `ai.llm.cost`, events `ai.node.{input,output}` |

The constants live in `packages/framework/src/tracing/semantic-conventions.ts` — both the OTel names (re-exported as `GEN_AI_*` constants for grep-ability) and the framework-owned names.

### MLflow translator (declarative)

The MLflow exporter's translation logic lives in two tables in `mlflow-otlp-exporter.ts`:

- `ATTR_MAP` — simple attribute renames (`gen_ai.request.model → mlflow.llm.model`).
- `EVENT_HANDLERS` — events whose payloads need to merge into MLflow's object-valued attributes (`gen_ai.system.message → mlflow.spanInputs.system_prompt`, etc.).

Adding a new vendor adapter (Langfuse, Phoenix) means writing analogous tables, not threading vendor logic through the framework.

### Tool I/O

`setToolIoAttributes` now emits the spec-canonical `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` instead of the previous `gen_ai.tool.input` / `gen_ai.tool.output`. Tool errors set `error.type = "tool_execution_error"` and the span status to `ERROR` — replacing the custom `gen_ai.tool.is_error` boolean that was not in the spec.

### Prompt / reasoning events

`enrichLlmSpan` now emits the OTel GenAI message events:

- `gen_ai.system.message` with body `{ role: "system", content }`
- `gen_ai.user.message` with body `{ role: "user", content }`
- `gen_ai.assistant.message` with body `{ role: "assistant", reasoning_content }` when thinking is present

The PII gate (`includeContent`) is preserved — when off, content fields are replaced with `*_redacted: "true"` and `*_chars: <length>`. The `gen_ai.assistant.message`'s `reasoning_content` body field is framework convention (the OTel spec doesn't yet standardize reasoning capture), but the event name and role follow the spec so any GenAI-aware consumer sees a recognisable event.

### Response attributes

`AnthropicLlmClient.sendWithTools` and `OpenAILlmClient.sendWithTools` now emit `gen_ai.response.model`, `gen_ai.response.id`, and `gen_ai.response.finish_reasons` from the provider response. Anthropic also emits `gen_ai.request.max_tokens` (currently hardcoded at 16384). Per-call configuration of temperature / top_p / max_tokens via the request envelope is future work — the helpers (`setLlmRequestAttributes`) are in place.

## Consequences

**Positive:**

- Every LLM span has exactly one canonical name per attribute. No more dual-emit, no more "which one wins?" question.
- Any GenAI-aware observability backend works out of the box — drop in an `OTLPTraceExporter` pointed at Phoenix/Langfuse/Honeycomb and traces render with proper LLM/tool typing. MLflow is no longer the only first-class backend.
- The MLflow translation logic is one declarative table instead of an imperative switch statement scattered through the exporter. Adding a vendor adapter (Langfuse, Phoenix) is a copy-paste-and-edit operation.
- Standard request/response attributes (`response.id`, `response.model`, `finish_reasons`) make traces useful for debugging in ways they weren't before.
- Tool I/O and error reporting follow the spec, so external tracing tools that highlight tool failures (status: ERROR, error.type set) light up correctly.

**Negative:**

- The framework's old `ai.llm.{model,provider,tokens_in,tokens_out}` constants are gone. Anyone depending on those attribute names in custom dashboards needs to switch to `gen_ai.*`. Nothing in this repo relied on them — only the framework itself emitted and consumed them.
- The framework now leans on the OTel GenAI semconv staying stable. The semconv is still marked "incubating" — but the attributes used here (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`, etc.) are the most stable subset and are emitted by every GenAI-aware OTel instrumentation today.
- The PII-redaction story now sits inside the spec's event family rather than custom events. Operators reviewing PII handling need to know the redaction fields (`content_redacted`, `content_chars`) live as body attributes on `gen_ai.{system,user,assistant}.message` events.

## Non-goals

- Building a generic vendor-translation framework. One adapter (MLflow) is sufficient. Generalize when there's a second.
- Adding a per-call request-parameter API (`temperature`, `top_p`, `max_tokens` on `LlmRequest`). The `setLlmRequestAttributes` helper is in place; expanding the request envelope is a separate API change.
- Cross-provider parity on `finish_reasons`. Anthropic emits `stop_reason` values (`end_turn`, `max_tokens`, `tool_use`, …); OpenAI's Responses API emits status (`completed`, `failed`, `incomplete`). Both flow through `gen_ai.response.finish_reasons[]` as-is.
- Replacing `mlflow.spanType` with a vendor-neutral mechanism. MLflow's typed-span UI keys off this attribute, and the OTel GenAI spec uses span-name patterns (`{operation} {model}`) plus `gen_ai.operation.name` to classify rather than a "span type" attribute. The framework continues to emit both — `mlflow.spanType` for the MLflow UI, the spec pattern for everything else.
