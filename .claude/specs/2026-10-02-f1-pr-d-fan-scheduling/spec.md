# Feature: F1 PR-D — Bounded-Concurrency Fan Scheduling with Whole-Fan Budget Admission

**Spec ID:** 2026-10-02-f1-pr-d-fan-scheduling
**Created:** 2026-10-02
**Status:** Draft
**Owner:** Peter Storm

## Summary

Today a runtime-width map fan runs its children strictly one at a time, so wide fans are slow, and a fan can burn a large part of the run's budget before anything notices that the whole fan cannot fit. This feature lets DAG authors run fan children concurrently up to an authored limit, capped by a host-wide operator maximum. It adds a whole-fan budget admission check: after the first batch of children, it projects whether the remaining children fit the run's ceilings and refuses at a known, resumable point if they do not. Determinism is kept throughout: index-ordered reduce, first error by index, and drain-and-save on failure. It also adds selectable per-child cost estimators. Requirements for nested fans (depth 2), opt-in adaptive concurrency, and bounded static fan-out siblings are deferred to the follow-on D2 and D3 deliveries — each with its own spec (see the F1 plan's Dependencies table) — and are out of this delivery's scope. 

All Key Constraints in `brainstorm.md` are locked and carry into this spec.

---

## User Scenarios

### US1: [P1] Run fan children concurrently with deterministic results

**As a** DAG author
**I want to** set a concurrency limit on a map node so several children of a runtime-width fan run at once
**So that** wide fans finish faster while the reducer still sees exactly the same index-ordered input it would in a sequential run

**Why this priority:** Core capability; every other scenario depends on concurrent dispatch existing.

**Acceptance Scenarios:**
- AS-001: Given a map node with no concurrency limit authored, When the fan runs, Then its observable trace (dispatch order, checkpoint writes, reducer input, errors) is identical to today's sequential fan.
- AS-002: Given a map node with concurrency limit C and N independent children of equal latency L, When the fan runs, Then it completes in ≤ ceil(N/C) × L + 10%.
- AS-003: Given concurrency C > 1 and children that complete out of index order, When the reducer runs, Then it receives results in index order 0..N-1.
- AS-004: Given a fan resumed from checkpoints where some indices were already completed out of order, When the fan finishes, Then reducer input is in index order and identical to an uninterrupted run.
- AS-005: Given a fan whose children have already-saved checkpoint entries for their index and current execution epoch, When the fan runs at C > 1, Then those indices replay from checkpoint and are not re-dispatched.
- AS-006: Given any checkpoint entry for the fan is corrupt, When the fan starts at any concurrency, Then the whole fan is refused before any child is dispatched.
- AS-007: Given a child fails retryably, When its existing node retry policy allows another attempt, Then the attempt runs within the same execution epoch and the fan does not start draining until that child fails terminally.
- AS-008: Given a reroute advances the execution epoch, When the fan runs again, Then prior-epoch checkpoint entries are not replayed.

### US2: [P1] Refuse a fan that cannot fit the run's budget, at a known and resumable point

**As a** DAG author or operator
**I want** the fan to project the whole fan's spend after its first batch and refuse to start more children when the remainder cannot fit the run's ceilings
**So that** a fan never silently burns most of the budget and then fails or partially reduces, and I learn exactly where it stopped and how to continue

**Why this priority:** Without it, concurrency multiplies the cost of discovering a budget problem late.

**Acceptance Scenarios:**
- AS-009: Given concurrency C and no persisted refusal seed for the fan's current execution epoch, When the fan starts, Then the first min(C, remaining) children are dispatched as the probe batch without projection. (When a seed exists, AS-056 applies: projection runs before every dispatch, including the first.)
- AS-010: Given the probe batch has settled, When before a later dispatch `settled + remainingChildren × perChildEstimate > ceiling` on any budgeted axis, Then the fan dispatches no new children and returns a typed projection-refusal error.
- AS-011: Given a projection refusal, When surfaced, Then the error carries the fan id, the breached axis and its ceiling, the per-child estimate and the estimator used, completed and remaining counts, whether the headroom was a known lower bound, and a hint that continuing requires redeploying the DAG with a larger budget.
- AS-012: Given a projection refusal, When the run outcome is recorded, Then it is a distinct budget-refusal kind (not a generic failure) and a structured event is emitted with effective concurrency, projected per-child cost, and the refusal point.
- AS-013: Given children in flight when the projection refuses, When they finish, Then their outputs are validated and saved, and the refusal error counts them as completed.
- AS-014: Given a refused fan, When resumed without a DAG redeploy, Then it is refused again with the same kind of error before any child is dispatched, regardless of how many children remain (including a remainder of C or fewer) and regardless of per-child cost variation, and no already-saved child is re-dispatched.
- AS-056: Given a projection refusal, When the drain completes, Then a refusal seed is persisted for the fan's current execution epoch. The seed holds the estimator, the per-child spend samples observed so far (including drain completions), the per-child estimate, and the ceilings in force at refusal. When that fan is resumed in the same epoch, Then the seed is loaded and evaluated BEFORE any dispatch. If no ceiling has been raised since the refusal, the fan is refused again (sticky refusal). Otherwise the seeded estimate is projected before every dispatch, with no unprojected probe, and the fan proceeds only while the projection admits.
- AS-015: Given a refused fan, When the DAG is redeployed with a larger budget and the run resumed, Then all saved indices are reused, only unsaved indices are dispatched, and the fan completes.
- AS-016: Given an axis whose headroom is unpriced or unknown-usage, When the known lower bound alone breaches the ceiling, Then the fan refuses and the error states the true spend may be higher.
- AS-017: Given an axis that is unbudgeted, When the fan runs, Then no projection is applied on that axis.
- AS-018: Given concurrency C and the default largest-seen estimator, let M be the largest measured per-child spend. M uses the lifetime-window measure: the run-wide spend delta between a child's dispatch and its settle, which never under-counts true per-child spend. When any fan runs to completion or refusal, Then the FR-018 bounds hold:
  - spend after a refusal decision ≤ (C−1) × M;
  - with no cost spike (no child exceeding the estimate in force at its admission), post-probe dispatches cause no overshoot, so total post-probe overshoot ≤ (C−1) × M;
  - the unprojected probe batch's overshoot is bounded by C × M and by the host per-call meter;
  - a cost spike is bounded only by the host per-call meter.

  Because M over-approximates true per-child spend, these bounds are no weaker against true spend.

### US3: [P1] Stop cleanly on failure or abort, keeping finished work

**As a** DAG author or operator
**I want** a failing or aborted fan to stop starting new children while in-flight children finish and save
**So that** no paid-for work is lost and a resume continues from the furthest safe point

**Why this priority:** Concurrency without defined failure semantics yields non-deterministic errors and lost work.

**Acceptance Scenarios:**
- AS-019: Given a child fails terminally, When the failure is observed, Then no new children are dispatched, in-flight children run to completion, and their outputs are validated and saved.
- AS-020: Given several children fail terminally during the drain, When the fan returns, Then the primary error is the lowest-index failure and the others are attached as secondary causes.
- AS-021: Given a higher-index child fails before a lower-index child fails, When the fan returns, Then the lower-index failure is primary regardless of completion order.
- AS-022: Given the run is aborted mid-fan, When the abort is observed, Then no new children are dispatched, the reducer does not run, and children already completing may save checkpoints.
- AS-023: Given the run is aborted mid-fan, When the fan returns, Then the error kind is distinct from both a budget refusal and a child failure.
- AS-024: Given a fan stopped by failure or abort, When resumed, Then every index saved during the drain is reused and not re-dispatched.

### US4: [P1] Operator caps fan concurrency host-wide

**As a** host operator
**I want** a single host-wide maximum fan concurrency that caps any authored limit
**So that** no DAG can overload the host or its upstream providers, and I can force every fan back to sequential

**Why this priority:** An authored limit without an operator ceiling is an unbounded resource risk.

**Acceptance Scenarios:**
- AS-025: Given no host maximum is configured, When a fan runs, Then the host maximum is 8.
- AS-026: Given an authored limit A and host maximum H, When the fan runs, Then effective concurrency is min(A, H).
- AS-027: Given an authored limit greater than the host maximum, When the fan runs, Then it is clamped to the host maximum and a visible warning plus a structured event name the fan, the authored value, and the effective value.
- AS-028: Given the host maximum is set to 1, When any fan runs, Then it behaves identically to today's sequential fan (same trace as AS-001).
- AS-029: Given an authored limit that is not a positive integer, When the DAG is defined or loaded, Then it is rejected with an error naming the node and the invalid value.
- AS-030: Given an invalid host maximum (not a positive integer), When the host starts, Then startup fails with an error naming the setting.
- AS-031: Given the existing DAG-level run-concurrency limit, When the operator or author reads configuration, docs, or errors, Then the per-fan child-concurrency settings are named and documented distinctly from it so the two cannot be confused.

### US7: [P1] Selectable per-child cost estimator

**As a** DAG author
**I want** to choose a percentile-based per-child estimate instead of the default largest-seen
**So that** one outlier-expensive child does not make projection refuse a fan that would actually fit

**Why this priority:** User ruled in scope.

**Acceptance Scenarios:**
- AS-040: Given no estimator chosen, When projection runs, Then the per-child estimate is the largest per-child spend seen so far.
- AS-041: Given a percentile estimator chosen from p50, p90, or p95 and at least 5 children settled, When projection runs, Then the per-child estimate is that percentile of per-child spends seen so far, and the refusal error names the estimator used.
- AS-042: Given a percentile estimator and fewer than 5 settled children, When projection runs, Then projection falls back to the largest-seen estimate and the refusal error (if any) names the estimator actually applied.
- AS-043: Given any estimator, When the fan runs, Then the host per-call meter still enforces every call independently and remains the hard stop.
- AS-051: Given an estimator value outside {largest-seen, p50, p90, p95}, When the DAG is defined or loaded, Then it is rejected with an error naming the node and the invalid value.

---

## Functional Requirements

### Core Requirements — Scheduling (US1)

- FR-001: System MUST allow a DAG author to declare a per-map-node child concurrency limit as part of the authored DAG structure, a positive integer defaulting to 1.
- FR-002: System MUST compute effective fan concurrency as min(authored limit, host maximum).
- FR-003: System MUST never have more than the effective concurrency of a fan's children in flight at any instant.
- FR-004: System MUST, at effective concurrency 1, produce an observable trace identical to the current sequential fan (dispatch order, checkpoint reads/writes, reducer input, errors).
- FR-005: System MUST deliver reducer input in index order on fresh and resumed runs regardless of completion order.
- FR-006: System MUST, for every index at every concurrency, perform checkpoint replay, child output validation, output save, and abort checks.
- FR-007: System MUST key fan checkpoint reads and writes by index and execution epoch; a retry keeps the epoch and a reroute advances it.
- FR-008: System MUST refuse the whole fan before dispatching any child if any of its checkpoint entries is corrupt.
- FR-009: System MUST apply each child's existing node retry policy within the same epoch; only a terminal child failure starts the drain.

### Core Requirements — Budget Admission (US2)

- FR-010: System MUST treat the first min(effective concurrency, remaining children) dispatches as the probe batch and dispatch them without projection, EXCEPT when a refusal seed exists for the fan's current execution epoch (FR-026). In that case there is no unprojected probe, and projection runs before every dispatch.
- FR-011: System MUST, before every dispatch after the probe batch, project the fan's total spend on every budgeted axis as `settled + remainingChildren × perChildEstimate` and refuse when the projection exceeds the axis ceiling.
- FR-012: System MUST read spend and remaining budget only through the existing read-only budget capability; dispatch and spend authority remain with the root orchestrator.
- FR-013: System MUST project available axes (tokens, calls, usd) in their own unit; for unpriced and unknown-usage axes it MUST use the known lower bound and refuse once that bound alone breaches; for unbudgeted axes it MUST apply no projection.
- FR-014: System MUST surface a projection refusal as a typed error carrying fan id, breached axis, ceiling, per-child estimate, estimator used, completed count, remaining count, a lower-bound flag (true spend may be higher), and a hint that continuing requires redeploying the DAG with a larger budget.
- FR-015: System MUST record a projection refusal as a distinct run outcome/error kind, not a generic failure.
- FR-016: System MUST NOT reduce a partial fan result after a refusal.
- FR-017: System MUST, on resume of a refused fan without a budget-raising redeploy, refuse again with the same error kind before dispatching any child. This MUST be deterministic, independent of remainder size and per-child cost variation, and is achieved via the refusal seed (FR-026). After a redeploy with a larger budget it MUST reuse every saved index.
- FR-018: System MUST guarantee the following under the largest-seen estimator. C is the effective concurrency. M is the largest measured per-child spend of the fan under the lifetime-window measure: the run-wide spend delta between a child's dispatch and its settle. M is never below true per-child spend, so every bound below is no weaker against true spend.
  - (a) Post-refusal: spend incurred after a projection refusal decision is ≤ (C−1) × M (at most C−1 children are in flight, each ≤ M).
  - (b) Post-probe, no cost spike: when no child's measured spend exceeds the per-child estimate in force at its admission, dispatches after the probe batch cause no spend beyond any ceiling. Therefore total post-probe overshoot ≤ (C−1) × M.
  - (c) Probe carve-out: the unprojected probe batch (FR-010) is bounded by C × M and by the host per-call meter.
  - (d) Cost spike: a child whose spend exceeds the estimate in force at its admission is bounded only by the host per-call meter (FR-019). This MUST be documented.
  - Under a percentile estimator, (a) still holds and (b) is best-effort only; this MUST be documented. The host per-call meter remains the hard stop.
- FR-019: System MUST keep the host per-call meter as the independent per-call enforcer; fan projection is an earlier, coarser gate, not a replacement.

### Core Requirements — Drain, Failure, Abort (US3)

- FR-020: System MUST, on a terminal child failure or projection refusal, stop dispatching new children, let in-flight children finish, and validate and save their outputs.
- FR-021: System MUST return the lowest-index failure as the primary error and attach all other failures observed during the drain as secondary causes.
- FR-022: System MUST count in-flight children that finish successfully after a refusal as completed in the refusal error and reuse them on resume.
- FR-023: System MUST, on abort, stop dispatching new children and MUST NOT run the reducer; children already completing MAY save their checkpoints.
- FR-024: System MUST report abort with an error kind distinct from both budget refusal and child failure.
- FR-025: System MUST handle a fan that both refuses by projection and observes one or more terminal child failures in the same drain as follows:
  - Return the lowest-index child failure as the primary error.
  - Carry the projection refusal, with every FR-014 field, attached in the returned error.
  - Still emit the refusal structured event. No refusal data may be dropped.
  - At effective concurrency 1 this case cannot arise, because no sibling is in flight when a refusal happens, so FR-004 identity is unaffected.
- FR-026: System MUST, on a projection refusal, persist a refusal seed for the fan's current execution epoch.
  - The seed holds the estimator, the observed per-child spend samples (including drain completions), the per-child estimate, and the ceilings in force.
  - It is stored as an additive checkpoint entry: no framework-version bump, fingerprint unchanged.
  - The seed MUST be evaluated before any dispatch on resume in the same epoch, as specified in AS-056.
  - A reroute (new epoch) ignores the prior epoch's seed.

### Core Requirements — Host Maximum and Permissions (US4)

- FR-030: System MUST provide a single host-wide, operator-controlled maximum fan concurrency in host configuration (not per-tenant), defaulting to 8.
- FR-031: System MUST accept a host maximum of 1, which forces all map fans to sequential behavior.
- FR-032: System MUST reject a non-positive-integer host maximum at host startup, and a non-positive-integer authored limit at DAG definition/load, with errors naming the offending setting or node.
- FR-033: System MUST, when an authored limit exceeds the host maximum, clamp to the host maximum and emit a visible warning and a structured event naming the fan, the authored value, and the effective value.
- FR-034: System MUST NOT offer a per-run override of fan concurrency; only the DAG author (authored structure) and the operator (host maximum) influence it.
- FR-035: System MUST name and document per-fan child concurrency settings distinctly from the existing DAG-level run-concurrency limit.

### Core Requirements — Per-Child Estimator (US7)

- FR-046: System MUST allow a DAG author to choose the per-child cost estimator for a fan from the fixed set {largest-seen, p50, p90, p95}, defaulting to largest-seen. A percentile estimator MUST fall back to largest-seen until at least 5 children of the fan have settled. Any other estimator value MUST be rejected at DAG definition/load with an error naming the node and value. The refusal error MUST name the estimator actually applied.

### Data Requirements

- FR-050: System MUST make every child output saved during drain, refusal, or abort available to a later resume of the same epoch.
- FR-051: System MUST keep the DAG fingerprint structure-only, so raising budget ceilings by redeploy does not invalidate saved fan children.
- FR-052: System MUST source run ceilings only from the DAG configuration; caller-supplied ceilings may only tighten them.

### Integration Requirements

- FR-060: System MUST emit structured observability events for: effective concurrency at fan start (including any clamp), projected per-child cost and estimator at each projection, the refusal point, and adaptive target changes. The refusal event MUST be self-contained: it carries effective concurrency, per-child estimate, estimator applied, axis, ceiling, and completed and remaining counts.
- FR-061: System MUST NOT change the run-status API.
- FR-062: System MUST update documentation: F1 plan §12 ("The fan is sequential") and §13; ADR-0086 or a new ADR for concurrent fan scheduling and projection; fan-runner comments; host configuration docs for the host maximum, including resume-after-refusal behavior, the nested product bound, and the percentile estimator's best-effort overshoot bound.

---

## Non-Functional Requirements

### Performance
- NFR-001: N equal-latency independent children at effective concurrency C MUST complete in ≤ ceil(N/C) × child latency + 10% (deterministic/fake-clock verification acceptable).
- NFR-002: Effective concurrency 1 MUST add no observable difference relative to today's sequential fan.

### Reliability
- NFR-020: Index ordering, first-error-by-index, and saved-index reuse MUST hold under every completion interleaving.
- NFR-021: Under the largest-seen estimator, the FR-018 bounds (a), (b) and (c) MUST each hold as exact invariants, not statistically, against the lifetime-window measure M: post-refusal ≤ (C−1) × M; no post-probe overshoot absent a cost spike; probe batch ≤ C × M.

---

## Success Criteria

- SC-001: Concurrency-1 equivalence test shows 0 differences in dispatch order, checkpoint reads/writes, reducer input, and errors against today's sequential fan.
- SC-002: Wall-clock for N equal-latency children at concurrency C is ≤ ceil(N/C) × L × 1.10 in 100% of runs of the speedup test, for N ∈ {1, C−1, C, C+1, 5C}.
- SC-003: A property test over arbitrary completion orders finds 0 cases where reducer input is not in index order, across ≥ 1,000 generated cases.
- SC-004: Under the largest-seen estimator, with M the largest measured lifetime-window per-child spend, a property test over arbitrary per-child spend sequences, completion interleavings, and all headroom kinds finds 0 violations of FR-018 (a), (b) and (c), across ≥ 1,000 generated cases:
  - (a) spend after the refusal decision ≤ (C−1) × M;
  - (b) in spike-free runs, no post-probe overshoot;
  - (c) probe-batch overshoot ≤ C × M.

  A separate example test pins (d): a cost spike is stopped by the per-call meter, not by projection.
- SC-005: A property test over projection arithmetic finds 0 cases where available, unpriced, unknown-usage, or unbudgeted axes deviate from FR-013, across ≥ 1,000 generated cases.
- SC-006: A property test over failure interleavings finds 0 cases where the primary error is not the lowest-index failure, and 0 cases where any other observed failure is missing from secondary causes.
- SC-007: 100% of in-flight children that complete during drain-on-failure, drain-on-refusal, and abort scenarios have their outputs saved and reused (0 re-dispatches) on resume.
- SC-008: Resume-after-refusal without redeploy is refused (same `fan-budget-refused` kind, 0 dispatches) in 100% of test runs, including remainders ≤ C and non-constant per-child costs; after a redeploy with a larger budget it completes with 0 re-dispatches of saved indices.
- SC-009: Corrupt-checkpoint tests at concurrency > 1 dispatch 0 children before refusing.
- SC-010: Clamp tests show effective concurrency equals min(authored, host maximum), with exactly 1 warning and 1 structured event per clamped fan start.
- SC-011: Host default of 8 and host maximum of 1 are each verified by at least one test.
- SC-013: All doc locations in FR-062 are updated in the same change set.
- SC-014: 100% of projection-refusal tests under each of p50, p90, and p95 produce an error naming the estimator applied; a test for each percentile shows fallback to largest-seen with 0, 1, and 4 settled children and the percentile in use from the 5th settled child onward.

**Measurement approach:** Automated example and property-based tests with deterministic/fake-clock scheduling; doc review at PR time.

---

## Out of Scope

- OOS-001: A host reserve/admit port or any new spend-authority seam; the framework only reads budget.
- OOS-002: Author-declared per-child cost estimates on the node.
- OOS-003: Changes to the host per-call meter's largest-observed-call admission.
- OOS-004: Per-run ceiling overrides, and raising ceilings on resume without a DAG redeploy.
- OOS-005: Cancelling in-flight siblings on failure or refusal (drain-and-save chosen instead).
- OOS-006: A one-child probe before going wide (batch probe chosen instead).
- OOS-007: Concurrency coordination across different fans, and tenant-level or global LLM rate limiting.
- OOS-008: Per-tenant host maximums; the host maximum is host-wide only.
- OOS-009: Per-run overrides of fan concurrency.
- OOS-010: Run-status API changes.
- OOS-011: Map nesting deeper than depth 2, and human-review nodes inside mapped child DAGs.
- OOS-012: Adaptive-concurrency signals other than provider throttling (e.g. latency or error-rate based), and adaptive concurrency for static fan-out siblings.
- OOS-013: Percentile estimators other than p50, p90, p95, and author-configurable minimum sample sizes.
- OOS-014: Whole-fan budget projection for static fan-out siblings, and any change to their default (unbounded) concurrency.

---

## Open Questions

None — all resolved 2026-10-02 (see Change Log).

---

## Dependencies

- Existing runtime-width map fan and its checkpoint replay, output validation, and save path.
- Existing read-only budget capability exposing spend and remaining per axis, including the available, unpriced, unknown-usage, and unbudgeted headroom kinds.
- Host per-call LLM meter.
- Root-held dispatch and spend authority (ADR-0086).
- Run ceilings sourced from DAG configuration, and the spend ledger loaded on resume.

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Probe batch overshoots ceiling by up to one batch | Med | Explicitly carved out in FR-018: bounded by C × M and by the per-call meter. No unprojected probe once a refusal seed exists (FR-026). Operator can lower the host maximum. |
| Confusion between new per-fan concurrency and existing DAG-level run concurrency | Med | Distinct naming and docs (FR-035) |
| Percentile estimator weakens the overshoot guarantee | Med | Default stays largest-seen; percentile bound documented as best-effort; per-call meter remains the hard stop (FR-018) |
| Resume-after-refusal repeated refusal mistaken for a bug | Low | Redeploy hint in error and docs (FR-014, FR-062) |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Map fan | Runtime-width fan where a child DAG runs once per input index, then a reducer combines results |
| Static fan-out | Authored, fixed set of sibling branches that run in the same wave |
| Authored limit | Per-node child concurrency declared by the DAG author; positive integer, default 1 |
| Sibling limit | Authored bound on concurrently running static fan-out siblings; unbounded when not authored |
| Host maximum | Host-wide operator cap on fan concurrency; default 8 |
| Effective concurrency | min(authored limit, host maximum) |
| Nesting depth | Number of map levels on a path; a map inside a mapped child DAG is depth 2 |
| Product bound | Peak concurrent leaf children across nested fans, ≤ Co_eff × Ci_eff |
| Probe batch | First min(effective concurrency, remaining) children, dispatched without projection. Absent when a refusal seed exists for the epoch. |
| Projection | settled + remaining × per-child estimate, checked against each budgeted ceiling before dispatch |
| Per-child estimate | Spend expected per remaining child; largest-seen by default, or p50/p90/p95 once at least 5 children have settled |
| Estimator | Rule that produces the per-child estimate: largest-seen, p50, p90, or p95 |
| Headroom kind | How an axis reports budget: available, unpriced, unknown-usage, unbudgeted |
| Lower bound | Known minimum spend on an unpriced/unknown-usage axis; true spend may be higher |
| Drain | After failure/refusal/abort: no new dispatch; in-flight children finish and save |
| Execution epoch | Checkpoint generation for a node; unchanged by retry, advanced by reroute |
| Projection refusal | Typed, distinct-kind stop when projected fan spend breaches a ceiling |
| Overshoot | Spend beyond a ceiling. Under the largest-seen estimator: post-refusal ≤ (C−1) × M; no post-probe overshoot absent a cost spike; probe batch ≤ C × M; a cost spike is bounded by the per-call meter. M is the largest lifetime-window per-child spend. Best-effort under percentile estimators. |
| Cost spike | A child whose measured spend exceeds the per-child estimate in force when it was admitted |
| Refusal seed | Per-epoch persisted record of a projection refusal: estimator, per-child samples, estimate, and ceilings in force. Evaluated before dispatch on resume; sticky unless ceilings were raised. |
| Adaptive target | Current in-flight limit for an adaptive fan, within [1, effective concurrency] |
| Throttle signal | A child error reporting provider rate-limiting or throttling |
| Clean batch | A set of children equal to the current adaptive target that settles with no throttle signal |
| AIMD | Additive-increase/multiplicative-decrease: target +1 per clean batch, halved (floor, minimum 1) per throttle signal |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-02 | Initial draft from brainstorm and user interview | specify-agent |
| 2026-10-02 | Resolved FR-040/041/044/046/047 open questions with user | specify-agent |
| 2026-10-02 | FR-018, AS-018, NFR-021, SC-004: probe-batch carve-out. Post-probe overshoot ≤ (C−1)×M; probe ≤ C×M plus the per-call meter; M defined as the lifetime-window per-child measure. Precision added so the statement is provable: (a) post-refusal ≤ (C−1)×M is unconditional; (b) "no post-probe overshoot" holds absent a cost spike; (d) a cost spike is bounded only by the per-call meter. Without (d), a single child costing more than every earlier child breaks any (C−1)×M bound (for example at C=1). Reason: plan-alignment round 1, user decision | architecture-agent |
| 2026-10-02 | Added FR-025: a mixed refusal and child failure in one drain returns the lowest-index failure as primary, attaches the refusal in the returned error, and still emits the refusal event. Reason: plan-alignment round 1, user decision | architecture-agent |
| 2026-10-02 | Added FR-026 and AS-056: a refusal seed is persisted per epoch and evaluated before dispatch on resume (sticky refusal unless ceilings were raised). Amended AS-009 and FR-010 (no unprojected probe when seeded), and AS-014, FR-017 and SC-008 (deterministic re-refusal, including remainder ≤ C and non-constant cost). Reason: plan-alignment round 1, user decision | architecture-agent |
| 2026-10-02 | FR-060: the refusal event is self-contained and carries effective concurrency (AS-012 alignment). Reason: plan-alignment round 1, user decision | architecture-agent |
| 2026-10-05 | Scope amendment: the nested-fan, adaptive-concurrency, and static-fan-out-sibling user stories, requirements, and acceptance scenarios were moved out of this delivery's spec; they are deferred to the follow-on D2 and D3 deliveries, each with its own spec. Reason: the wave-gate requirement-coverage floor requires every spec entry to have a completion owner in this delivery's task graph; those entries belong to future runs. Operator-approved | orchestrator |
