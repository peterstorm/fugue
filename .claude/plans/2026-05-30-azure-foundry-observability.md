# Plan: Azure AI Foundry Observability Backend

**Spec:** `.claude/specs/2026-05-30-azure-foundry-observability/spec.md`
**Created:** 2026-05-30

## Summary

Make the observability backend a selectable, fan-out-capable choice for both traces and
evaluations, with Azure AI Foundry (Application Insights + Foundry portal) alongside the existing
MLflow backend. The framework stays **vendor-neutral** (Approach B: thin exporter factories +
bootstrap composition): a new `CompositeSpanExporter` fans out to N child exporters with strict
fault isolation, `initTracing` widens to accept `SpanExporter | readonly SpanExporter[]`, a new
`createAzureMonitorExporter()` mirrors `createMlflowExporter()`, an `AiFoundryObserver` emits
domain events/metrics to App Insights, and a Foundry-native eval path runs alongside
`mlflow.evaluate()`. All backend knowledge (connection strings, env vars) lives in the app config
layer, never in the framework. MLflow remains the default and is never regressed.

---

## Architectural Decisions

### AD-1: Approach B (thin factories + bootstrap composition)

**Choice:** Keep the framework vendor-neutral. Add a vendor exporter factory
(`createAzureMonitorExporter()`) mirroring `createMlflowExporter()`, a `CompositeSpanExporter`,
and widen `initTracing`. Backend selection (which env var, connection string, which backends are
on) is composed in the **app bootstrap**, not the framework.
**Why:** The repo's current seam is already "framework accepts any `SpanExporter`; the app picks
one" (see `bootstrap.ts` building `createMlflowExporter` then `initTracing`). Approach B extends
that exact seam to a list, preserving the NFR primary axis (SIMPLICITY / vendor-neutral seam). No
new framework concepts, no registry indirection, no config parsing inside the framework.
**Rejected:**
- **A — Backend registry inside the framework** (`registerBackend("foundry", factory)` + framework
  reads config) — pulls vendor identifiers and config-knowledge into the framework, breaking the
  vendor-neutral seam and adding a lookup indirection for a 2-element list. Over-engineered for the
  actual fan-out count.
- **C — Declarative `initTracing({ backends: [...] })`** where `initTracing` interprets a backend
  descriptor union — makes the framework own backend enumeration and per-backend config shape; same
  vendor-coupling problem as A with a thinner disguise.

### AD-2: CompositeSpanExporter fault-isolation policy

**Choice:** `export()` fans out to every child concurrently; each child's `export` is wrapped so a
throw or an error `ExportResult` is caught, logged (rate-limited), and counted per-child — never
rethrown. The composite's aggregate result is **SUCCESS if at least one child succeeded**, and
FAILED **only if every child failed** (with an aggregated error). `shutdown()`/`forceFlush()`
fan out via `Promise.allSettled` and never reject. Per-child failure counters are exposed for
health checks.
**Why:** FR-025/FR-026/SC-007/SC-009 require that a failing or slow backend neither fails the DAG
nor affects sibling backends. The tail-sampler already treats a non-zero export result as a logged
failure (not a run failure), so "SUCCESS unless all fail" keeps a single dead backend from
inflating `exportFailed` while still surfacing total-outage. Returning SUCCESS-if-any matches the
migration story (US3): MLflow keeps working when Foundry is down.
**Rejected:**
- **Fail-fast (any child fails → composite fails)** — violates fault isolation; one flaky backend
  would mark every dual-export as failed and spam `exportFailed`.
- **Always-SUCCESS (swallow total outage)** — hides a complete-outage condition operators must
  alert on; loses the SC-010 volume-accounting signal.

### AD-3: `initTracing` accepts `SpanExporter | readonly SpanExporter[]` (backwards-compatible widening)

**Choice:** Widen `TracingConfig.exporter` to `SpanExporter | readonly SpanExporter[]`. A single
exporter is used as-is (current behavior, byte-for-byte). An array is normalized: length-1 unwraps
to the bare exporter (no Composite wrapper → identical to today), length >= 2 wraps in
`CompositeSpanExporter`. Empty array is rejected at the boundary with a clear error.
**Why:** Every existing call site (`bootstrap.ts` passes a single `MlflowOtlpExporter`) keeps
compiling and behaving identically (FR-003/FR-027/SC-006). The length-1 unwrap guarantees the
exclusive-backend case has zero Composite overhead, so single-MLflow output stays byte-for-byte.
**Rejected:**
- **New `initTracingMulti()` function** — forks the public API and leaves two flush/shutdown
  lifecycles to keep in sync.
- **Require callers to always pass an array** — breaks the existing single-exporter signature
  (would be a breaking change to a shipped API).

### AD-4: Azure/Foundry SDKs as hard dependencies (always installed)

**Choice:** `@azure/monitor-opentelemetry-exporter`, `@azure/identity`, and `applicationinsights`
are hard `dependencies` of the framework/app (always installed, eagerly importable). The Python
`azure-ai-evaluation` is a hard dep of the eval sidecar's `requirements.txt`.
**Why:** Explicit user decision (FR-029), superseding the brainstorm's optional/lazy note. Trade
dependency weight for unconditional, simpler wiring — no lazy `import()` guards, no
"feature-not-installed" runtime branches. Construction of an Azure exporter is still gated by
config (you only build it when a connection string is present), so the dependency being installed
costs install size, not runtime behavior.
**Rejected:**
- **Optional peer deps + lazy `import()`** (the pattern `MlflowOtlpExporter` uses for its inner
  OTLP exporter) — rejected by explicit user choice; adds conditional code paths and a
  not-installed error surface for no benefit given the decision to always ship the deps.

### AD-5: Domain events/metrics via `applicationinsights` SDK (TrackEvent/TrackMetric) vs OTel metrics

**Choice:** `AiFoundryObserver` emits domain events with the `applicationinsights` Node SDK
(`TelemetryClient.trackEvent` for run-summary / route-decided / node-pruned, `trackMetric` for the
pre-aggregated cost/token/latency/cache-hit metrics). It is wrapped in `BufferedObserver` with the
**same `PersistencePolicy` instance** returned on `TracingHandle.policy`.
**Why:** App Insights `customEvents` + `customMetrics` are exactly what the Foundry monitoring view
queries; `trackEvent` carries arbitrary typed properties (run id, dag id, node id, reason, chosen/
pruned targets) and `trackMetric` supports pre-aggregated values with dimensions — a direct fit for
FR-018/019/020 with one SDK and one connection string already used by the trace exporter. OTel
metrics would require standing up a separate `MeterProvider` + periodic metric reader + a second
exporter wiring, more moving parts for the same destination, against the SIMPLICITY axis.
**Rejected:**
- **OTel metrics API (`MeterProvider` + `PeriodicExportingMetricReader` +
  `AzureMonitorMetricExporter`)** — more infrastructure (a second provider lifecycle, aggregation
  temporality config) for the same App Insights destination; the events half (route-decided,
  node-pruned with reason) maps poorly onto metric instruments and would still need `trackEvent`.
- **Emit domain events as additional OTel spans** — conflates the dual-channel design (Observer =
  domain events, OTel = infra telemetry, per `observer/observer.ts` design note) and would be gated
  by span tail-sampling rather than the shared policy instance.

### AD-6: Foundry-native eval path via `azure-ai-evaluation`, selectable at run time

**Choice:** Add a `backend` selector (env `EVAL_BACKEND=mlflow|foundry`, overridable by
`--backend=mlflow|foundry` CLI flag, CLI wins) that branches `run_evaluation()` between the
existing `mlflow.evaluate()` path and a new `run_evaluation_foundry()` using `azure-ai-evaluation`.
Both paths consume the **same** `EvalResult` list / 25 cases and reuse the existing Azure OpenAI
judge credentials. The functional core (`parse_cases`, `build_eval_data`, `compute_aggregate`,
`format_results_table`) is shared; only the scoring call and result-shape adapter differ. A parity
check asserts mean per-scorer delta within +-0.5 (SC-005).
**Why:** FR-013/014/015/016, SC-002/003/005. Branching at the single I/O seam keeps MLflow
byte-for-byte unchanged (FR-016) and reuses all pure logic, so the two backends can't drift on case
selection or aggregation.
**Rejected:**
- **Separate `run_foundry.py` script duplicating the harness** — duplicates case loading,
  `collect_results`, and aggregation; the two would drift and SC-005 parity becomes meaningless.
- **Replace MLflow with Foundry** — out of scope; MLflow stays the default (FR-005).

### AD-7: Backend selection config lives in the app config layer (env), not `fugue.yaml`

**Choice:** Observability backend selection is parsed from **environment variables** in the app's
`config.ts` (zod), mapped to an exporter list by a pure `resolveObservabilityBackends()` function,
and composed in `bootstrap.ts`. `fugue.yaml` is **not** extended — it is per-DAG team/owner/route
metadata (`FugueYamlSchema`), not a process-level observability switch.
**Why:** ADR-0042 puts backend knowledge in the host/app config layer. `fugue.yaml` is loaded
per-DAG by the host's `module-loader`/`dag-factory`; trace/observer wiring is a process-level
bootstrap concern done once in `bootstrap.ts`, so env is the correct, already-used surface
(`MLFLOW_TRACKING_URI`, `TRACE_SAMPLE_RATIO` live there today). Startup zod validation satisfies
FR-006 (invalid/contradictory selection reported clearly).
**Rejected:**
- **`observability.tracing.backends` keys in `fugue.yaml`** — wrong scope (per-DAG file for a
  per-process concern) and would require the framework/host to thread DAG config into the
  process-level tracing pipeline. The brainstorm floated this; rejected after confirming
  `fugue.yaml` is per-DAG only.

---

## File Structure

### Framework — composite exporter + initTracing widening (`@fugue/framework`)

```
packages/framework/src/tracing/composite-exporter.ts          — CompositeSpanExporter implements SpanExporter
packages/framework/src/tracing/composite-exporter.test.ts     — fan-out, fault-isolation, aggregate-result tests
packages/framework/src/tracing/init.ts                        — widen TracingConfig.exporter to SpanExporter | readonly SpanExporter[]; normalize
packages/framework/src/tracing/init.test.ts                   — single vs [1] vs [N] normalization, empty-array rejection
packages/framework/src/tracing/index.ts                       — export CompositeSpanExporter + type
packages/framework/src/index.ts                               — re-export via tracing/index (already wildcard)
```

### Framework — Azure Monitor exporter factory (`@fugue/framework`)

```
packages/framework/src/tracing/azure-monitor-exporter.ts      — createAzureMonitorExporter(); AzureMonitorTraceExporter wrapper + thin translation seam
packages/framework/src/tracing/azure-monitor-exporter.test.ts — config→exporter mapping, pass-through translation, no live Azure
packages/framework/src/tracing/index.ts                       — export createAzureMonitorExporter + config type
```

### Framework — AiFoundryObserver (domain events/metrics) (`@fugue/framework`)

```
packages/framework/src/observer/ai-foundry-observer.ts        — AiFoundryObserver implements Observer (trackEvent/trackMetric)
packages/framework/src/observer/ai-foundry-observer.test.ts   — pure event→payload mapping; injected TelemetryClient port
packages/framework/src/observer/foundry-event-mapping.ts      — PURE: ObserverEvent → AppInsights event/metric payloads
packages/framework/src/observer/foundry-event-mapping.test.ts — exhaustive ts-pattern mapping + property tests
packages/framework/src/observer/index.ts                      — export AiFoundryObserver + mapping types
```

### App config + bootstrap composition (`apps/customer-summary`)

```
apps/customer-summary/src/config.ts                           — add OBSERVABILITY_TRACE_BACKENDS, APPLICATIONINSIGHTS_CONNECTION_STRING, AZURE_AUTH_MODE, EVAL_BACKEND, refinements
apps/customer-summary/src/observability.ts                    — PURE resolveObservabilityBackends(config) → { exporters, observer factory desc }
apps/customer-summary/src/observability.test.ts               — config→exporter-list mapping, default = MLflow only, dual-export, fail-closed validation
apps/customer-summary/src/bootstrap.ts                        — compose exporter list + AiFoundryObserver into initTracing/BufferedObserver
apps/customer-summary/src/bootstrap.test.ts                   — (if present) extend: default path unchanged
```

### Foundry-native eval path (`apps/customer-summary/eval`)

```
apps/customer-summary/eval/run.py                             — add EVAL_BACKEND/--backend selector; branch run_evaluation
apps/customer-summary/eval/foundry_eval.py                    — run_evaluation_foundry() via azure-ai-evaluation; shares pure core
apps/customer-summary/eval/test_foundry_eval.py               — pure adapter + selector tests (no live Azure)
apps/customer-summary/eval/parity.py                          — compute per-scorer mean delta; assert within +-0.5
apps/customer-summary/eval/test_parity.py                     — parity math tests
apps/customer-summary/eval/requirements.txt                   — add azure-ai-evaluation
apps/customer-summary/eval/README.md                          — document backend selection + parity
```

### Docs + ADRs

```
docs/tracing-pipeline.md                                      — add Foundry/composite section (no MLflow regression)
docs/observability-backends.md                                — NEW: selection matrix, auth, fan-out, fault isolation
docs/adr/00XX-azure-foundry-observability-backend.md          — ADR-1 (Approach B)
docs/adr/00XX-composite-exporter-fault-isolation.md           — ADR-2
docs/adr/00XX-foundry-domain-events-appinsights.md            — ADR-5
docs/adr/00XX-foundry-eval-path.md                            — ADR-6
docs/eval-pipeline.md                                         — add Foundry backend + parity section
```

---

## Component Design

### CompositeSpanExporter

**Responsibility:** Fan out `export`/`shutdown`/`forceFlush` to N child `SpanExporter`s with
per-child fault isolation, never failing the composite unless all children fail.
**Files:** `packages/framework/src/tracing/composite-exporter.ts`
**Interface:**

```
class CompositeSpanExporter implements SpanExporter {
  constructor(children: readonly SpanExporter[]); // throws on empty
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void;
  // fans out concurrently; per-child try/catch + result inspection;
  // aggregate: SUCCESS if any child code===0, else FAILED with aggregated error
  forceFlush(): Promise<void>; // Promise.allSettled over children.forceFlush?.()
  shutdown(): Promise<void>;   // Promise.allSettled over children.shutdown?.()
  readonly childFailureCounts: ReadonlyArray<{ index: number; failures: number }>; // health
}
```

**Depends on:** `@opentelemetry/sdk-trace-base` types, `fwLogger`.

### initTracing (widened)

**Responsibility:** Accept one or many exporters; normalize to a single `SpanExporter` for the
tail-sampler without changing single-exporter behavior.
**Files:** `packages/framework/src/tracing/init.ts`
**Interface:**

```
interface TracingConfig {
  readonly exporter: SpanExporter | readonly SpanExporter[];
  readonly policy: PersistencePolicy;
}
// normalize(exporter): single → as-is; [x] → x; [a,b,...] → new CompositeSpanExporter([...]); [] → throw
// TracingHandle unchanged (processor, policy, flush, shutdown)
```

**Depends on:** `CompositeSpanExporter`, `TailSamplingProcessor`.

### createAzureMonitorExporter

**Responsibility:** Build a `SpanExporter` that ships OTel spans to Application Insights (Foundry
reads from there), mirroring `createMlflowExporter`'s factory + thin-translation shape.
**Files:** `packages/framework/src/tracing/azure-monitor-exporter.ts`
**Interface:**

```
interface AzureMonitorExporterConfig {
  readonly connectionString?: string;        // default auth (FR-022)
  readonly credential?: TokenCredential;      // opt-in Entra ID (FR-023)
  readonly createInner?: () => SpanExporter;  // test seam (no live Azure)
}
const createAzureMonitorExporter: (c: AzureMonitorExporterConfig) => SpanExporter;
// Wraps AzureMonitorTraceExporter. Foundry consumes gen_ai.*/ai.* natively, so the
// translation table is EMPTY pass-through (mirrors ATTR_MAP shape) — present only as a
// documented seam; spans flow through unchanged. Honors existing content-filter gating
// (already applied upstream in span-enrich, so the exporter does NOT re-filter).
```

**Depends on:** `@azure/monitor-opentelemetry-exporter`, `@azure/identity` (types), `fwLogger`.

### AiFoundryObserver + foundry-event-mapping

**Responsibility:** Translate framework `ObserverEvent`s into App Insights custom events/metrics.
The mapping is a pure function; the observer is the thin imperative shell that calls a
`TelemetryClient` port.
**Files:** `packages/framework/src/observer/ai-foundry-observer.ts`,
`packages/framework/src/observer/foundry-event-mapping.ts`
**Interface:**

```
// PURE core (no Azure):
type FoundryEmission =
  | { kind: "event"; name: string; properties: Record<string, string>; measurements?: Record<string, number> }
  | { kind: "metric"; name: string; value: number; properties?: Record<string, string> };
function mapEventToFoundry(event: ObserverEvent): readonly FoundryEmission[];
// run-end → run-summary event (duration, status, nodeCount, retryCount, cacheHitCount, totalCost)
//           + pre-aggregated metrics (cost, tokens, run latency) dimensioned by dagId
// route-decided → route-decision event (chosen/pruned targets)
// node-pruned   → node-pruned event (reason)
// node-end      → node latency / cache-hit metrics (dimensioned by nodeId)
// others        → [] (match(...).exhaustive())

// Port (imperative boundary):
interface FoundryTelemetrySink {
  trackEvent(e: { name: string; properties?: Record<string,string>; measurements?: Record<string,number> }): void;
  trackMetric(m: { name: string; value: number; properties?: Record<string,string> }): void;
  flush(): Promise<void>;
}
class AiFoundryObserver implements Observer {
  constructor(sink: FoundryTelemetrySink);
  observe(event: ObserverEvent): void; // maps + forwards; never throws (logs)
}
```

**Depends on:** `foundry-event-mapping` (pure), `types/events`, `ts-pattern`, `fwLogger`. Wrapped by
the app in `BufferedObserver` with the same `PersistencePolicy` instance from `TracingHandle.policy`
so domain-event volume is gated identically to spans (FR-021/SC-010). Run-summary cost/cache fields
that `BufferedObserver.computeRunSummary` doesn't currently carry (totalCost, cacheHitCount) are
sourced from the run-end summary bridge — see Data Flow.

### resolveObservabilityBackends (app, pure)

**Responsibility:** Map validated env config to (a) the ordered exporter list for `initTracing`
and (b) whether/how to construct the `AiFoundryObserver`. Pure and unit-testable without Azure.
**Files:** `apps/customer-summary/src/observability.ts`
**Interface:**

```
type TraceBackend = "mlflow" | "foundry";
interface ResolvedObservability {
  readonly traceBackends: readonly TraceBackend[];      // 1 = exclusive, 2 = dual
  readonly foundryEnabled: boolean;
  readonly auth: { mode: "connection-string"; connectionString: string }
             | { mode: "entra-id" };
}
function resolveObservabilityBackends(config: Config): Result<ResolvedObservability, ObservabilityConfigError>;
// default (no foundry selected) → ["mlflow"]; foundry requires conn string OR entra mode set,
// else fail-closed error (FR-006). bootstrap builds the actual SpanExporter instances from this.
```

**Depends on:** `config.ts` (zod-validated), framework `Result`/`err`/`ok`.

### Foundry eval path (Python)

**Responsibility:** Score the same 25 cases through `azure-ai-evaluation`, record to the Foundry
Evaluations view, selected at run time; parity-check against MLflow.
**Files:** `apps/customer-summary/eval/foundry_eval.py`, `eval/parity.py`, `eval/run.py` (selector)
**Interface:**

```
# run.py: backend = args.backend or env EVAL_BACKEND or "mlflow"; CLI wins
# foundry_eval.run_evaluation_foundry(results, mode) -> AggregateResult  (same shape as MLflow path)
#   - reuses EvalResult/build_eval_data; adapts to azure-ai-evaluation evaluators
#   - reuses AZURE_OPENAI_* judge credentials already in env
# parity.compute_parity(mlflow_means, foundry_means) -> dict[str,float]; assert max abs delta <= 0.5
```

**Depends on:** `azure-ai-evaluation`, existing `scorers.py` pure helpers, shared pure core in
`run.py`.

---

## Data Flow

```
DAG run
  ├─ OTel spans → TailSamplingProcessor (policy gate) ─┐
  │                                                     ├→ CompositeSpanExporter ─┬→ MlflowOtlpExporter → MLflow
  │                                                     │   (1 child = unwrapped) └→ AzureMonitorExporter → App Insights → Foundry Tracing
  └─ ObserverEvents → BufferedObserver (SAME policy) ──→ AiFoundryObserver → FoundryTelemetrySink → App Insights → Foundry monitoring

Eval: cases.json → collect_results → EvalResult[] ─┬→ mlflow.evaluate()        → MLflow Evaluations
                                                    └→ run_evaluation_foundry() → Foundry Evaluations
                                                         └→ parity.compute_parity (|delta| <= 0.5)
```

Key transformations: the **single** `PersistencePolicy` instance gates both spans (tail-sampler)
and domain events (BufferedObserver), so a dropped trace produces no orphan events (SC-010). The
composite unwraps a 1-element list so exclusive-MLflow output is byte-for-byte unchanged (SC-006).
Azure span translation is pass-through (Foundry consumes `gen_ai.*`/`ai.*` natively).

---

## Implementation Phases

### Phase 1: Composite exporter + initTracing widening (no dependencies)

- Implement `CompositeSpanExporter` with concurrent fan-out, per-child fault isolation, aggregate
  "SUCCESS unless all fail" result, and `Promise.allSettled` shutdown/forceFlush.
- Widen `TracingConfig.exporter` to `SpanExporter | readonly SpanExporter[]`; normalize (single
  as-is, `[1]` unwrap, `[N]` composite, `[]` reject); export from tracing barrel.
- **Files:** `composite-exporter.ts` (+test), `init.ts` (+test), `tracing/index.ts`.

### Phase 2: Azure Monitor exporter factory (depends on Phase 1)

- Implement `createAzureMonitorExporter()` wrapping `AzureMonitorTraceExporter`, connection-string
  default + optional `DefaultAzureCredential`, pure pass-through translation seam, `createInner`
  test seam. Add `@azure/monitor-opentelemetry-exporter` + `@azure/identity` as hard deps.
- **Files:** `azure-monitor-exporter.ts` (+test), `tracing/index.ts`, framework `package.json`.

### Phase 3: AiFoundryObserver + app config/bootstrap composition (depends on Phase 1, 2)

- Implement pure `mapEventToFoundry` (exhaustive ts-pattern) and `AiFoundryObserver` over a
  `FoundryTelemetrySink` port (App Insights `applicationinsights` SDK at the shell). Add
  `applicationinsights` as a hard dep.
- Add observability env keys + zod refinements to app `config.ts`; implement pure
  `resolveObservabilityBackends`.
- Wire `bootstrap.ts`: build exporter list from resolution, pass to widened `initTracing`; when
  Foundry enabled, construct `AiFoundryObserver` wrapped in `BufferedObserver` sharing
  `tracing.policy`; replace `NoopObserver` accordingly.
- **Files:** `foundry-event-mapping.ts` (+test), `ai-foundry-observer.ts` (+test),
  `observer/index.ts`, app `config.ts`, `observability.ts` (+test), `bootstrap.ts`,
  framework `package.json`.

### Phase 4: Foundry-native eval path (depends on Phase 1; parallel to 2/3)

- Add `EVAL_BACKEND` env + `--backend` CLI flag (CLI wins) to `run.py`; branch `run_evaluation`.
- Implement `foundry_eval.run_evaluation_foundry()` via `azure-ai-evaluation` reusing shared pure
  core + Azure judge creds; implement `parity.compute_parity` (+-0.5 assertion).
- Add `azure-ai-evaluation` to `requirements.txt`; update eval `README.md`.
- **Files:** `run.py`, `foundry_eval.py` (+test), `parity.py` (+test), `requirements.txt`,
  eval `README.md`.

### Phase 5: ADRs, docs, verification (depends on Phase 1–4)

- Write ADRs (Approach B, composite fault isolation, App Insights domain events, Foundry eval path).
- Update `docs/tracing-pipeline.md`, `docs/eval-pipeline.md`; add `docs/observability-backends.md`.
- Full verification sweep (build, framework/host/app test suites, MLflow byte-for-byte default).
- **Files:** `docs/adr/00XX-*.md` (4), `docs/tracing-pipeline.md`, `docs/eval-pipeline.md`,
  `docs/observability-backends.md`.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| `CompositeSpanExporter` | fan-out to N fakes; one child throws → others still export, composite SUCCESS; all children fail → composite FAILED+aggregated error; shutdown/forceFlush never reject; per-child counters | none (pure over fake `SpanExporter`s) | fast-check: for any subset of failing children, result is SUCCESS iff >=1 succeeds; every child's `export` invoked exactly once |
| `initTracing` normalization | single→as-is, `[1]`→unwrapped (no Composite), `[N]`→Composite, `[]`→throws; handle lifecycle intact | none | none |
| `createAzureMonitorExporter` | config→exporter via `createInner` fake; conn-string vs credential branch; pass-through translation leaves attrs untouched; no network in tests | optional manual: live App Insights smoke (SC-001, out of CI) | none |
| `mapEventToFoundry` (pure) | run-end→summary event w/ duration/status/nodeCount/retryCount/cacheHit/cost; route-decided→event w/ chosen+pruned; node-pruned→event w/ reason; node-end→latency/cache metrics; unrelated events→`[]`; exhaustive over `ObserverEvent` | none | fast-check: total emissions never throw for any event; numeric measurements finite |
| `AiFoundryObserver` | observe forwards mapped emissions to fake sink; sink throw is swallowed+logged (never propagates) | none (sink is a port) | none |
| `resolveObservabilityBackends` (pure) | default→`["mlflow"]`; foundry+conn-string→dual; foundry w/o auth→fail-closed err; entra mode→entra auth | none | none |
| `run.py` selector + `foundry_eval` | backend default mlflow; `--backend` overrides env; `EVAL_BACKEND` honored; foundry adapter maps `EvalResult`→evaluators w/ fake client | optional manual: live Foundry run (SC-002, out of CI) | none |
| `parity.compute_parity` | per-scorer delta math; pass at delta<=0.5, fail at >0.5; missing scorer handling | none | fast-check: parity symmetric, |delta| within tolerance check correct |

**Non-regression (SC-006, gating):** with no Foundry env set, run the full framework + host +
customer-summary suites — all must pass unchanged, and exclusive-MLflow export output must be
byte-for-byte equivalent (the `[1]`-unwrap path guarantees no Composite wrapper in the default).

---

## Security & NFR Notes

- **Security / trust boundary:** App Insights connection string and `DefaultAzureCredential` are
  secrets — they live in env (app config layer), never in framework code or `fugue.yaml`, never
  logged. The existing content-filter / PII gating (`LLM_TRACE_PROMPTS` → `piiScrubber`) already
  runs upstream of export; the Azure exporter does NOT re-filter and MUST NOT bypass it.
- **Performance (SC-004):** Export stays off the DAG critical path — spans flush via the existing
  post-run tail-sampler; domain events buffer in `BufferedObserver`; the Azure exporter and
  `TelemetryClient` are async/batched. `CompositeSpanExporter` fans out concurrently so a slow child
  cannot serialize-delay siblings. No measurable p50/p95 run-completion increase.
- **Fault isolation (SC-007/SC-009):** Per-child isolation in the composite + swallow-and-log in
  `AiFoundryObserver` guarantee a failing/hung backend neither fails nor delays runs and never
  affects the sibling backend.

---

## Verification

1. `pnpm -r build` (or repo build) compiles with widened `initTracing` and new exporter/observer.
2. `pnpm -r test` (framework + host + customer-summary) — all pass; new unit tests green; default
   (no Foundry env) suites unchanged (SC-006).
3. Exclusive-MLflow export byte-for-byte check: existing MLflow exporter tests unchanged; confirm
   `[1]`-unwrap produces no Composite wrapper.
4. `cd apps/customer-summary/eval && python -m pytest` — selector + foundry adapter + parity tests
   green.
5. Manual (out of CI, real Azure): SC-001 spans visible in Foundry Tracing with gen_ai + cost +
   node identity; SC-002 evals visible in Foundry Evaluations; SC-005 parity within +-0.5;
   SC-007 kill one backend mid-run → other still receives, run succeeds.
