# Plan Alignment Report

**Spec:** /Users/hansen142/dev/agentic/fugue/.claude/specs/2026-11-09-host-memory-spikes/spec.md
**Plan:** /Users/hansen142/dev/agentic/fugue/.claude/plans/2026-11-09-host-memory-spikes.md
**Date:** 2026-11-09

## Summary

No gaps found.

Resolved by user decision (not flagged):
- (a) The 10 MB per-request budget (AS-003, NFR-004, SC-004) applies only to filtered or limited requests. Unfiltered requests are exempt. See AD-7.
- (b) The real-data differential and budget benchmarks run locally under FUGUE_REAL_DATA_DIR and are the acceptance bar. CI uses synthetic fixtures. This affects AS-009, AS-018, SC-007, SC-013 and FR-043.
- (c) Warmup is lazy, on the first request to either DAG (FR-015, AS-025, OQ1). See AD-1.
- (d) The dags.test.ts cases that assert the removed design are rewritten (FR-062).
- (e) The snapshot lifecycle reducer lives in fugue-dags and is not declared under `## Lifecycles`. It is recorded in AD-4, so there is no MODEL-N.
- (f) `## Contracts` is omitted because there is no JUnit check in fugue's verification manifest.

Executable-models check: no MODEL-N. The only invariant is INV-1, which is checkable by a regex import rule. Its owner is `none`, with an adequate reason (a repo-wide prohibition).

Ownership check: no OWN-N. The sole shared rule is INV-1, which is unowned with a reason.

Discoveries check: no FEAS-N. brainstorm.md contains decisions and open questions, with no recorded discoveries that contradict the plan. Its "well under 100 MB" recompute estimate is superseded by the spec's 150 MB budget.

## Gaps

None.

## Supporting Documents Checked

- `brainstorm.md` — 0 formal discoveries. 4 open questions and 8 confirmed decisions were checked against the plan.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| US1, AS-001 | Filtered slice parity | Covered (selectLeads, snapshot.property.test) |
| AS-002 | No download or metadata call inside the window | Covered (transition rule 2, dags.test rewrite) |
| AS-003 | Per-request ≤ 10 MB | Covered, scoped by user decision (a) |
| AS-004 | No per-source outputs | Covered (single select-leads node) |
| AS-005 | Empty result with no error | Covered |
| AS-006, AS-007, AS-008 | Opener facts, not-found, score and facts agreement | Covered (lookup-lead, verbatim messages) |
| AS-009 | Parser parity with the reference | Covered (T2 parity, local real-data test) |
| AS-010 to AS-014 | Error and cell semantics | Covered (AD-2, existing tests unchanged) |
| AS-015 | Brancheliste ≤ 100 MB, streamed | Covered (foldRows, parse-memory.ts) |
| AS-016 | One-load multi-sheet | Covered (openWorkbook) |
| AS-017 | Concurrent determinism | Covered (stream-api test) |
| AS-018, AS-019 | Budget benchmark naming breach and value | Covered (evaluateBudgets, memory-budget.test) |
| AS-020 to AS-024 | Freshness, SWR, single-flight, month rollover, atomic swap | Covered (reducer rules 2 to 9) |
| AS-025 | Warmup | Covered, lazy by user decision (c) |
| AS-026, AS-027 | Cold join, re-import | Covered (rule 1, reimport test) |
| AS-028 to AS-031 | Refresh flag, no-flag parity, auth, join in-flight | Covered |
| AS-032 to AS-035 | Last-good, retry, cold failure, check failure | Covered |
| AS-036 to AS-038 | Lockstep 0.6.0, pin, before/after report | Covered (AD-6, T8, T10, T11) |
| FR-001 to FR-006 | Snapshot serving, slices, contracts, no intermediates | Covered |
| FR-007 to FR-014 | Fingerprint, atomic swap, single-flight, SWR, throttle, window, month | Covered |
| FR-015 | Warm snapshot (SHOULD) | Covered, lazy by user decision (c) |
| FR-016, FR-017 | Refresh flag and authorization | Covered |
| FR-018, FR-019 | Last-good and typed cold failure | Covered |
| FR-020, FR-021 | No timers, re-import tolerance | Covered |
| FR-022 | Scoringsmodel read once | Covered |
| FR-030 to FR-040 | Reader contract, streaming form, multi-sheet | Covered |
| FR-041 | Indexes first, then stream Brancheliste | Covered |
| FR-042, FR-043 | SheetJS dev-only, differential test | Covered (INV-1, T2) |
| FR-050 to FR-053 | Process-local in-memory snapshot, tenant isolation | Covered |
| FR-060 to FR-063 | Release, pin, tests green, docs | Covered (FR-062 per decision (d)) |
| NFR-001 to NFR-005 | Memory budgets, zero SharePoint calls | Covered |
| NFR-010, NFR-011 | Security, no lead data in logs | Covered (AD-8) |
| NFR-020, NFR-021 | Last-good integrity, no crash | Covered |
| SC-001 to SC-006 | Memory and checkpoint budgets | Covered (local acceptance, synthetic CI) |
| SC-007, SC-008 | Differential and parity | Covered |
| SC-009, SC-010 | 0 calls inside the window, no concurrent recomputes | Covered |
| SC-011 | Tests pass on 0.6.0 | Covered (T11) |
| SC-012 | Freshness latency, refresh | Covered |
| SC-013 | CI fails on a budget breach | Covered (synthetic CI plus local real data, per decision (b)) |
| US1 to US9 | User scenarios | Covered |
| OOS-001 to OOS-009 | Out of scope | Respected, no work planned |
