---

# Plan: Production Observability — Signal Taxonomy, Classifiers, Self-Diagnostics

**Created:** 2026-05-08
**Status:** Draft
**Source:** Raindrop talk *"Everything You Need to Know About Agent Observability"* (Zuben & Danny, 2026-05). Vault note: `learning/autonomous-agents-in-production/2026-05-08-raindrop-agent-observability-talk.md`.
**Goal:** Extend the existing MLflow-based tracing pipeline with **production-grade issue detection** — explicit/implicit signal taxonomy, binary classifiers (not 1–10 LLM judges), regex signal aggregation, agent self-diagnostics, and rollout-style production experiments. Treats observability as the primary defect-finding mechanism in production, not offline evals.

---

## Problem

The current framework has solid trace/eval infrastructure (MLflow exporter, OTel spans, eval-judge nodes — see `2025-05-04-eval-judge-node-design.md` and `tracing-pipeline.md`) but it is **eval-paradigm-shaped**: we score outputs offline against datasets, emit numeric judge scores, and rely on a developer to read traces.

The Raindrop talk's core claim: as agents grow combinatorially complex (more tools, longer runs, sub-agents, dynamic memory), eval coverage **cannot keep up** with production input distribution. The signals that actually catch regressions in shipped systems are:

1. **Explicit metrics** — error/latency/cost/regeneration rates, with anomaly detection on both spikes *and* unnatural flatness.
2. **Implicit semantic signals** — regex on user/agent text, binary classifiers, self-diagnostics.
3. **Production experiments** — % rollout with signal-rate diff vs. control.

We have none of (2) and (3), and only partial (1) (we emit metrics but don't aggregate-and-alert). MLflow won't grow into this — it's a tracing/eval store, not an issue-detection platform.

This plan adds the missing layers **on top of** MLflow + OTel, without binding to a vendor (Raindrop, Langfuse, Arize, etc.). All new signals flow through OTel attributes/events on existing spans, plus a new `report` tool path. Downstream consumers (MLflow, BigQuery, StatSig, Slack) are pluggable.

---

## Non-Goals

- Replacing MLflow. MLflow continues to receive traces.
- Building a UI / dashboard. We emit signals; visualization is the consumer's problem.
- Adopting Raindrop or any specific vendor. We replicate the *patterns*, not the product.
- Implementing full statistical-significance experiment infrastructure. We emit per-cohort tags; downstream (StatSig/BigQuery) does the math.
- Custom-classifier training pipelines. v1 uses cheap-LLM-as-classifier on sampled traffic; fine-tuning is a future plan.

---

## Design Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                       Run / Node Execution                          │
│                                                                     │
│   ┌─────────┐     ┌───────────┐     ┌────────────┐    ┌─────────┐  │
│   │ Nodes   │────▶│ Executor  │────▶│ Observers  │───▶│ Tracing │  │
│   └─────────┘     └───────────┘     └────────────┘    └─────────┘  │
│        │                │                  │                        │
│        │ report tool    │ explicit         │ implicit               │
│        ▼                ▼ metrics          ▼ signals                │
│   ┌──────────┐    ┌────────────┐    ┌─────────────────────────┐    │
│   │ Self-    │    │ Counters / │    │ Regex matchers           │    │
│   │ diag     │    │ histograms │    │ Classifier sampler       │    │
│   │ events   │    │ (OTel)     │    │ (binary issue detection) │    │
│   └──────────┘    └────────────┘    └─────────────────────────┘    │
│        │                │                  │                        │
│        └────────────────┼──────────────────┘                        │
│                         ▼                                           │
│                  ┌────────────────┐                                 │
│                  │ Signal Bus     │  cohort-tagged signal events    │
│                  │ (OTel events + │                                 │
│                  │  span attrs)   │                                 │
│                  └────────┬───────┘                                 │
└───────────────────────────┼─────────────────────────────────────────┘
                            ▼
              ┌─────────────┴──────────────┐
              ▼              ▼              ▼
          MLflow         BigQuery /    Slack / webhook
          (traces)       Snowflake     (self-diag, alerts)
                         (analytics,
                          experiments)
```

**Principle:** signals are first-class span attributes/events with framework-defined semantic conventions (mirrors the MLflow-decoupling plan from `2026-05-06-decouple-mlflow-instrumentation.md`). Vendor exporters translate.

---

## Phase 1 — Signal Taxonomy & Semantic Conventions

**Goal:** define the wire format. Nothing functional yet; just the contract.

### 1.1 Add semantic conventions

Extend `packages/framework/src/tracing/semantic-conventions.ts` with a `SIGNAL` namespace:

```ts
export const SIGNAL = {
  // Explicit (objective, cheap)
  TOOL_ERROR: "signal.tool_error",                  // boolean
  LATENCY_MS: "signal.latency_ms",                  // number
  REGENERATION: "signal.regeneration",              // boolean
  COST_USD: "signal.cost_usd",                      // number
  TOKEN_COUNT: "signal.token_count",                // number

  // Implicit — regex
  REGEX_MATCH: "signal.regex.match",                // string[] (matched rule names)
  REGEX_NEGATIVE: "signal.regex.negative",          // boolean (frustration phrases)

  // Implicit — classifier
  CLASSIFIER_ISSUE: "signal.classifier.issue",      // string[] (e.g. ["refusal","frustration"])
  CLASSIFIER_CONFIDENCE: "signal.classifier.confidence", // number
  CLASSIFIER_SAMPLED: "signal.classifier.sampled",  // boolean

  // Self-diagnostics
  REPORT_KIND: "signal.report.kind",                // tool_failure|frustration|capability_gap|self_correction|other
  REPORT_SEVERITY: "signal.report.severity",        // low|medium|high
  REPORT_TEXT: "signal.report.text",                // string (event payload)

  // Experiments
  COHORT: "signal.cohort",                          // string (e.g. "prompt-v2.4")
  COHORT_CONTROL: "signal.cohort.control",          // boolean
} as const;
```

**Why span events for `REPORT_TEXT`:** matches existing pattern from MLflow-decoupling plan — large/structured payloads go to OTel events, primitives to attributes.

### 1.2 Document in `tracing-pipeline.md`

Add a "Signals" section explaining explicit vs implicit, and that signals ride on existing run/node spans (no new span types).

---

## Phase 2 — Explicit Signal Emission

**Goal:** emit objective metrics on every node/run automatically.

### 2.1 Counter / histogram instruments

In `packages/framework/src/observer/`, add `signal-emitter.ts`:

```ts
// OTel Meter-based, sibling to the existing tracer.
export interface SignalEmitter {
  recordToolError(node: string, tool: string, err: Error): void;
  recordLatency(node: string, ms: number): void;
  recordRegeneration(runId: string): void;
  recordCost(node: string, usd: number, tokens: number): void;
}
```

Emits to OTel Meter (histograms + counters); also stamps the span via `span.setAttributes` for per-trace inspection.

### 2.2 Wire into executor

Hook `signal-emitter` into the existing executor at the same points where `span-enrich` runs today (start/end/error of each node). Latency comes from existing span timing — no new measurement needed.

### 2.3 Regeneration detection

A "regeneration" = user-initiated retry of the same input. Two paths:
- **Explicit**: caller passes `regeneratedFrom: runId` into `Executor.run()` — direct flag.
- **Implicit (deferred)**: same `userId + input hash` within N minutes. Punt to v2.

### 2.4 Anomaly detection

**Out of scope here.** We emit raw counters/histograms; downstream (Grafana, MLflow charts, custom alerting) detects spikes *and* unnatural flatness (the talk emphasizes that flat lines ≠ healthy — could mean instrumentation broke).

Document this gap explicitly so users know to wire alerts themselves.

---

## Phase 3 — Regex Signals

**Goal:** Claude-Code-style keyword matchers that flag patterns in user inputs and agent outputs across all runs.

### 3.1 Rule format

`packages/framework/src/signals/regex-rules.ts`:

```ts
export interface RegexRule {
  name: string;                        // "user.frustration"
  pattern: RegExp;                     // /\b(wtf|this sucks|horrible|useless)\b/i
  appliesTo: "user_input" | "agent_output" | "both";
  flag?: "negative" | "positive" | "neutral";
}

export const DEFAULT_RULES: RegexRule[] = [
  { name: "user.frustration", pattern: /\b(wtf|this sucks|horrible|useless|broken|garbage)\b/i, appliesTo: "user_input", flag: "negative" },
  { name: "user.praise",      pattern: /\b(perfect|amazing|exactly right|nice work)\b/i,        appliesTo: "user_input", flag: "positive" },
  // multilingual additions opt-in via user-supplied rules
];
```

**Rationale (from talk):** regex misses individual cases but reveals **trend deltas** at scale. Cheap. The Claude Code leak (`userPromptKeywords.ts`) confirms this is what real teams use.

### 3.2 Matcher node / observer

Two integration points:

**a) Passive observer** — `RegexSignalObserver` implements the `Observer` interface (sibling to `RecordingObserver` in `observer.ts`); inspects `RunStartEvent.input` and `NodeEndEvent.output`, stamps `SIGNAL.REGEX_MATCH` and `SIGNAL.REGEX_NEGATIVE` on the active span.

**b) Explicit node (optional)** — `regexMatchNode({ rules })` for cases where users want regex to gate flow (e.g., reject NSFW input pre-LLM). Different concern from observability; mention in plan but defer implementation.

### 3.3 User extensibility

Users supply their own `RegexRule[]` via `Executor` config. Default rules are illustrative; production use *requires* domain-specific rules.

---

## Phase 4 — Binary Issue Classifiers

**Goal:** small, sampled, binary classifiers (not 1–10 scores). One classifier per issue type.

### 4.1 Classifier interface

```ts
export interface IssueClassifier {
  name: string;                        // "refusal" | "frustration" | "task_failure" | "nsfw" | "jailbreak" | "win"
  classify(input: ClassifierInput): Promise<{ issue: boolean; confidence?: number }>;
}

export interface ClassifierInput {
  userInput: string;
  agentOutput: string;
  toolCalls?: ToolCallSummary[];
  metadata?: Record<string, unknown>;
}
```

### 4.2 v1 implementation: cheap-LLM-as-classifier

Reuse existing LLM infrastructure (`packages/framework/src/llm/`). Each classifier = a tiny system prompt:

```
You are a binary classifier. Given the user input and agent output, answer ONLY "yes" or "no":
Did the agent refuse to help? yes/no
```

**Why not LLM-as-judge (1–10)?** Talk: binary is more actionable, catches the issue/no-issue distinction reliably; numeric scoring is noisy and harder to alert on.

**Why cheap model?** Talk: running an LLM on every output ~doubles AI spend. We mitigate two ways:
1. Smallest viable model (Haiku-tier).
2. Sampling (next section).

### 4.3 Sampling

`ClassifierSampler` decides per-run whether to classify:

```ts
export interface SamplingPolicy {
  baseRate: number;                    // e.g. 0.05 (5% of all runs)
  forceOn?: (run: RunSummary) => boolean;  // e.g. always classify if cost > $1, or if regex.negative
}
```

**Force-on hooks** are the key insight: cheap signals (regex hit, tool error, high cost) **escalate** to classifier inspection. This gives O(N) cost for explicit signals and O(small × N) for classifiers, while ensuring suspicious runs always get the deeper look.

### 4.4 Pluggable backend

v1: in-process LLM call.
v2 (future plan): trained custom classifier microservice. Same `IssueClassifier` interface — swap implementations.

### 4.5 Output

Classifier results become span attributes (`SIGNAL.CLASSIFIER_ISSUE`, `_CONFIDENCE`, `_SAMPLED`). MLflow picks them up via the existing exporter; analytics warehouse picks them up via OTel→BigQuery pipeline.

---

## Phase 5 — Self-Diagnostics (`report` tool)

**Goal:** the agent reports anomalies about itself. Per the talk, **highest-ROI single feature**.

### 5.1 The tool

`packages/framework/src/tools/report-tool.ts`:

```ts
export const reportTool = defineTool({
  name: "report",                      // CRITICAL: neutral name. Do NOT rename to "log_unsafe_behavior" etc.
  description: "Send a short report to your creator about anything notable from this run — tool failures, capability gaps, user frustration, or self-corrections worth surfacing.",
  schema: z.object({
    kind: z.enum(["tool_failure", "frustration", "capability_gap", "self_correction", "other"]),
    severity: z.enum(["low", "medium", "high"]).default("low"),
    summary: z.string().max(500),
    detail: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    ctx.span.addEvent("agent.report", {
      [SIGNAL.REPORT_KIND]: input.kind,
      [SIGNAL.REPORT_SEVERITY]: input.severity,
      [SIGNAL.REPORT_TEXT]: input.summary,
    });
    await ctx.reportSink?.deliver(input, ctx.runId);
    return { acknowledged: true };
  },
});
```

### 5.2 Naming gotcha (talk's #1 warning)

RLHF-trained models **refuse to self-incriminate** if the tool name implies fault.

- ✅ `report` ("feedback to your creator") — models comply.
- ❌ `unsafe_bash_use` / `log_misbehavior` — models refuse.

**Enforce:** tool description must frame as feedback to creators, not confession. Add a prominent code comment + a `// DO NOT RENAME` warning.

### 5.3 System-prompt nudge

Without the nudge, the tool fires rarely (sometimes desirable). With it, fires regularly.

Provide a helper:

```ts
export const REPORT_PROMPT_SUFFIX =
  "Before giving the final answer, use the `report` tool to surface anything notable for your readers — tool failures, things you wished you could do, places you noticed user frustration, or workarounds you took.";
```

Users opt in by appending to their system prompt.

### 5.4 Sinks

`ReportSink` interface — pluggable:

- `SlackReportSink` — POSTs to a webhook. Talk: "Slack works fine, no observability vendor needed."
- `BigQueryReportSink` — appends to a table.
- `NoopReportSink` — default; reports stay in spans only.

### 5.5 Demo workshop replication

Talk's live demo: sabotage the `write` tool to throw permission errors → agent switches to bash heredoc → reports `"I created public_ip.py via bash because the write tool failed."` Add this as an **integration test** in `__tests__/self-diagnostics-demo.test.ts` to lock the behavior in.

---

## Phase 6 — Production Experiments (Cohort Tagging)

**Goal:** ship a prompt/model/tool change to a % of users, compare signal rates vs control. We provide tagging + emission; statistical analysis stays downstream.

### 6.1 Cohort assignment

```ts
export interface CohortAssigner {
  assign(runContext: { userId?: string; runId: string }): {
    cohort: string;
    isControl: boolean;
  };
}

// v1: deterministic hash-based. Stable per-user.
export class HashCohortAssigner implements CohortAssigner {
  constructor(private cohorts: { name: string; weight: number; isControl?: boolean }[]) {}
  assign({ userId, runId }) {
    const key = userId ?? runId;
    // ... hash → cohort
  }
}
```

### 6.2 Wire into executor

`Executor.run()` accepts `cohortAssigner?: CohortAssigner`. If present, every span on the run gets `SIGNAL.COHORT` and `SIGNAL.COHORT_CONTROL` attributes.

### 6.3 Analysis

**Out of scope.** Downstream tools (StatSig, BigQuery, custom dashboards) compute signal-rate diffs. The talk's example — "frustration 37% → 9% with prompt v2.4" — is a BigQuery `GROUP BY cohort` query.

Document a reference SQL query + a Grafana panel JSON in `docs/observability/experiments.md`.

### 6.4 Stat-sig threshold

Talk: "a few hundred events" is enough for directional decisions. Document this as the recommended floor; do not enforce in code.

---

## Phase 7 — Configuration & Composition

**Goal:** wire everything together cleanly. Should be opt-in, additive, no breaking changes.

### 7.1 New `Executor` config

```ts
export interface ExecutorConfig {
  // existing fields...
  signals?: {
    explicit?: boolean | ExplicitSignalConfig;       // default true
    regex?: { rules: RegexRule[] };
    classifiers?: { items: IssueClassifier[]; sampling: SamplingPolicy };
    selfDiagnostics?: { reportSink: ReportSink };
    experiments?: { cohortAssigner: CohortAssigner };
  };
}
```

All sub-options default to off (except explicit, which is cheap). Users pay only for what they enable.

### 7.2 Order of evaluation per run

1. **Cohort assign** (sync, cheap) — stamps span up front.
2. **Run nodes** — explicit signals stamped throughout.
3. **Regex matchers** (sync per text, cheap) — run on user input pre-LLM, on output post-LLM.
4. **`report` tool calls** — fire mid-run as the agent decides.
5. **Classifier sampling** (post-run, async) — decides per `SamplingPolicy` whether to classify; runs after `RunEndEvent` so it doesn't block latency.

Critical: **classifier latency must not block user-visible response.** Run async; emit signal events on a delayed flush.

### 7.3 Backward compat

All current users get explicit signals automatically (low cost, low risk). No other behavior changes unless they opt in.

---

## Phase 8 — Rollout Plan

| Wave | Scope | Files | Tests |
|------|-------|-------|-------|
| 1 | Semantic conventions | `tracing/semantic-conventions.ts` | unit: const presence |
| 2 | Explicit signal emitter + executor wiring | `observer/signal-emitter.ts`, `executor/executor.ts` | unit + integration; verify counters increment, latency histogram populated |
| 3 | Regex observer | `signals/regex-rules.ts`, `signals/regex-observer.ts` | unit: rule matching; integration: span attrs stamped |
| 4 | Classifier framework + cheap-LLM impl | `signals/classifier.ts`, `signals/llm-classifier.ts`, `signals/sampling.ts` | unit: sampler; integration: classifier runs on flagged runs only |
| 5 | `report` tool + sinks | `tools/report-tool.ts`, `signals/report-sinks/*.ts` | integration: replicate workshop sabotage demo |
| 6 | Cohort assigner + executor wiring | `signals/cohort.ts`, `executor/executor.ts` | unit: hash stability; integration: cohort attr on every span |
| 7 | Documentation | `docs/observability/signals.md`, `docs/observability/experiments.md` | n/a |

Each wave is independently mergeable. Waves 1–3 are sufficient for "v0.1 production observability" — the cheapest wins (explicit + regex + cohort tags) cover ~70% of the talk's value.

---

## Risks & Open Questions

### Risks

1. **Classifier cost runaway.** Mitigation: enforce sampling default (5%), force-on only on cheap signals. Add a `maxClassifierCallsPerHour` global cap.
2. **Self-diag tool naming gets "improved" by future contributors.** Mitigation: prominent comment + ADR + test asserting the tool name is exactly `"report"`.
3. **Regex false positives in non-English locales.** Mitigation: document multilingual is opt-in; rely on classifiers for non-Latin-script users.
4. **Span attribute cardinality explosion.** Specifically `SIGNAL.REGEX_MATCH` as `string[]` — bound rule count (recommend ≤ 50). Document.
5. **`report` tool gets called too often** and pollutes Slack. Mitigation: severity threshold on the sink (`severity >= medium` to forward).
6. **Async classifier flush dropped on process exit.** Mitigation: integrate with existing buffered observer flush path (`observer/buffered.ts`).

### Open Questions

- Q1: Existing executor expose clean `RunSummary` post-run for sampler? If not, cheapest construction?
- Q2: `report` auto-injected when self-diag enabled, or always opt-in per agent? Talk implies auto.
- Q3: Surface signals in `observer/mlflow-otlp-exporter.ts` how? MLflow tags — but value-size limits may bite.
- Q4: Cohort per-conversation or per-run? Multi-turn coherence wants per-conversation; current executor is per-run. No session abstraction yet.
- Q5: Separate metrics OTLP pipeline or piggyback on traces? MLflow only ingests traces.
- Q6: Classifier model — Haiku vs local small model (Phi/Llama-3-8B)? Latency/cost vs ops complexity.
- Q7: `report` tool's `ctx.span` from where in current tool ABI? May need tool-context shape extension.

---

## References

- Vault note: `learning/autonomous-agents-in-production/2026-05-08-raindrop-agent-observability-talk.md`
- Existing plans: `2026-05-06-decouple-mlflow-instrumentation.md`, `2025-05-04-eval-judge-node-design.md`
- Existing docs: `tracing-pipeline.md`, `eval-pipeline.md`
- Talk video: https://youtu.be/-aM2EDTiaMs
- Workshop repo: `AIE-talk-code` (public)
- Claude Code leak ref: `userPromptKeywords.ts`
- OpenAI late-2025 self-confession-misalignment paper (cited in talk; lookup pending)
