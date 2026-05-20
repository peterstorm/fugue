# Feature: AI Summary Tool with DAG-Based Workflow Framework

**Spec ID:** 2026-04-28-ai-summary-dag
**Created:** 2026-04-28
**Status:** Draft
**Owner:** peter.hansen@oister.dk

## Summary

Build a reusable DAG-based workflow framework (the "framework") and, on top of it, a customer-summary tool (the "app") that ingests a single customer's CRM record (latest conversation log, call transcripts, chat logs) and produces a concise overview a support agent reads before contacting the customer. The framework is the primary reusable architectural deliverable; the customer-summary app is its first concrete consumer and the v1 proving ground for the framework's contracts (typed nodes, observers, checkpointing, structured LLM outputs, evals).

This spec covers two deliverables in one feature:
1. **Framework** — a minimal DAG executor with typed node kinds, observability, checkpointing, and LLM caching.
2. **App** — an internal HTTP service that, given a customer identifier, runs the customer-summary DAG and returns a structured overview as JSON.

---

## User Scenarios

### US1: [P1] Support agent fetches customer overview before contact

**As a** support agent about to respond to or call a customer
**I want to** retrieve a concise pre-read summary of the customer's recent conversation history
**So that** I can pick up context without reading the entire chat/call history

**Why this priority:** This is the core value proposition. The whole feature exists to serve this scenario.

**Acceptance Scenarios:**
- Given a customer identifier with at least one conversation in the CRM fixture set, When the support agent's UI requests the summary, Then the system returns a structured JSON overview within the latency budget (see SC-001) describing the customer's recent issues, sentiment, and topics.
- Given a customer identifier with no conversation history, When the summary is requested, Then the system returns HTTP 200 with a discriminated-union body `{ status: "no_history" }` (not an error).
- Given a customer identifier that does not exist in the CRM fixture set, When the summary is requested, Then the system returns HTTP 200 with `{ status: "not_found" }`, distinguishable from an internal failure.
- Given a customer record present in the CRM fixture set but with no transcripts/messages at all, When the summary is requested, Then the system returns HTTP 200 with `{ status: "insufficient_data", missing_fields: string[] }`.
- Given a transient failure during the synthesis call (e.g., LLM provider timeout), When the run was previously checkpointed at the extraction stage, Then a retry of the same request resumes from the last successful checkpoint rather than re-fetching and re-extracting.

### US2: [P1] Engineer runs the eval set to gate prompt or model changes

**As an** engineer changing a prompt, the synthesis model, or an extraction step
**I want to** run the curated eval set locally and have an LLM-as-judge score each output
**So that** I can decide whether the change improves or regresses summary quality before merging

**Why this priority:** Without this, prompt and model changes are unverifiable; quality regresses silently. P1 because the framework's value depends on being able to iterate safely.

**Acceptance Scenarios:**
- Given a curated eval set of CRM fixtures with reference summaries, When the engineer runs the eval command, Then each fixture is processed end-to-end and a per-fixture and aggregate score is produced.
- Given an eval run, When it completes, Then the engineer can see which prompt version and model version were used for each fixture, alongside its score.
- Given a prompt change that degrades aggregate quality below the configured threshold (aggregate mean < 4.0 across factuality, completeness, and conciseness), When eval runs in CI, Then the eval step fails (non-zero exit) so the change is blocked.

### US3: [P1] Engineer inspects a single run's trace to debug a bad summary

**As an** engineer investigating a poor-quality summary
**I want to** view the full trace of a single run — every node's input, output, prompt version, model version, tokens, and cost
**So that** I can attribute the problem to a specific node, prompt, or model and reproduce it

**Why this priority:** Debugging is impossible without per-node observability. The framework explicitly trades a small executor footprint for full traceability; this scenario validates that.

**Acceptance Scenarios:**
- Given a completed run, When the engineer opens the corresponding trace in the local observability UI, Then every node in the DAG appears with its inputs, outputs, duration, and (for LLM nodes) prompt version, model version, tokens-in, tokens-out, and USD cost.
- Given a run that failed at a specific node, When viewed in the trace, Then the failing node is clearly marked and earlier nodes' outputs are still inspectable.
- Given two runs of the same fixture with different prompt versions, When compared, Then prompt version is visible in both traces so the engineer can attribute output differences.

### US4: [P2] Engineer builds a new DAG-based workflow on the framework

**As an** engineer adding a second workflow (not customer-summary) later
**I want to** define a new DAG using the framework's typed node-kind primitives without modifying the framework
**So that** the framework's reusability claim is real, not aspirational

**Why this priority:** Reusability is a stated goal but no second consumer exists in v1; v1 only needs to ensure the contracts are clean enough to support this scenario in principle.

**Acceptance Scenarios:**
- Given the framework's published node-kind contracts (`fetch`, `transform`, `llm`), When an engineer defines a new DAG using only those primitives plus their own zod schemas, Then the framework executes it without requiring framework code changes.
- Given a new DAG, When run, Then the same observer (MLflow) and the same checkpoint store work without per-DAG configuration changes beyond a DAG identifier.

### US5: [P2] Engineer resumes an interrupted run

**As an** engineer or operator
**I want to** restart a run that was interrupted partway (process killed, infra restart, transient error after retries)
**So that** completed expensive work (especially LLM calls) is not redone

**Why this priority:** Resumability is a stated framework feature and a cost saver, but v1 customer-summary has only one LLM call so the practical savings are modest; mark as P2.

**Acceptance Scenarios:**
- Given a run that completed `fetch` and `transform` nodes but was interrupted before the synthesis LLM call, When the run is resumed by run identifier, Then it skips re-execution of completed nodes and proceeds from the checkpoint.
- Given a run whose checkpoint has been evicted or expired (checkpoints have a 24-hour TTL in Redis), When resume is attempted, Then the system returns a clear error indicating the run cannot be resumed and the request must be reissued from scratch.

### US6: [P3] Engineer benefits from prompt/semantic cache hits

**As an** engineer running the same fixture repeatedly during development
**I want to** have identical (or semantically equivalent) LLM calls served from cache
**So that** development is fast and cheap

**Why this priority:** Nice-to-have for dev ergonomics and eval cost; not required for the support-agent scenario itself. P3.

**Acceptance Scenarios:**
- Given an LLM call with inputs, prompt version, and model version identical to a previously cached call, When invoked, Then the cached response is returned and the trace records a cache hit.
- Given a cached entry past its 24-hour TTL, When invoked, Then the LLM is called fresh and the cache entry is replaced. Cache key is an exact-input hash (prompt version + model version + structured-input hash); no semantic-similarity matching in v1.

---

## Functional Requirements

### Framework — Core Requirements

- FR-001: The framework MUST execute a directed acyclic graph of nodes in topological order, running independent nodes in parallel where possible.
- FR-002: The framework MUST support exactly three node kinds in v1: `fetch` (I/O against an external source), `transform` (pure deterministic computation), and `llm` (call to an LLM provider).
- FR-003: The framework MUST validate every node's input and output against a node-defined schema and reject inputs/outputs that fail validation with a clear error attributing the failure to a specific node.
- FR-004: The framework MUST treat business-logic errors as values returned from nodes (not thrown exceptions) so partial DAG execution can be inspected and resumed.
- FR-005: The framework MUST allow defining a DAG declaratively, with nodes and edges expressed independently of execution-time concerns (observers, checkpoint store, cache).
- FR-006: The v1 framework MUST execute linear topological DAGs only; conditional edges are deferred to v2. The framework MUST NOT architecturally preclude conditional edges in a future version, but v1 only implements linear topological execution.

### Framework — Observability

- FR-010: The framework MUST emit a structured event for every node execution covering at minimum: node identifier, node kind, start time, end time, input payload, output payload, success/failure status.
- FR-011: For `llm` nodes, the framework MUST additionally include in the event: prompt version identifier, model version identifier, tokens-in, tokens-out, and computed USD cost.
- FR-012: The framework MUST allow registering one or more pluggable observers that receive these events; an MLflow-backed observer implementation MUST be provided.
- FR-013: The framework MUST tag every run-level trace with a unique run identifier, the DAG identifier, and the prompt and model versions used.

### Framework — Structured LLM Outputs

- FR-020: Every `llm` node MUST declare a structured-output schema, and the framework MUST instruct the LLM to produce output matching that schema and validate the response against it.
- FR-021: If an LLM response fails schema validation, the framework MUST retry the LLM call once with the same prompt; on a second failure, the framework MUST surface a typed validation error attributable to that node.

### Framework — Prompt Versioning

- FR-030: System MUST load LLM prompts from versioned text files identified by content hash (or equivalent stable identifier), and the loaded version identifier MUST appear in trace metadata for every LLM call that used the prompt.
- FR-031: System MUST refuse to run an LLM node if its declared prompt cannot be located or its version identifier cannot be computed.

### Framework — Checkpointing & Resume

- FR-040: The framework MUST persist DAG state (per-node inputs and outputs) to a checkpoint store after each node completes successfully.
- FR-041: The framework MUST support resuming a run by run identifier, skipping nodes whose outputs are already present in the checkpoint and re-executing only remaining nodes.
- FR-042: The framework MUST return a structured error if resume is requested for a run whose checkpoint is missing, expired, or corrupt. Checkpoints in Redis MUST have a 24-hour TTL.

### Framework — LLM Caching

- FR-050: The framework MUST consult a cache before issuing an LLM call; on hit, the cached response MUST be returned and the trace MUST record a cache-hit indicator.
- FR-051: The cache key MUST be an exact-input hash composed of the prompt version, the model version, and a stable hash of the structured input to the LLM node. v1 MUST NOT implement semantic (embedding-based) caching.
- FR-052: Cache entries MUST expire after a fixed 24-hour TTL. Per-node TTL configuration MUST NOT be exposed in v1.

### Framework — Cost Capture

- FR-060: For each LLM call, the system MUST record tokens-in, tokens-out, and USD cost in the trace; aggregate per-run cost MUST be computable from these per-call records.

### App — Customer Summary

- FR-100: The app MUST expose an HTTP endpoint that accepts a customer identifier and returns a structured JSON summary of that customer's recent conversation history.
- FR-101: The app MUST source conversations through a `ConversationSource` adapter interface; v1 MUST ship a JSON-fixture adapter and MUST NOT ship any real CRM connector.
- FR-102: The customer-summary DAG MUST consist of: (a) a fetch node retrieving the customer's CRM record from the configured `ConversationSource`, (b) one or more transform nodes parsing transcripts and extracting structured features (recency-scored utterances, sentiment markers, topic keywords), (c) a single LLM synthesis node producing the final overview, (d) a node returning the validated overview JSON.
- FR-103: The customer-summary DAG MUST issue exactly one LLM call per run in the happy path (the synthesis call); deterministic extraction MUST do all other work.
- FR-104: The app MUST select a recency-based subset of conversation content for synthesis input using a token-budget-bounded rule: take the most recent messages until ~6,000 input tokens are reached. The synthesis prompt input MUST be the union of (a) the top recency-scored raw utterances filling the token budget, and (b) deterministic extraction features with the following named shapes:
  - `sentiment_markers: { phrase: string, polarity: "positive"|"negative", utterance_index: number }[]`
  - `topic_keywords: { keyword: string, count: number }[]`
  - `top_recency_scored_utterances: { utterance_index: number, recency_score: number, text: string }[]`
  Total synthesis input MUST be hard-capped at 6,000 tokens.
- FR-105: The synthesis LLM node MUST produce output validated against a zod schema with the following exact shape: `{ headline: string, recent_issues: string[], sentiment: "positive"|"neutral"|"negative"|"mixed", topics: string[], suggested_next_action: string }`.
- FR-106: The app MUST return a stable, documented response shape. The `/summarize` HTTP endpoint MUST return HTTP 200 in all non-error cases with a discriminated-union body keyed on `status`, validated with zod:
  - `{ status: "ok", summary: { headline: string, recent_issues: string[], sentiment: "positive"|"neutral"|"negative"|"mixed", topics: string[], suggested_next_action: string } }`
  - `{ status: "no_history" }` — customer found, no conversations
  - `{ status: "not_found" }` — customer id does not resolve
  - `{ status: "insufficient_data", missing_fields: string[] }` — customer record present but lacks any transcripts/messages
  Callers switch on `status`.

### App — Evaluation

- FR-110: The app MUST ship a curated eval set of approximately 20 CRM fixtures with reference summaries.
- FR-111: The app MUST ship a runnable eval command that processes every fixture end-to-end and produces a per-fixture and aggregate score using an LLM-as-judge rubric.
- FR-112: The eval command MUST emit a non-zero exit code when the aggregate mean score across the three rubric dimensions — factuality (vs CRM source), completeness (covers recent issues + sentiment + suggested action), and conciseness — each scored 1-5 by the judge, falls below 4.0. Tone is explicitly excluded from the rubric.
- FR-113: The eval rubric MUST be applied by an LLM judge. The judge model MUST be Claude Haiku (cheaper than the synthesis model for repeated CI runs).

### App — Operational

- FR-120: The app MUST run on local infrastructure brought up by an explicit `bun run infra:up` command, which uses podman-compose to start MLflow + Redis (checkpoint/cache store) containers. `bun run dev` MUST NOT auto-start infra; the steps remain separate, explicit, and testable, with no hidden side effects.

### Data Requirements

- FR-200: System MUST treat all customer conversation data as input-only and MUST NOT mutate the source data.
- FR-201: System MUST tolerate missing optional fields in CRM fixtures and never crash on schema-incomplete input. When a customer record is present but lacks any transcripts/messages, the system MUST return `{ status: "insufficient_data", missing_fields: string[] }` with `missing_fields` enumerating the absent transcript/message fields.

### Integration Requirements

- FR-300: All LLM calls MUST go through `@anthropic-ai/sdk` with `@mlflow/anthropic` (`tracedAnthropic`) for v1, providing first-party MLflow auto-tracing. Claude Agent SDK adoption is deferred to post-v1 when tools/sub-agents are needed. The system MUST NOT contain a multi-provider abstraction in v1.
- FR-301: The observability backend MUST be MLflow running locally; the system MUST NOT attempt to ship traces to a hosted/production backend in v1.

---

## Non-Functional Requirements

### Performance

- NFR-001: A single customer-summary request, cold (no cache), MUST complete within the latency budget defined by SC-001.
- NFR-002: A single customer-summary request, warm (LLM cache hit), MUST complete within the warm latency budget defined by SC-002.
- NFR-003: The eval set (~20 fixtures) MUST complete a full run in under 5 minutes wall-clock on a developer reference machine.

### Reliability

- NFR-010: The framework MUST guarantee that a node either completes and is checkpointed, or its output is absent from the checkpoint — no partial node outputs may be visible to downstream nodes.
- NFR-011: The framework MUST be deterministic across re-runs for the `fetch` and `transform` node kinds given identical inputs (LLM nodes are exempt by nature).

### Observability

- NFR-020: 100% of node executions in successful runs MUST appear in the corresponding trace; missing events indicate a framework bug.
- NFR-021: Every LLM call MUST have prompt version and model version present in its trace; absence of either is a framework bug.

### Security

- NFR-030: The HTTP API in v1 MAY run without authentication on the assumption it is deployed on a trusted internal network; the spec explicitly defers auth.
- NFR-031: The system MUST NOT log raw LLM API keys or other credentials in traces or logs.

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: 95th-percentile cold-path latency for a single customer-summary request MUST be under 10 seconds, measured on the developer reference machine against fixture data.
- SC-002: 95th-percentile warm-path (cache-hit) latency MUST be under 500 milliseconds.
- SC-003: 100% of runs MUST emit a complete MLflow trace containing at least one event per node and, for every LLM call, all of {prompt_version, model_version, tokens_in, tokens_out, cost_usd}.
- SC-004: 100% of LLM node outputs in successful runs MUST validate against their declared zod schema.
- SC-005: The eval set MUST contain at least 20 hand-curated CRM fixtures with reference summaries before the feature is considered complete.
- SC-006: LLM-as-judge aggregate mean score on the eval set MUST be at or above 4.0, computed across three rubric dimensions — factuality (vs CRM source), completeness (covers recent issues + sentiment + suggested action), and conciseness, each scored 1-5 — before merging to main. The judge model is Claude Haiku.
- SC-007: A second example DAG (even a trivial one — e.g. a "hello world" two-node DAG used in framework tests) MUST run on the framework using only public node-kind primitives, demonstrating reusability.
- SC-008: An interrupted run MUST be resumable via run identifier with zero re-execution of nodes whose outputs were checkpointed before interruption (verified by an integration test).
- SC-009: The eval command MUST be runnable in CI and MUST gate merges by exiting non-zero on regression below threshold.
- SC-010: Total per-run USD cost MUST be visible in every trace and aggregable across runs without additional instrumentation.

**Measurement approach:** Latency targets verified by a benchmarking script against fixtures; observability completeness verified by integration tests that assert trace shape; eval gate verified by CI configuration; reusability verified by the second-DAG fixture in framework tests.

---

## Out of Scope

Explicitly NOT part of this feature (do not interpret silence as "maybe"):

- Multi-tenancy, row-level security, per-tenant rate limits.
- Multi-provider LLM gateway, provider failover, cross-provider abstraction. Claude Agent SDK only; an outage is tolerated.
- Canary deploys, shadow deploys, feature flags. There is no production deployment in v1.
- Kill switch, circuit breakers, automated HITL approvals.
- Tools/actions invoked from inside the DAG; output is read-only advice for an internal employee. Blast-radius tagging is therefore also out.
- Indirect prompt-injection mitigation beyond the structural guarantee that no tool acts on CRM-derived text.
- PII redaction at the trace boundary. Deferred until real CRM data ever enters traces; v1 is fixtures only.
- Authentication/authorization on the HTTP API.
- A UI for the support agent. Only the JSON API is in scope; the UI is a separate consumer.
- Embedding + clustering of conversation content. v1 uses deterministic parsing and recency-only subset selection.
- Real CRM connectors (Salesforce, HubSpot, Zendesk, etc.). v1 is fixtures only via the adapter interface.
- Token-level LLM streaming. Per-node progress events only; this is a batch lookup, not a chat.
- Production deployment, hosting, on-call, SLOs.
- Any node kinds beyond `fetch`, `transform`, `llm`.
- Multiple LLM calls per customer-summary run (e.g. map-reduce summarization). v1 is one synthesis call.

---

## Open Questions

All open questions from the initial draft have been resolved by the clarification session on 2026-04-28. See the `## Clarifications` section below for the five Q&A decisions (Q1-Q5) that map to the original 13 open questions and 20 in-line uncertainty markers. No open questions remain.

---

## Dependencies

External factors this feature depends on:

- Claude Agent SDK (the only sanctioned path to the LLM).
- MLflow (run locally via container orchestration) for trace storage and inspection.
- A Redis-compatible store for checkpointing and LLM cache (provided locally via container orchestration).
- A CRM fixture data set authored by the team (~20 hand-curated examples with reference summaries).
- Bun runtime and package manager (project standard).

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Synthesis output quality is unacceptable on real-shaped fixtures despite good extraction | High | Eval set + LLM-as-judge gating from day one; iterate on prompt and extraction features before declaring done. |
| The "minimal hand-written executor" claim drifts toward a heavyweight engine as features accrete | Medium | Explicit out-of-scope list; reject features without a specific in-scope user scenario; track executor LOC as a soft budget. |
| Recency-only subset selection misses important older context | Medium | Eval set will surface this; embedding+clustering is named as the deferred next step if it does. |
| Prompt version drift between local dev and CI causes traces that don't reproduce | Medium | Hash-based loading + refusal-to-run on missing prompt version (FR-030, FR-031). |
| Per-node observer overhead becomes unacceptable for larger DAGs | Low for v1 | v1 DAG is small; revisit only if a real second consumer hits this. |
| Cache invalidation gets it wrong — stale summaries served after CRM data updates | Medium | Cache key includes prompt+model+input-hash; CRM input changes therefore invalidate the entry. Real semantic caching is open question (FR-051). |
| Eval LLM-as-judge correlates poorly with human judgment | Medium | Hand-curated reference summaries serve as a sanity floor; rubric dimensions are open and can be tightened. |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| DAG | Directed acyclic graph of nodes the framework executes in topological order. |
| Node kind | One of `fetch`, `transform`, `llm`. The kind constrains what a node may do and what guarantees the framework provides. |
| `fetch` node | Node performing I/O against an external source (e.g. CRM fixture adapter). |
| `transform` node | Pure deterministic computation; no I/O, no LLM, no clock, no randomness. |
| `llm` node | Node that calls the LLM provider with a versioned prompt and a structured-output schema. |
| Observer | Pluggable component that receives per-node and per-run events; one MLflow-backed observer ships in v1. |
| `ConversationSource` | Adapter interface for retrieving a customer's conversation history; v1 ships only a JSON-fixture adapter. |
| Overview / summary | The structured JSON output returned by the customer-summary endpoint. |
| Eval set | ~20 hand-curated CRM fixtures with reference summaries used to score the system. |
| LLM-as-judge | A separate LLM call that scores generated summaries against reference summaries on a rubric. |
| Prompt version | A stable identifier (content hash) of a prompt file at the moment it was loaded for a run. |
| Model version | The provider-reported model identifier used for a given LLM call. |
| Run identifier | Unique identifier assigned to one execution of a DAG; used as the key for traces and checkpoints. |
| Checkpoint | Persisted snapshot of completed nodes' outputs for a run, used to resume. |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial draft from brainstorm output | peter.hansen@oister.dk |
| 2026-04-28 | Resolved 20 clarification markers (Q1-Q5) | peter.hansen@oister.dk |

---

## Clarifications

The following five questions were resolved on 2026-04-28. All answers were approved as the recommended option. Each Q&A maps to multiple uncertainty markers in earlier drafts.

### Q1 — Summary response shape (decision: B)

**Question:** What is the exact response shape of the `/summarize` endpoint, including the no-history / not-found / insufficient-data variants?

**Answer:** A discriminated union keyed on `status`, returned with HTTP 200 in all four cases and validated with zod:
- `{ status: "ok", summary: { headline: string, recent_issues: string[], sentiment: "positive"|"neutral"|"negative"|"mixed", topics: string[], suggested_next_action: string } }`
- `{ status: "no_history" }` — customer found, no conversations
- `{ status: "not_found" }` — customer id does not resolve
- `{ status: "insufficient_data", missing_fields: string[] }` — customer record present but lacks any transcripts/messages

**Affects:** US1 acceptance scenarios; FR-105, FR-106, FR-201.

**Rationale:** Discriminated union forces the caller to handle every branch explicitly and avoids ambiguous null/empty fields. Single HTTP 200 status keeps non-error variants out of the HTTP error-handling path.

### Q2 — Recency selection rule and extraction features (decision: A)

**Question:** How is "recency-based subset" defined for synthesis input, and what extraction features must accompany it?

**Answer:** Token-budget bounded — take the most recent messages until ~6,000 input tokens are reached. Synthesis prompt input is the union of:
- Top recency-scored raw utterances filling the token budget
- Deterministic extraction features:
  - `sentiment_markers: { phrase: string, polarity: "positive"|"negative", utterance_index: number }[]`
  - `topic_keywords: { keyword: string, count: number }[]`
  - `top_recency_scored_utterances: { utterance_index: number, recency_score: number, text: string }[]`

Hard-cap input at 6k tokens.

**Affects:** FR-104.

**Rationale:** Token-bound is robust against very long or very short conversations. Named extraction shapes give the synthesis prompt deterministic, structured signals on top of raw utterances without requiring embeddings (out of scope for v1).

### Q3 — Latency, cache TTL, eval budgets (decision: A)

**Question:** What are the target cold-path p95, warm-path p95, full eval wall-clock, LLM cache TTL, and cache key strategy?

**Answer:**
- Cold-cache p95 latency budget: 10 seconds
- Warm-cache p95 latency budget: 500 ms
- Eval set wall-clock (full ~20-fixture run): under 5 minutes
- LLM cache TTL: 24 hours
- Cache key: exact-input hash only (no semantic-similarity matching in v1)
- Per-node TTL configuration is not exposed in v1

**Affects:** SC-001, SC-002, NFR-003, FR-051, FR-052, US6 acceptance scenarios.

**Rationale:** 10s cold / 500ms warm is achievable with a single LLM call and Redis-backed cache. Exact-input hash is the simplest correct cache; semantic caching adds embedding cost and an additional failure mode v1 doesn't need.

### Q4 — Eval rubric, threshold, judge model (decision: A)

**Question:** What rubric dimensions, pass threshold, and judge model are used for the eval gate?

**Answer:**
- Rubric dimensions: factuality (vs CRM source), completeness (covers recent issues + sentiment + suggested action), conciseness — each scored 1-5 by the judge
- Pass threshold for CI gating: aggregate mean ≥ 4.0
- Judge model: Claude Haiku (cheaper than synthesis model for repeated CI runs)
- Tone is explicitly excluded as a rubric dimension (LLM judges score tone poorly and add noise)

**Affects:** FR-112, FR-113, SC-006, US2 acceptance scenarios.

**Rationale:** Three orthogonal dimensions cover the failure modes that matter (hallucination, omission, verbosity). Haiku is sufficient for rubric scoring and keeps CI cost low.

### Q5 — Framework knobs (decision: A)

**Question:** Should v1 support conditional edges? How should the framework handle structured-output validation failure? What checkpoint TTL? Should `bun run dev` auto-start infra?

**Answer:**
- v1 DAG is linear only. Conditional edges are deferred to v2 (out of scope), but the framework MUST NOT architecturally preclude them — purely a non-implementation deferral.
- On structured-output validation failure: retry once with the same prompt; second failure surfaces a typed validation error.
- Checkpoint TTL in Redis: 24 hours.
- `bun run dev` does NOT auto-start MLflow/Redis. A separate `bun run infra:up` command brings up containers via podman-compose. Explicit, testable, no hidden side effects.

**Affects:** FR-006, FR-021, FR-042, FR-120, US5 acceptance scenarios.

**Rationale:** Linear-only matches the v1 customer-summary DAG and keeps the executor minimal. Single retry on validation failure is a cheap, well-bounded mitigation. 24h checkpoint TTL covers same-day retry/debug while bounding Redis growth. Separate infra command keeps process lifecycle explicit and avoids hidden coupling between dev server and containers.
