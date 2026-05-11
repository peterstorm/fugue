# ADR 0022: Criteria for retiring a legacy path

**Status:** Accepted
**Date:** 2026-05-11
**Plan ref:** `docs/plans/2026-05-11-pr-review-remediation.md` §7.8
**Related:** ADR 0007 (legacy fast-path retention), ADR 0021 (single-path runtime — the first retirement).

## Context

The framework has retired one legacy path so far (ADR 0021 retired the `runDag` fast path). The decision to retire it was driven by a one-off "the gaps closed" observation. That worked, but it does not scale: as the framework adds new runtime variants (a new transport, an alternative scheduler, a different durability model), each retirement will need its own criteria, written from scratch.

This ADR codifies the evergreen criteria for retiring any subsequent legacy path. The intent is to make retirement a checklist exercise rather than a re-derivation: when the criteria are met, retirement is safe; when they aren't, the legacy stays.

The criteria are deliberately conservative. A legacy path exists because the new path was once untrusted; the framework should re-earn that trust against measurable thresholds before removing the safety net.

## Decision

A legacy path can be retired when **all** of the following hold:

### 1. Production-equivalent runtime ≥ 30 days

The new path must have run for at least 30 calendar days in a production or production-equivalent environment (e.g., staging with realistic traffic shape). The 30-day window must include:

- At least one normal weekly traffic cycle.
- At least one operational event (deployment, restart, brief outage of a downstream dependency) that exercises the new path's failure modes — *or* a chaos-engineering injection of an equivalent event.

If 30 days have elapsed but the new path has only been exercised by smoke traffic, the clock does not start; the criterion is about *real* exposure, not calendar time.

### 2. Documented rollout strategy executed

A written rollout plan exists and has been completed:

- Canary deployment to a defined subset of traffic.
- Percentage-based or feature-flagged ramp from canary to full traffic.
- An explicit rollback procedure that was either rehearsed or invoked successfully.

The rollout document lives in `docs/plans/` (or equivalent) and is linked from the retirement ADR.

### 3. Test-coverage threshold

The new path has parity-or-better coverage compared to the legacy path:

- Every test that previously exercised the legacy path either runs against the new path or has an explicit replacement.
- Property tests covering the runtime invariants (event ordering, idempotency, retry budget accounting) exist and pass.
- Failure-mode tests covering at least: crash mid-run, schema-evolution between checkpoint write and resume, concurrent siblings, transport failure.

Line coverage is not the metric; *behavior* coverage is. A path with 100% line coverage that does not exercise crash-resume is not ready.

### 4. No open critical bugs against the new path

The retirement ADR enumerates every open bug filed against the new path. Each must be triaged:

- **Closed** before retirement.
- **Downgraded with a written rationale** explaining why the bug is not a blocker.

A "critical bug" is one that, if it occurred in production, would require operator intervention beyond normal monitoring — not one whose impact is recoverable within the framework's existing retry/DLQ surface.

### 5. Operator sign-off

The team responsible for operating the framework in production has signed off on retirement. "Sign-off" means an explicit written acknowledgment (commit message, PR comment, ADR co-author line) from someone with on-call rotation responsibility.

Operator sign-off is not a rubber stamp — operators must be able to point at the four prior criteria and confirm each. If any criterion is weak, sign-off is withheld until it is strengthened.

## Process

A retirement happens in five steps:

1. **Propose.** Open a draft ADR using ADR 0021 as a template. Enumerate which legacy path is being retired and why now.
2. **Audit against §1–§5.** Either confirm each criterion with evidence (links to dashboards, test runs, rollout docs, bug trackers) or document the gap and the plan to close it.
3. **Schedule.** Pick a retirement date that allows for a code-freeze window and a final rehearsal of the rollback procedure.
4. **Execute.** Land the retirement PR. The PR description must link this ADR and the legacy path's superseding ADR.
5. **Monitor.** For 30 days post-retirement, the on-call rotation watches for regressions traceable to behavior the legacy path had and the new path now owns alone.

## Consequences

**Positive:**

- Retirement decisions become a checklist exercise, not a re-derivation. The cost of "should we retire this path?" drops.
- Operators have a known floor of confidence before code paths they rely on disappear.
- Future ADRs reference this one for the criteria; the criteria can be refined in one place over time.

**Trade-offs:**

- A path that "feels ready" but doesn't meet a criterion stays. This is intentional — the criteria are conservative. The cost of one extra month of dual-path maintenance is much smaller than the cost of a botched retirement.
- The 30-day clock means there's a minimum-time-to-retirement after any new path lands. A team that builds a replacement in a week still waits a month before pulling the lever.

## Non-goals

- This ADR does not define when a *new* path is built. Building a new runtime variant is a feature decision, judged on its own merits.
- This ADR does not enumerate every possible legacy path. The criteria apply to *any* dual-path situation: transport adapters (BullMQ ↔ alternative), scheduler implementations, durability backends, etc.

## Historical application

ADR 0021 retired the `runDag` legacy fast path. Mapped against this ADR's criteria retroactively:

| Criterion | Status at retirement |
|---|---|
| 30 days production runtime | The state-machine path had been the default for HITL/retry/conditional DAGs for ~3 months. |
| Rollout strategy | Routing predicate (ADR 0019) acted as an in-place feature gate; the SM path was canary-tested on every DAG that opted into HITL/retries. |
| Test coverage | Wave 6 (test fortification) brought the SM path to parity coverage. The legacy-only tests were the basis for the retirement PR's deletions. |
| Open critical bugs | None — the retirement PR addressed all known semantic gaps (validation fail-fast, writeCheckpoint integration) inline. |
| Operator sign-off | Author + reviewer (single-engineer ops at the time). |

The criteria were met. The retirement was safe. This ADR formalizes the playbook so the next retirement does not need to argue from first principles.
