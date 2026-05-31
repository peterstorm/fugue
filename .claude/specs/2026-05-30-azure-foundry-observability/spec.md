# Spec: Azure AI Foundry Observability Backend

**Created:** 2026-05-30
**Status:** Ready for architecture
**Slug:** azure-foundry-observability

---

## Summary

Today the framework emits observability signals — execution traces and post-hoc evaluation
scores — to exactly one backend: MLflow. This feature makes the observability backend a
**selectable, fan-out-capable choice** so a consuming application can decide, without code
changes, where each signal is sent:

- **Traces** can flow to MLflow, to **Azure AI Foundry**, or to **both at once** (side-by-side,
  for migration or comparison).
- **Evaluations** can be scored and recorded through the existing MLflow path or through a new
  **Foundry-native evaluation path**, selected at run time.

Azure AI Foundry's observability is OpenTelemetry-based: traces land in Application Insights and
the Foundry portal reads from there. Evaluations use a Foundry-native scoring path that records
results in the Foundry Evaluations view. MLflow remains the default for every signal and is never
removed or degraded.

This iteration ships, together, three capabilities: (1) trace export to Foundry, (2) a
Foundry-native evaluation path, and (3) a domain-events/metrics layer that surfaces run-level
summaries, routing decisions, pruned branches, and pre-aggregated cost/token/latency/cache
metrics in Foundry.

---

## User Scenarios

### US1: [P1] Send traces to Azure AI Foundry

**As an** operator running a Fugue-based application
**I want to** point the framework's trace export at Azure AI Foundry
**So that** I can view and analyze DAG execution traces in the Foundry portal alongside the rest
of my Azure observability estate.

**Why P1:** This is the core of the feature. Without trace export to Foundry there is no Foundry
observability. It must ship in this iteration.

**Acceptance Scenarios:**
- Given Foundry is selected as the (only) trace backend, When a complete DAG run finishes, Then
  every persisted span for that run is visible in the Foundry portal's Tracing tab.
- Given an LLM node executed in the run, When I inspect its span in Foundry, Then I can see the
  GenAI attributes (system, request/response model, input/output token usage) and the
  framework-owned cost and node-identity attributes.
- Given Foundry is selected as the trace backend, When I inspect a node span, Then it carries the
  node identity (node id and node kind) so the trace can be correlated to the DAG topology.
- Given the existing tail-sampling persistence policy would discard a trace, When the run finishes,
  Then that trace is not sent to Foundry (volume is gated exactly as it is for MLflow today).

### US2: [P1] Run evaluations through the Foundry-native path

**As an** engineer assessing summary quality
**I want to** run the existing evaluation cases through a Foundry-native scoring path
**So that** evaluation scores appear in the Foundry Evaluations view and I can compare quality in
the same tool I use for traces.

**Why P1:** Evaluations are the second half of "observability for both signals." Shipping traces
without evals would leave the feature half-delivered against its stated goal.

**Acceptance Scenarios:**
- Given the Foundry evaluation backend is selected, When I run the evaluation suite, Then all
  existing evaluation cases are scored through the Foundry-native path.
- Given an evaluation run has completed on the Foundry path, When I open the Foundry Evaluations
  view, Then per-case and aggregate scores are visible.
- Given the same evaluation cases are run on both the MLflow path and the Foundry path, When I
  compare aggregate per-scorer scores, Then they agree within an agreed tolerance (no systematic
  divergence).
- Given I want to choose the evaluation backend, When I select it at run time (environment and/or
  command-line selector), Then the suite uses the chosen backend without any code change.

### US3: [P1] Run traces to MLflow and Foundry side-by-side

**As an** operator migrating from MLflow to Foundry (or validating Foundry before switching)
**I want to** export the same traces to both backends simultaneously
**So that** I can compare the two views and migrate with confidence, without losing MLflow history
during the transition.

**Why P1:** Side-by-side export is the explicit migration story and the reason the trace pipeline
is fan-out capable. Exclusive single-backend export is the one-element case of the same mechanism.

**Acceptance Scenarios:**
- Given both MLflow and Foundry are selected as trace backends, When a DAG run finishes, Then the
  same run's traces appear in both MLflow and Foundry.
- Given a run was dual-exported, When I correlate the run across both backends, Then the run, DAG,
  and node identities are consistent between them.
- Given both backends are selected and one backend becomes unavailable mid-run, When the run
  finishes, Then the other backend still receives the run's traces and the DAG run still succeeds.

### US4: [P1] Switch observability backends without code changes

**As an** operator
**I want to** select trace backend(s) and the evaluation backend through configuration
**So that** I can change where signals go per environment (dev/staging/prod) without rebuilding or
modifying the application.

**Why P1:** "Selectable backend" is meaningless if selection requires editing code. Configuration-
driven selection is a defining property of the feature.

**Acceptance Scenarios:**
- Given a configuration that selects one trace backend, When the application starts, Then traces
  go only to that backend.
- Given a configuration that selects two trace backends, When the application starts, Then traces
  fan out to both.
- Given configuration selects the evaluation backend, When the suite runs, Then it uses the
  configured backend.
- Given I change the backend selection in configuration and restart, When the next run occurs,
  Then signals follow the new selection with no code change.

### US5: [P2] See DAG domain events and aggregated metrics in Foundry

**As an** engineer monitoring production runs
**I want to** see run-level summaries, routing decisions, pruned branches, and pre-aggregated
metrics (cost, token consumption, run/node latency, cache-hit rate) in Foundry
**So that** I can monitor and diagnose behavior that raw spans don't directly express.

**Why P2:** High value for monitoring, and in scope this iteration, but the raw trace view (US1)
already delivers the primary "see my runs in Foundry" outcome. Domain events and metrics enrich
that view rather than gate it.

**Acceptance Scenarios:**
- Given the domain-events layer is enabled with Foundry, When a DAG run completes, Then a run-level
  summary event is recorded with at least run duration, status, node count, retry count,
  cache-hit count, and total cost.
- Given a routing decision occurred during a run, When the run completes, Then a route-decision
  event is recorded identifying the chosen and pruned targets.
- Given a branch was pruned during a run, When the run completes, Then a node-pruned event is
  recorded with the reason.
- Given runs have completed, When I view Foundry metrics, Then pre-aggregated metrics for cost,
  token consumption, run latency, node latency, and cache-hit rate are available with run/node
  dimensions.
- Given the same persistence policy that gates trace export, When a trace is discarded by that
  policy, Then its domain events are gated consistently (domain-event volume is governed by the
  same policy as spans).

### US6: [P1] Never degrade MLflow or DAG execution

**As an** application owner
**I want to** be confident that adding Foundry never breaks MLflow, never breaks the other backend,
and never slows or fails DAG runs
**So that** adopting (or experimenting with) Foundry carries no risk to the existing system.

**Why P1:** Fault isolation and zero regression are hard requirements. A new backend that can take
down execution or corrupt the existing backend is not shippable.

**Acceptance Scenarios:**
- Given Foundry is not enabled, When the existing test suites run, Then they all pass unchanged and
  MLflow behavior is identical to today.
- Given any selected observability backend fails or is slow, When a DAG run executes, Then the run
  is neither failed nor delayed by the backend, and the export error is logged rather than
  propagated.
- Given two backends are selected, When one backend errors, Then the other backend is unaffected.
- Given Foundry is enabled (alone or alongside MLflow), When I measure DAG run completion time,
  Then there is no measurable increase attributable to export, because export happens off the
  run's critical path.

---

## Functional Requirements

### Backend selection & configuration

- **FR-001:** The system MUST allow the trace backend(s) to be selected through configuration
  (environment variables and the application configuration file), without code changes.
- **FR-002:** The system MUST support selecting **one or more** trace backends simultaneously.
  Selecting one backend MUST result in exclusive export to that backend; selecting two MUST result
  in the same signals being sent to both.
- **FR-003:** The system MUST keep MLflow as the **default** trace backend when no Foundry selection
  is configured, with behavior identical to current behavior.
- **FR-004:** The system MUST allow the evaluation backend to be selected at run time through a
  run-time selector (environment variable and/or command-line flag), without code changes.
- **FR-005:** The system MUST keep the existing MLflow evaluation path as the default evaluation
  backend.
- **FR-006:** Configuration MUST be validated at startup so that an invalid or contradictory backend
  selection is reported clearly rather than silently ignored.

### Trace export to Foundry

- **FR-007:** The system MUST export DAG execution traces to Azure AI Foundry such that a completed
  run's persisted spans are visible in the Foundry portal's Tracing tab.
- **FR-008:** Exported spans MUST carry the existing vendor-neutral GenAI semantic attributes
  (GenAI system/operation, request and response model, and input/output token usage) without any
  per-node instrumentation changes.
- **FR-009:** Exported spans MUST carry the framework-owned enrichment attributes — at minimum LLM
  cost, node identity (node id and node kind), and DAG/run identity — so traces can be correlated
  to the DAG topology and to cost.
- **FR-010:** The existing tail-sampling persistence policy MUST continue to gate which traces are
  exported, applying equally to Foundry and to MLflow, so that ingestion volume (and the associated
  billing) remains controlled.
- **FR-011:** When two trace backends are selected, the same run's spans MUST be delivered to both
  with consistent run, DAG, and node identities.
- **FR-012:** The existing content-capture / PII gating that governs whether prompt and completion
  text are included in spans MUST continue to apply when exporting to Foundry.

### Foundry-native evaluation

- **FR-013:** The system MUST provide a Foundry-native evaluation path that scores the **same**
  evaluation cases used by the existing MLflow evaluation path.
- **FR-014:** The Foundry-native evaluation path MUST record per-case and aggregate scores such that
  they are visible in the Foundry Evaluations view.
- **FR-015:** The Foundry-native evaluation path MUST reuse the existing Azure OpenAI judge-model
  credentials already used for evaluation today.
- **FR-016:** The MLflow evaluation path MUST remain fully functional and selectable alongside the
  Foundry path; selecting one MUST NOT alter the behavior of the other.
- **FR-017:** Aggregate per-scorer scores produced by the Foundry path MUST be comparable to the
  MLflow path within a defined tolerance (see SC-005), so a backend switch does not silently change
  what "good" means.

### Domain events & metrics layer

- **FR-018:** The system MUST be able to record DAG domain events to Foundry, including at minimum:
  run-level completion summaries, routing decisions (chosen and pruned targets), and pruned
  branches (with reason).
- **FR-019:** Run-level completion summaries MUST include at minimum run duration, status, node
  count, retry count, cache-hit count, and total cost.
- **FR-020:** The system MUST emit pre-aggregated metrics covering cost, token consumption, run
  latency, node latency, and cache-hit rate, dimensioned by DAG and node identity, such that they
  are available in Foundry monitoring.
- **FR-021:** Domain-event and metric emission MUST be governed by the same persistence policy that
  gates trace export, so that a discarded trace does not produce orphaned domain events.

### Authentication

- **FR-022:** The system MUST support, as the default authentication method, an Application Insights
  connection string supplied via configuration.
- **FR-023:** The system MUST support, as an opt-in alternative, Entra ID authentication via the
  standard default Azure credential mechanism.
- **FR-024:** Project-endpoint auto-discovery of the connection string MUST NOT be required; it is
  out of scope this iteration (see Out of Scope).

### Fault isolation & non-regression

- **FR-025:** A failing or slow observability backend MUST NOT fail or delay DAG execution. Export
  errors MUST be logged, not propagated to the run.
- **FR-026:** A failure in one selected backend MUST NOT affect any other selected backend.
- **FR-027:** With Foundry not enabled, all existing framework, host, and customer-summary tests
  MUST pass unchanged, and MLflow behavior MUST be unchanged.
- **FR-028:** Trace, domain-event, and metric export MUST occur off the DAG run's critical path
  (asynchronous / batched, consistent with the existing post-run tail-sampling flush model), so
  that enabling export adds no measurable latency to run completion.

### Dependencies

- **FR-029:** The Azure / Foundry SDK packages required for trace export, evaluation, and domain-
  event/metric emission MUST be treated as **hard dependencies that are always installed**. This is
  a deliberate decision: every application carries the dependency weight in exchange for simpler,
  unconditional wiring. (This supersedes any earlier notion of optional/lazy loading.)

---

## Success Criteria

- **SC-001 (Traces, end-to-end):** For a complete DAG run with Foundry selected, 100% of the run's
  persisted spans are visible in the Foundry portal Tracing tab, and each LLM span shows the GenAI
  attributes (request/response model, input/output token usage), the LLM cost attribute, and node
  identity (node id and node kind). Verification is end-to-end against the portal — "spans landed in
  Application Insights" alone does NOT satisfy this criterion.
- **SC-002 (Evals, coverage):** 100% of the existing evaluation cases (currently 25) are scored
  through the Foundry-native path, and their per-case and aggregate scores are visible in the
  Foundry Evaluations view.
- **SC-003 (Eval backend selectable):** The evaluation backend can be switched between MLflow and
  Foundry at run time via the run-time selector, with zero code changes, and each selection produces
  results in its respective backend.
- **SC-004 (Overhead):** Enabling Foundry — alone or alongside MLflow — produces no measurable
  increase in DAG run completion time at p50 or p95 attributable to export, because export runs
  asynchronously off the critical path.
- **SC-005 (Eval parity):** Across all evaluation cases, the mean per-scorer score from the Foundry
  path is within ±0.5 (on the 1–5 scale) of the MLflow path for every scorer, demonstrating no
  systematic divergence.
- **SC-006 (No regression):** With Foundry not enabled, 100% of existing framework, host, and
  customer-summary tests pass unchanged, and MLflow output is byte-for-byte equivalent to current
  behavior.
- **SC-007 (Dual-export integrity):** With both backends enabled, the same run's traces appear in
  both MLflow and Foundry with consistent run, DAG, and node identities; and when one backend is
  killed mid-run, the other backend still receives the run's traces and the DAG run completes
  successfully (0 run failures attributable to the backend outage).
- **SC-008 (Domain events):** With the domain-events layer enabled, 100% of completed runs produce a
  run-level summary event containing run duration, status, node count, retry count, cache-hit count,
  and total cost; and routing decisions and pruned branches that occur are each recorded.
- **SC-009 (Fault isolation):** When a selected backend is made to fail or hang, 0% of DAG runs fail
  or are delayed as a result, and the failure is captured in logs.
- **SC-010 (Volume gating):** Traces discarded by the persistence policy are not sent to Foundry and
  produce no domain events — i.e., the count of traces ingested by Foundry equals the count the
  policy admits, matching the gating already applied to MLflow.

---

## Out of Scope

Explicitly NOT part of this feature:

- Replacing, deprecating, or removing MLflow. MLflow remains the default for traces and evaluations.
- Building Foundry portal UI, dashboards, or visualizations. The framework emits signals; the
  Foundry portal performs visualization.
- Foundry prompt-flow integration. Standard OTel traces are emitted, not prompt-flow execution data.
- Automatic evaluation on trace ingest / scheduled scorers. This is managed-service-only and not
  available in the open-source environment used here.
- Project-endpoint connection-string auto-discovery. Auto-discovering the Application Insights
  connection string from a Foundry project endpoint is deferred to a future iteration; this
  iteration uses a connection string (default) or Entra ID (opt-in).
- Per-node instrumentation changes. The existing semantic conventions are already vendor-neutral and
  consumed natively by Foundry; no node, LLM-client, or span-emission changes are required to make
  Foundry render traces.
