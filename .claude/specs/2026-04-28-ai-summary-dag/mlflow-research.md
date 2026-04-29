# MLflow Observability Research Brief

**Audience:** architect of `packages/framework/` (TypeScript/Bun DAG executor) and `apps/customer-summary/`. We've committed to MLflow as the observability backend, run locally via podman-compose. This brief covers what MLflow specifically gives us as of April 2026.

**TL;DR:** MLflow has a **first-party TypeScript SDK** (`@mlflow/tracing`, v0.2.0) built on OpenTelemetry, with auto-instrumentation for the Anthropic SDK (`@mlflow/anthropic`). This is the path for our framework. **Eval and Prompt Registry are Python-only** — for those we either drive a Python sidecar from the CLI or call MLflow REST endpoints directly. **Claude Agent SDK auto-tracing is Python-only**; in TypeScript we wrap the standard `@anthropic-ai/sdk` client via `tracedAnthropic`. This is a load-bearing decision for the architecture.

---

## 1. MLflow Tracing — TypeScript SDK

- **Package**: `@mlflow/tracing` (renamed from `mlflow-tracing`; current 0.2.0). Built on OpenTelemetry.
- **Init**: `mlflow.init({ trackingUri: "http://localhost:5000", experimentId: "..." })`
- **Manual spans**: `mlflow.withSpan(async () => { ... }, { name, spanType, attributes })` — async callback wrapped in a span. `SpanType.LLM | TOOL | RETRIEVAL | CHAIN | AGENT | UNKNOWN`. Inputs/outputs of the function are auto-captured.
- **Decorator** (TS 5.0+): `@mlflow.trace` on class methods.
- **Nested spans**: nesting just works — child `withSpan` calls inside a parent span attach as children.
- **Trace data model**: traces are root spans; spans carry name, type, inputs, outputs, attributes, status, timing, exceptions. Standard OTel trace structure.

**Auto-instrumentation packages (TS)**:
| Package | Wraps |
|---|---|
| `@mlflow/anthropic` | `@anthropic-ai/sdk` — wrap with `tracedAnthropic(new Anthropic())` |
| `@mlflow/openai` | `openai` SDK |
| `@mlflow/gemini` | Gemini SDK |
| Framework integrations | Vercel AI SDK, LangChain.js, LangGraph.js, Mastra |

**Custom attributes**: pass via the `attributes` field of `withSpan` options. The TS docs we could find don't document a `setAttribute()`-style imperative API as cleanly as the Python side; the path is to set attributes when constructing the span. (For `prompt_version`, `model_version`, `customer_id`, `cache_hit`, this means computing them before opening the span.)

**Maturity**: described as "production-ready," but the SDK is at v0.2.0 — early. Plan for some rough edges on the TS side relative to Python.

## 2. Claude Agent SDK auto-instrumentation — Python-only

- `@mlflow.anthropic.autolog()` is a one-liner that auto-traces `ClaudeSDKClient`, capturing every tool invocation, sub-agent call, and inference step. Requires `claude-agent-sdk >= 0.1.0`, `mlflow >= 3.5.0`.
- **Not available in TypeScript.** Confirmed via the MLflow Oct 2025 blog post and absent from `@mlflow/anthropic` package docs.
- **Architectural implication**: if we use the **Claude Agent SDK** (which gives us session-level concepts, tools, sub-agents) we lose first-party auto-tracing in TypeScript. Two options:
  - **(a) Use the regular `@anthropic-ai/sdk`** with `tracedAnthropic`. Works perfectly. We don't get Agent SDK features (tools, sub-agents) but our v1 doesn't need them — our LLM step is a single synthesis call with structured outputs.
  - **(b) Run the synthesis call as a Python sidecar** invoked from TS. Heavier; gets full auto-tracing. Probably overkill for v1.

**Recommendation**: take option (a). The "Claude Agent SDK" the user named is desirable for future agentic workflows but for v1 (single synthesis call with zod-validated structured output) the regular Anthropic SDK is sufficient and gets us auto-tracing for free. Document the deferral.

## 3. OpenTelemetry bridge — bidirectional

- **MLflow Server exposes `/v1/traces` OTLP endpoint** (added in 3.6.0). Accepts OTLP traces from any language.
- **Export from MLflow to OTel collector**: set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Dual-export mode via `MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT=true` sends to both MLflow and an OTel backend simultaneously.
- **Implication**: even if `@mlflow/tracing` proves rough, we have an escape hatch — emit OTLP from any OTel-instrumented Bun code and MLflow ingests it. Useful as a fallback.

## 4. Prompt Registry

- Git-inspired commit-based versioning. **Immutable versions** (good for our reproducibility requirement). Side-by-side diff in UI. Programmatic API for create/load/list/search.
- `mlflow.set_active_model()` ties prompt versions to traces — lineage queries work end-to-end.
- **Python-only API.** REST endpoints exist (the Python client uses them) but aren't documented as a public TS surface.
- **For us**: either (a) keep prompts as versioned files in `apps/customer-summary/prompts/`, hash them ourselves, attach `prompt_hash` and `prompt_version` as span attributes — gets us 80% of the value without the Python dependency; or (b) call the REST endpoints from TS. (a) is the YAGNI choice.

## 5. Evaluations — `mlflow.genai.evaluate()`

- **Python-only.** No TS equivalent exists.
- Custom scorers via `@scorer` decorator: `def factuality(expectations, outputs): ...`. LLM-as-judge supported (judge model is configurable).
- Datasets are lists of `{inputs, expectations}` dicts. Tracked as MLflow datasets, lineage to eval results preserved.
- Eval results are linked to traces in the UI.
- **CLI**: no first-party `mlflow evaluate` subcommand documented for our shape; you write a Python script and run it. CI gating done in the script (read aggregate score, exit non-zero below threshold).
- **For us**: we have two paths:
  - **(a) Python sidecar** `eval/run-eval.py` invoked by `bun run eval` (Bun shells out). Produces aggregate score + nonzero exit on regression. Simple, leverages all MLflow eval features.
  - **(b) Pure-TS eval** that calls `tracedAnthropic` for both the synthesis under test and the judge, computes scores ourselves, logs results as MLflow runs via REST. More code, fewer dependencies.
  - Recommendation: **(a)**. Python is the right tool here — eval is offline, runs in CI, and we already have podman so adding a Python container is cheap. Keeps the runtime path pure TypeScript.

## 6. Datasets

- MLflow has a Datasets concept that tracks input/expected/produced rows. Eval framework uses it natively. For our 20-fixture eval set, store as JSON in the repo and load both for production fixtures (TS) and for eval (Python). Avoid coupling the dataset definition to MLflow APIs.

## 7. Self-hosting locally (podman-compose)

- **Default backend**: SQLite (`sqlite:///mlflow.db`), zero config. Suitable for v1.
- **Recommended container path**: clone `mlflow/mlflow` and use the included `docker-compose/` (PostgreSQL + RustFS for artifacts). For our local-only single-user case, **SQLite + local filesystem artifact store is enough**.
- **Caveat**: the official `mlflow/mlflow` image is missing `psycopg` so PostgreSQL needs a custom image. Stick with SQLite.
- **Port**: 5000 (UI + REST + OTLP).
- **Podman**: docker-compose YAMLs work with `podman-compose` modulo network and volume edge cases — assume they work, fall back to a hand-rolled `compose.yaml` if not.
- **Minimal compose** (sketch, not final):
  ```yaml
  services:
    mlflow:
      image: ghcr.io/mlflow/mlflow:v3.6.0  # or pinned 3.x
      command: mlflow server --host 0.0.0.0 --port 5000 --backend-store-uri sqlite:////data/mlflow.db --default-artifact-root /data/artifacts
      ports: ["5000:5000"]
      volumes: ["./data/mlflow:/data"]
    redis:
      image: docker.io/library/redis:7-alpine
      ports: ["6379:6379"]
      volumes: ["./data/redis:/data"]
  ```

## 8. Cost / token attribution

- **Auto-captured** for `tracedAnthropic` and `tracedOpenAI` — token counts land on the span automatically.
- **USD cost is NOT auto-computed.** We compute it ourselves from input/output token counts × per-model rate, attach as a custom span attribute (`cost_usd`).
- **Attribute naming**: stick with conventions — `llm.usage.prompt_tokens`, `llm.usage.completion_tokens`, then add `llm.usage.cost_usd` as our extension. Documented searchable in MLflow UI.

## 9. Search / query API

- **REST**: `POST /api/2.0/mlflow/traces/search` with filter strings (`tags.prompt_version = 'v3'`, `attributes."llm.usage.cost_usd" > 0.01`).
- **UI**: same filters, plus saved views. Filters across traces, spans, runs, datasets.
- **For us**: useful for ad hoc debugging ("show me all traces where cache_hit=false in the last hour"). No code we have to write.

## 10. MLflow vs Langfuse — for *this* use case

| | MLflow 3.6+ | Langfuse |
|---|---|---|
| First-party TS SDK | Yes (v0.2.0) | Yes (more mature) |
| OTel-native | Yes (full bidirectional) | Yes |
| Prompt registry | Yes (Python API) | Yes (TS API) |
| LLM-as-judge eval | Yes (Python only) | Yes (TS) |
| Self-host effort (single container) | Trivial (SQLite) | Trivial |
| Anthropic auto-trace TS | Yes (`@mlflow/anthropic`) | Via OTel |
| Single-pane traces+evals+prompts | Yes | Yes |
| Open source | Apache 2.0 | MIT |
| Maturity for our shape | TS SDK is 0.2.0 — early | TS-first, more battle-tested for TS apps |

**Where MLflow shines for us**: the user explicitly chose it; it has stronger ML-experiment lineage than Langfuse (matters if we ever fine-tune); the Python eval framework is more powerful than Langfuse's; the OTLP receiver makes it a future-proof aggregation point.

**Where it falls short for us**: TS SDK is 0.2.0 — fewer features than the Python side (no first-party prompt-registry client, no eval API, fewer auto-instrumentations). The TS API for setting custom span attributes is less ergonomic than Langfuse's.

**Verdict**: stick with MLflow as decided, but architect with two escape hatches — (1) Python sidecar for eval, (2) OTLP fallback if `@mlflow/tracing` proves limiting.

---

## Feature × TS-supported × Good-fit table

| Feature | Works in TS? | Good fit for our use case? |
|---|---|---|
| Tracing — manual spans (`withSpan`) | Yes | Yes — core observer impl |
| Tracing — auto Anthropic SDK | Yes via `@mlflow/anthropic` | Yes — wrap synthesis client |
| Tracing — auto Claude Agent SDK | No — Python only | Use plain `@anthropic-ai/sdk` instead |
| Custom span attributes | Yes via `attributes` option | Yes — for prompt_version, model_version, cache_hit, cost_usd |
| Span type tagging | Yes (`SpanType.LLM/TOOL/...`) | Yes — maps to our `fetch`/`transform`/`llm` node kinds |
| OTLP send | Yes via OTel exporter | Yes — escape hatch |
| OTLP receive (MLflow ingests OTLP) | Yes (server-side) | Yes — useful for non-TS instrumentation |
| Prompt Registry — Python API | No — TS not first-party | Use file-based prompts + hash, attach as span attr |
| Prompt Registry — REST | Possible but undocumented surface | Skip for v1 |
| Eval — `mlflow.genai.evaluate()` | No — Python only | Run via Python sidecar from `bun run eval` |
| Datasets | Python-first; REST | Yes — store fixtures as JSON in repo, dual-loaded |
| Trace search (REST) | Yes | Yes — for debugging dashboards |
| Self-host SQLite | Yes — trivial | Yes — podman-compose with mlflow + redis |
| Token attribution auto | Yes via traced clients | Yes — free |
| USD cost attribution | No — not auto | Compute and attach as `llm.usage.cost_usd` attr |

## Architectural recommendations

1. **Observer interface** in `packages/framework/` matches MLflow span shape: `onNodeStart({ name, kind, inputs, attributes })` / `onNodeEnd({ outputs, status })` / `onNodeError({ error })`. The MLflow observer translates these into `withSpan` calls.
2. **Don't leak MLflow types into the framework core.** The `MLflowObserver` lives in a separate file; the core only knows the abstract `Observer` interface.
3. **`llm` node implementations use `tracedAnthropic`-wrapped client** — auto-tracing piggybacks on our framework spans (nests cleanly).
4. **For v1, use plain `@anthropic-ai/sdk`** wrapped by `@mlflow/anthropic`. Document the Claude Agent SDK deferral. When we need agent features (tools, sub-agents), revisit and consider the Python-sidecar path.
5. **Prompt registry**: roll our own minimal version — prompts in `apps/customer-summary/prompts/<name>.txt`, hash on load, attach `prompt_hash` and `prompt_version` (from a `prompts/registry.json` mapping) to span attributes. Compatible with future migration to MLflow's registry.
6. **Eval**: `bun run eval` shells to `python eval/run.py` inside a podman container. Python script reads fixtures, calls our HTTP API, runs `mlflow.genai.evaluate()` with custom scorers (Haiku as judge), exits nonzero below threshold. CI runs the same command.
7. **Cost attribution**: compute USD post-call from token counts × hardcoded per-model price table; attach `llm.usage.cost_usd`. Price table lives in one file for easy update.
8. **podman-compose**: ship `infra/compose.yaml` with `mlflow` (v3.6+ pinned, SQLite) + `redis`. `bun run infra:up` and `bun run infra:down` wrap `podman-compose`.

---

## Sources

- [MLflow Typescript SDK for Tracing — official docs](https://mlflow.org/docs/latest/genai/tracing/app-instrumentation/typescript-sdk/)
- [MLflow Meets TypeScript — blog](https://mlflow.org/blog/mlflow-typescript)
- [AI Observability for Every TypeScript LLM Stack — blog (Dec 2025)](https://mlflow.org/blog/typescript-enhancement)
- [Tracing Anthropic — TS examples](https://mlflow.org/docs/latest/genai/tracing/integrations/listing/anthropic)
- [Rapidly Prototype and Evaluate Agents with Claude Agent SDK and MLflow — blog (Oct 2025)](https://mlflow.org/blog/mlflow-autolog-claude-agents-sdk/)
- [Full OpenTelemetry Support in MLflow Tracing — blog](https://mlflow.org/blog/opentelemetry-tracing-support)
- [Export MLflow Traces/Metrics via OTLP](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/export/)
- [Collect OpenTelemetry Traces into MLflow](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest/)
- [Prompt Registry](https://mlflow.org/docs/latest/genai/prompt-registry/)
- [Self-Hosting Overview](https://mlflow.org/docs/latest/self-hosting/)
- [MLflow Tracking Server — architecture](https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/)
- [MLflow 3.6 release notes](https://mlflow.github.io/mlflow-website/releases/)
