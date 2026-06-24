# PR Remediation Plan — Pass 8

**Date:** 2026-06-20
**Branch:** feat/multi-tenant-single-host
**Findings:** 0 critical, 15 advisory (5 actionable, 10 consciously deferred)

## Review Cohort

6-agent parallel review (code, errors, tests, types, comments, architecture) over the full
branch diff vs `main` (174 files, ~33,061 insertions). All agents briefed on the deliberate
defensive patterns (never-throw, fail-closed, ADTs, parse-don't-validate, idempotent
durable-requeue per ADRs 0044/0045/0051/0060) so intentional design is not flagged as defect.

| Agent | Critical | Advisory |
|-------|----------|----------|
| code-reviewer | 0 | 0 |
| silent-failure-hunter | 0 | 0 |
| pr-test-analyzer | 0 | 2 |
| type-design-analyzer | 0 | 4 |
| comment-analyzer | 0 | 5 |
| architecture-tech-lead | 0 | 2 |

**Zero critical findings** after 7 prior remediation passes. No code-behavior defects.

## Critical Fixes

None — no critical findings.

## Advisory Fixes Applied (comment/doc accuracy — zero behavioral risk)

### Fix 1: Stale conversation-store header
- **Source:** comment-analyzer
- **File:** packages/host/src/hitl/adapters/bot/conversation-store.ts:4
- **Issue:** Header said "v1 stores a single default reference under one key" but the impl
  also has per-team references (`saveTeamReference`/`getTeamReference`, FR-041).
- **Fix:** Header now describes both the per-team reference (FR-041) and the default fallback.

### Fix 2: FR-031 spec-tag collision in node-context-factory
- **Source:** comment-analyzer
- **File:** packages/host/src/adapters/node-context-factory.ts:5,10,11,70,165,262,263
- **Issue:** Cache/checkpoint key isolation was tagged `@satisfies FR-031`. Spec FR-031 is
  "per-tenant secrets resolved only in the owning worker" (correctly tagged in
  worker-main.ts/secrets-source.ts). The canonical owner cache-keys.ts tags the same
  behavior FR-013 + SC-008. So FR-031 denoted two different requirements across the PR.
- **Fix:** Relabeled all cache/checkpoint-isolation tags FR-031 → FR-013 to match the
  canonical owner and the spec. (`spec.md:166` FR-013 = cache/checkpoint isolation.)

### Fix 3: thin-init restart-trigger imprecision
- **Source:** comment-analyzer
- **File:** packages/host/src/supervisor/lifecycle/thin-init.ts:13
- **Issue:** Header said PID 1 "restarts it if it exits non-zero," but the policy
  (`decideSupervisorRestart`, lines 65-71) restarts on ANY exit including clean code 0.
- **Fix:** Header now says "restarts it on ANY exit — clean exit and crash alike, subject
  to a crash-loop budget."

### Fix 4: decision-store ID_REGEX quantifier
- **Source:** comment-analyzer
- **File:** packages/host/src/hitl/adapters/decision-store.ts:49
- **Issue:** Comment cited `ID_REGEX = /^[A-Za-z0-9_:-]+$/`; actual framework regex
  (ids.ts:54) is `/^[A-Za-z0-9_:-]{1,128}$/`. Character class (the load-bearing claim)
  was correct; only the quantifier was abbreviated.
- **Fix:** Quantifier corrected to `{1,128}` to match the framework source exactly.

### Fix 5: Document deliberate non-subscription to tenant events
- **Source:** architecture-tech-lead (also noted by code-reviewer)
- **File:** packages/host/src/main-supervisor.ts:223
- **Issue:** `subscribeTenantEvents` is exported/tested but never wired. Correct for the
  single-supervisor topology (ADR-0064), but a future reader could mistake it for an
  omission.
- **Fix:** Added a NOTE at the wiring site explaining the deliberate non-subscription and
  that the pub/sub channel is forward-infra for a future multi-supervisor topology.

## Consciously Deferred (not defects)

- **registry.ts ReadonlyMap not deeply frozen** (type-design) — documented, pre-existing
  pattern; runtime deep-freeze would cost per-sync allocation. Intentional.
- **identity.ts ApproverTeamMap raw string[] vs branded Team** (type-design) — type-sound;
  `Team` is a pure provenance brand that erases at runtime. Cosmetic only.
- **PersistedIdentity persists team/sub/azp as plain string** (type-design) — correct for
  JSON round-trip; re-branded via `markTeam` in `toExecIdentity`. Not a defect.
- **host-error.ts pre-existing `team: string` variants** (type-design) — not introduced on
  this branch; new code uses branded `Team`. Out of scope.
- **run-dag.ts header uses old single-tenant FR scheme** (comment) — those header lines are
  NOT in this PR's diff (pre-existing). Out of scope for this branch.
- **main-supervisor.ts has no direct boot/wiring smoke test** (test) — acceptable for a
  composition root; units + integration cover the composed behavior. Optional.
- **run-queue.ts successful-slice lock-release-failure branch un-asserted** (test) — TTL
  fallback is independently tested; very low value. Optional.
- **grace-purge sweep timer lacks single-flight guard** (architecture) — benign given 1h
  interval + idempotent steps. Optional hardening only.

## Validation Commands
```bash
cd packages/host && bun run typecheck
```
(All applied fixes are comment-only — no runtime/test surface changed.)
