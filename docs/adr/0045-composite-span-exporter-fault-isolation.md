# ADR-0045: CompositeSpanExporter Fault-Isolation Policy

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

When more than one trace backend is selected, the framework must deliver the *same* spans to *all* of them simultaneously. A composite span exporter fans the OTel `SpanExporter` contract out to N children (e.g. MLflow and Azure AI Foundry), handing each child the same span instances so run, DAG, and node identities stay consistent across backends.

This fan-out introduces a fault-tolerance decision that the single-backend case never had: **what is the aggregate export result when some — but not all — children fail, and what happens when a child hangs?** The forces at play:

- **Export must never affect the run (FR-025).** Trace export runs off the DAG's critical path (post-run tail-sampling flush). A failing or slow backend must not fail or delay DAG execution; export errors are logged, not propagated to the run.
- **Backends must be mutually isolated (FR-026).** A failure in one selected backend must not affect any other selected backend. One flaky child must not degrade or block its siblings.
- **A backend outage must still complete the run (SC-007, SC-009).** When one backend is killed or made to hang mid-run, the other backend still receives the run's traces and the DAG run completes — 0% of runs fail or are delayed as a result, and the failure is captured in logs.
- **The existing failure signal must stay meaningful.** The tail-sampler already treats a non-zero export result as a logged failure (incrementing `exportFailed`), *not* a run failure. The aggregate result the composite returns directly feeds that counter.
- **A real total outage must remain visible (SC-010).** Volume accounting depends on knowing what was admitted versus what was exported. Silently swallowing a complete export outage would destroy that signal and hide an event operators must alert on.
- **A child's `export` is callback-based.** A child doing async I/O returns `void` synchronously and fires its result callback later. A child whose callback *never* fires (hung socket, DNS black-hole, never-resolving promise) is a distinct failure mode from a child that throws or returns an error result — and one a naive fan-out would never surface.

The problem is to choose an aggregation policy across children that satisfies fault isolation and non-regression while keeping the surviving failure signal honest in both the partial-failure and total-outage cases — including the case where a child neither succeeds nor fails but simply never answers.

## Options Considered

1. **Fail-fast (any child failure fails the composite)**
   - Pros: Simple to reason about; the aggregate is FAILED the moment anything is wrong; no ambiguity about partial state.
   - Cons: Directly violates fault isolation (FR-026). A single flaky or transiently-unavailable backend marks *every* dual-export FAILED, even though the sibling backend received every span. This inflates the tail-sampler's `exportFailed` counter on every flush while one backend is down and spams failure logs, drowning the genuine signal. It contradicts the migration story — MLflow exports succeeding would still be reported as failures whenever Foundry is briefly down.

2. **Always-SUCCESS (swallow every child failure)**
   - Pros: Guarantees the composite never reports failure, so export can never perturb the run; trivially satisfies "export must not fail the run."
   - Cons: Hides a *complete* outage that operators must alert on. If every backend is down, the run reports a clean export while nothing was persisted anywhere. This destroys the SC-010 volume-accounting signal (ingested-equals-admitted can no longer be reconciled against the failure counter) and removes any way to distinguish full success from full outage. Fault isolation is satisfied at the cost of observability of the observability layer itself.

3. **SUCCESS-if-any, FAILED-only-if-all (chosen)**
   - Pros: Aggregate is SUCCESS when at least one child succeeded and FAILED only when *every* child failed. A single dead backend never inflates `exportFailed` (a surviving sibling keeps the aggregate SUCCESS), so partial failure is isolated to per-child counters and rate-limited logs — satisfying FR-025/FR-026 and SC-009. A genuine total outage still surfaces as FAILED with an aggregated error, preserving the SC-010 signal. Matches the migration story: MLflow keeps working, and reporting SUCCESS, when Foundry is down.
   - Cons: Partial failure is *intentionally* not reflected in the aggregate result — a backend silently missing spans is visible only via per-child counters and logs, not the composite's SUCCESS/FAILED code. This is an accepted tradeoff (see Consequences) and is why per-child failure counters are exposed for health checks.

## Decision
**Adopt SUCCESS-if-any / FAILED-only-if-all aggregation, with per-child fault isolation, a bounded per-child settle deadline, and a loud total-outage signal on the lifecycle path.** Implemented in `packages/framework/src/tracing/composite-exporter.ts` as `CompositeSpanExporter`.

Concrete behavior and invariants:

- **`export()` fans out to every child concurrently.** Each child receives the same span instances (no per-child copy), keeping run/DAG/node identity consistent across backends. Each child's `export` is wrapped so that a synchronous throw *or* an error `ExportResult` is caught, logged (rate-limited), and counted per-child — **never rethrown**.
- **Aggregate result:** SUCCESS if at least one child succeeded; FAILED only if *every* child failed, in which case the callback receives an aggregated `Error` concatenating the children's messages.
- **`shutdown()` / `forceFlush()` fan out via `Promise.allSettled` and never reject.** A slow or broken backend cannot wedge the SDK shutdown chain or the run's flush boundary.
- **Per-child failure counters (`childFailureCounts`)** are exposed for health checks. A "failure" is either a thrown error or a non-SUCCESS `ExportResult`. This is the surface through which partial degradation is observable, since the aggregate result deliberately hides it.

As-built refinements layered onto the original policy:

- **Per-child settle deadline (`EXPORT_SETTLE_TIMEOUT_MS`, default 30s, injectable).** Because a child's `export` is callback-based, a child whose callback never fires would otherwise wedge `export()` forever — a non-finite hang would never surface as FAILED. After the deadline, a non-firing child is counted as that child's failure and settles the composite, so an all-hang scenario resolves to all-fail ⇒ FAILED rather than an invisible wedge. The timer is `unref`'d so it never keeps the event loop alive, and the deadline is injectable so tests need not wait 30s. 30s is chosen because export is off the critical path, so a genuinely slow-but-working backend is tolerated while an indefinite hang is still bounded.
- **Fire-once latch per child.** A single `childCallbackFired` flag is shared across the real callback, the synchronous-throw path, and the settle-deadline timer. A child can settle exactly once, so a misbehaving child that invokes its callback twice — or throws *after* already succeeding, or fires *after* the deadline already counted it — can never double-count.
- **Loud total-outage signal on the lifecycle path.** Partial `forceFlush`/`shutdown` rejections are logged per-child at `warn` (isolated, never rejects). When *every* child rejects, an additional `error`-level log with an aggregated message is emitted, so a total outage on the lifecycle path is distinguishable from full success rather than collapsed into rate-limited `warn`s.
- **Rate-limited per-child failure logging.** Failures log at true powers of ten (occurrences 1, 10, 100, 1000, …) to surface a misbehaving backend at first occurrence without spamming logs under high span volume.

The exporter is intentionally vendor-neutral: it knows only the OTel `SpanExporter` contract. Per-vendor span transformation lives in the child exporters, not here.

## Consequences

**Positive:**
- Fault isolation holds: one backend failing, throwing, or hanging never fails or delays a DAG run, and never affects a sibling backend (FR-025, FR-026, SC-007, SC-009).
- The tail-sampler's `exportFailed` counter stays meaningful — a single dead backend does not inflate it, because a surviving sibling keeps the aggregate SUCCESS.
- A genuine total outage still surfaces: FAILED with an aggregated error on the export path, and a loud `error`-level log on the flush/shutdown path, preserving the SC-010 volume-accounting signal.
- Migration story is honest: MLflow keeps exporting and reporting success while Foundry is down or being introduced.
- A hung backend can never wedge the export, flush, or shutdown boundaries — the bounded settle deadline guarantees the composite always settles.
- Partial degradation remains observable for health checks via per-child `childFailureCounts`, even though it is intentionally absent from the aggregate result.

**Negative:**
- Partial failure is deliberately invisible in the aggregate SUCCESS/FAILED result. A backend silently dropping spans while a sibling succeeds is detectable only through per-child counters and logs — callers that want partial-failure alerting must read `childFailureCounts`, not the export result.
- The 30s settle deadline means a real, slow-but-working backend that exceeds 30s on a flush is counted as a failure for that batch; the threshold is a heuristic, not a correctness guarantee, and is tuned for off-critical-path export.
- Rate-limited logging at powers of ten means that between log points a backend can fail many times silently; the per-child counter remains exact, but log-only observers see sampled, not complete, failure history.
- The non-empty-tuple constructor type and the dynamic-config re-narrow rely on a single audited internal cast; a future change that funnels an empty child list through that boundary is caught by a runtime guard (fail-fast) rather than the type system.

Related: ADR-0044 (thin vendor exporter factories with bootstrap composition / dual-backend selection) and ADR-0046 (`initTracing` accepts a `SpanExporter` or a non-empty exporter list — the signature widening that exposes this composite at the public entry point).
