# Feature: Eliminate fugue-host Memory Spikes from the Direct-Sales DAGs

**Spec ID:** 2026-11-09-host-memory-spikes
**Created:** 2026-11-09
**Status:** Draft
**Owner:** Peter Hansen

## Summary

The direct-sales lead-scoring and lead-opener DAGs re-read, re-parse and re-score ten rarely-changing SharePoint workbooks on every request, so fugue-host peaks between 1.25 and 1.49 GB on a cold run and grows from 719 MB to 1652 MB under 5 concurrent warm runs. That puts every tenant served by the shared host at risk. This feature computes the scored lead set once for each distinct set of source inputs and keeps the result as a small, fingerprinted, process-local in-memory snapshot. It also replaces the full-load spreadsheet reader with a streaming one, so neither the recompute nor any request spikes memory. Scores, ordering, filters, opener facts and output contracts stay exactly as they are today.

---

## Scope Split (2026-11-10)

This feature is delivered by two Loom runs, one per repository. This spec is the **fugue** half: the streaming `@fuguejs/xlsx` reader, its differential parity tests, the memory benchmark and package docs, and the lockstep 0.6.0 release prep. It owns FR-030 to FR-040, FR-042, FR-043, FR-060, AS-009 to AS-015 and AS-017.

The fugue-dags half (snapshot, lifecycle reducer, recompute, both DAG restructures, leads contract 0.5.0, the before/after benchmarks and the 0.6.0 pin) is specified in `/Users/hansen142/dev/agentic/fugue-dags/.claude/specs/2026-11-10-host-memory-spikes-dags/spec.md`. Its requirements moved there verbatim: FR-001 to FR-022, FR-041, FR-050 to FR-053, FR-061 to FR-063, AS-001 to AS-008, AS-016 and AS-018 to AS-038. The user scenarios below keep their narrative for context; their moved acceptance scenarios live in the fugue-dags spec. The NFR, SC and OOS sections are shared and appear in both specs.

---

## User Scenarios

### US1: [P1] Score-leads requests served from a precomputed snapshot

**As a** lead-desk consumer calling /score-leads
**I want to** get my filtered, ranked lead slice without the host re-reading and re-scoring every workbook
**So that** responses are cheap and the shared host stays stable for every tenant

**Why this priority:** This removes the dominant source of the memory spikes (per-request full parse, fan-in and checkpoint output). Everything else builds on it.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US2: [P1] Lead-opener reads one lead's facts from the snapshot

**As a** lead-desk consumer calling lead-opener for a CVR
**I want to** get that lead's facts without the workbooks being reloaded
**So that** opener generation is cheap and consistent with the scores I saw

**Why this priority:** lead-opener has the same full-reload spike pattern as lead-scoring. Fixing only one DAG would leave the host exposed.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US3: [P1] Streaming spreadsheet reading with exact contract parity

**As a** DAG author using @fuguejs/xlsx
**I want** workbook parsing to stay within a bounded memory budget while behaving exactly as the current parser does
**So that** large workbooks such as Brancheliste never spike memory and existing DAGs need no changes

**Why this priority:** A streaming reader is the only way the recompute itself can stay within budget. Contract parity protects every existing consumer.

**Acceptance Scenarios:**
- AS-009: Given any existing xlsx test fixture or any of the 10 real source workbooks, When it is parsed by the new reader and by the current reference parser, Then the resulting rows are identical in values, types (including dates), order and keys.
- AS-010: Given bytes that are not a ZIP archive, When parsed, Then a non-retriable node-crash error is returned, as today.
- AS-011: Given a sheet name or 1-based sheet index that does not exist, When parsed, Then a node-crash error is returned, as today.
- AS-012: Given a header row with duplicate headers, When parsed, Then a node-crash error is returned. Given blank header columns, Then those columns are skipped, as today.
- AS-013: Given a row that fails row validation, When parsed, Then a validation error naming the row is returned, as today.
- AS-014: Given cells that hold formulas, rich text, hyperlinks, dates or errors, When parsed, Then they produce the cached formula result, plain text, plain text, a date value and an empty (null) value respectively. Rows made only of empty or error cells are skipped.
- AS-015: Given Brancheliste.xlsx, When it is streamed row by row, Then peak memory for the parse stays at or below 100 MB RSS, and rows are delivered to the consumer without the whole sheet being held in memory.
- AS-017: Given many workbooks parsed concurrently in one process, When the parses complete, Then each result is deterministic and identical to the result of a sequential parse.

### US4: [P1] Enforced memory budgets with a regression benchmark

**As a** fugue maintainer
**I want** the memory budgets for recompute, parsing, snapshot size and requests to be checked automatically
**So that** a future change cannot silently bring the spikes back

**Why this priority:** The budgets are the definition of success for this feature. Without an enforced check they would erode.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US5: [P2] Snapshot stays fresh after a workbook is updated

**As a** sales-ops person who manually updates a source workbook in SharePoint
**I want** the scored leads to reflect my update shortly afterwards without any restart
**So that** sales reps work from current data

**Why this priority:** The workbooks change rarely, so a stale snapshot is tolerable for a short time. Freshness still matters for correctness after an update.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US6: [P2] Warm snapshot at startup or first load

**As a** lead-desk consumer
**I want** the first request after a host start or deploy to avoid paying a cold-start surprise where possible
**So that** latency right after a deploy is predictable

**Why this priority:** It improves the post-restart experience but is not needed for the memory goal.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US7: [P2] Manual refresh right after an upload

**As a** sales-ops person who has just uploaded a workbook
**I want to** force the scores to refresh immediately
**So that** I can confirm my update without waiting for the freshness window

**Why this priority:** It is a convenience on top of automatic freshness.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US8: [P2] Last-good snapshot on source failure

**As a** lead-desk consumer
**I want** scoring to keep working when someone uploads a broken workbook
**So that** one bad upload does not take the leads feature down

**Why this priority:** It is a resilience safeguard for a rare event.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

### US9: [P1] Lockstep 0.6.0 release and before/after report

**As a** fugue maintainer
**I want** the @fuguejs packages released together as 0.6.0, with fugue-dags moved onto them and the measured improvement recorded
**So that** production runs the new reader and the gain is documented

**Why this priority:** The memory fix reaches production only through the release.

**Acceptance Scenarios:** moved to the other repository's spec in the 2026-11-10 scope split (see Scope Split above).

---

## Functional Requirements

### Core Requirements


### Spreadsheet Reader Requirements (@fuguejs/xlsx)

- FR-030: The workbook parsing operation MUST keep its existing contract exactly: signature, success/failure result shape, error kinds and retriability.
- FR-031: Non-ZIP input MUST yield a non-retriable node-crash error.
- FR-032: A missing sheet, addressed by name or 1-based index, MUST yield a node-crash error.
- FR-033: Header-row selection MUST behave as today. Blank header columns MUST be skipped and duplicate headers MUST yield a node-crash error.
- FR-034: Row objects MUST be prototype-free, as today.
- FR-035: Cell normalization MUST match today: formulas give the cached result, rich text and hyperlinks give text, dates remain date values, error cells become null.
- FR-036: All-empty rows, including rows consisting only of error cells, MUST be skipped.
- FR-037: Row validation failures MUST yield a validation error naming the offending row.
- FR-038: Parsing MUST be deterministic and safe under concurrent use within one process.
- FR-039: The reader MUST offer a row-streaming form that delivers validated rows one at a time without materializing the whole sheet.
- FR-040: The reader MUST support reading several sheets from one load of a workbook.
- FR-042: The current full-load spreadsheet library MUST NOT be a runtime dependency of @fuguejs/xlsx. It MAY remain as a development-only reference for differential testing.
- FR-043: A differential test MUST compare the new reader's output against the reference parser on every existing fixture and on the 10 real source workbooks.

### Data Requirements


### Integration Requirements

- FR-060: All @fuguejs packages MUST be bumped in lockstep to 0.6.0. Pushing the release tag is reserved for the user.

---

## Non-Functional Requirements

### Performance

- NFR-001: Recompute (all 10 workbooks plus scoring) peak MUST be ≤ 150 MB RSS above the process baseline.
- NFR-002: Streaming parse of Brancheliste.xlsx MUST peak at ≤ 100 MB RSS.
- NFR-003: The steady-state live snapshot MUST occupy ≤ 60 MB.
- NFR-004: Per-request transient memory MUST be ≤ 10 MB.
- NFR-005: Requests inside the freshness window MUST perform zero SharePoint calls.

### Security

- NFR-010: No new roles, routes or secrets are introduced. Refresh is authorized identically to /score-leads.
- NFR-011: Logs and error indicators MUST NOT expose lead data beyond what existing logs already contain. A file name and row number are permitted.

### Reliability

- NFR-020: A failed recompute MUST never replace or corrupt the last good snapshot.
- NFR-021: A recompute failure or metadata-check failure MUST NOT crash the worker process or affect other tenants.

---

## Success Criteria

- SC-001: Recompute peak ≤ 150 MB RSS above process baseline (baseline today: 1.25 GB cold, 1.49 GB with checkpointing).
- SC-002: Brancheliste.xlsx parse peak ≤ 100 MB RSS (baseline today: ~570 MB).
- SC-003: Steady-state live snapshot ≤ 60 MB.
- SC-004: Per-request transient ≤ 10 MB.
- SC-005: 5 concurrent warm /score-leads requests raise host RSS by ≤ 50 MB in total (5 × the 10 MB per-request budget; baseline today: 719 → 1652 MB, +933 MB).
- SC-006: Checkpoint data written per request for the 10 source tables drops from ~29 MB to 0 bytes.
- SC-007: 100% of differential comparisons between the new reader and the reference parser match on all fixtures and all 10 real source workbooks.
- SC-008: For unchanged workbooks, 100% of scores, orderings, filter results (accountManager, minScore, limit) and opener facts are identical to today's output on the parity test set.
- SC-009: Inside a freshness window, 0 SharePoint calls per request. At most 10 metadata lookups and 0 downloads per window per worker process when nothing changed.
- SC-010: 0 concurrent recomputes per process under a concurrent-request test (single-flight holds).
- SC-011: 100% of existing fugue-dags tests and @fuguejs/xlsx tests pass on 0.6.0.
- SC-012: After a source workbook changes, the new data is served no later than one freshness window (default 60 s) plus one recompute duration after the change. A request with the refresh flag gets the new data in its own response.
- SC-013: The CI memory benchmark fails on any budget breach in SC-001 to SC-004.

**Measurement approach:** A peak-RSS regression benchmark in CI enforces SC-001 to SC-004 and fails the build on a breach. Differential and parity tests enforce SC-007 and SC-008. Concurrency and request-counting tests enforce SC-009 and SC-010. A before/after benchmark report, recorded after fugue-dags moves to 0.6.0, captures SC-001 to SC-006 against the baselines above using the existing benchmark scripts (bench2.ts, sources.ts, parse.ts).

---

## Out of Scope

Explicitly NOT part of this feature:

- OOS-001: A separate compute worker or runner, OpenShift CronJob, new secrets or Argo manifests. Revisited only if in-host recompute misses the memory budget.
- OOS-002: Persisting snapshots to a database, Redis or any external store.
- OOS-003: A per-node checkpoint opt-out in the framework or host (dropped as unnecessary once outputs are small).
- OOS-004: Changing maxConcurrent, pod or worker memory limits, checkpoint compression or TTLs, or output and fan-in re-validation in the host.
- OOS-005: Writing xlsx files, including streaming writes.
- OOS-006: Timers, intervals or background polling inside DAG modules.
- OOS-007: New routes, roles, audit trails or authorization models for refresh.
- OOS-008: Changes to scoring logic, weights, filter semantics or opener content.
- OOS-009: Sharing a snapshot across worker processes or pods.

---

## Open Questions

Technical questions for architecture (not business clarifications):

1. Where warmup hooks in: a host lifecycle point, DAG registration/load, or lazily on first request (technical approach TBD).
2. The exact shape of the staleness/error indicator in response meta, within the constraint that existing output contracts stay unchanged apart from this additive field (technical approach TBD).
3. Where the snapshot holder lives so that it survives per-revision module re-imports safely (technical approach TBD).
4. Whether framework/host changes are needed at all, or whether the work fits entirely in @fuguejs/xlsx, @fuguejs/document-source and fugue-dags (technical approach TBD).

---

## Dependencies

- SharePoint metadata lookups for the 10 source files (change identifier, or last-modified time plus size).
- Existing /score-leads authorization.
- The existing lockstep release pipeline for @fuguejs packages, with the tag push made by the user.
- The published contract package for lead-scoring and lead-opener outputs (unchanged).
- The existing benchmark scripts and baseline measurements.

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| New reader diverges from today's parser on an edge-case cell type | High | Differential test on all fixtures and the real workbooks before release |
| Recompute still exceeds 150 MB after streaming | High | Measure early. Fall back to an out-of-host compute (currently out of scope) only if needed |
| Module re-import per revision duplicates or leaks snapshots | Med | Make the re-import behaviour an explicit test case |
| Stale data is served longer than expected after an upload | Low | Refresh flag plus a bounded freshness window |
| Cold start with a broken workbook leaves the feature unavailable | Med | Clear typed error naming the file, and a retry on every check |
| Measured snapshot size exceeds 60 MB | Med | CI budget catches it. Revisit representation or OOS-002 |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Snapshot | The precomputed, process-local, in-memory scored lead set (about 25k leads) plus the per-lead facts that both DAGs serve from |
| Fingerprint | The identity of the snapshot inputs: each of the 10 source files' change identifier (or last-modified time plus size) together with the as-of month |
| As-of month | The calendar month that lead recency is quantized to. A new month invalidates the snapshot |
| Freshness window | The minimum interval (default 60 s, configurable) between metadata-only checks of the sources, per worker process |
| Recompute | Rebuilding the snapshot from the source workbooks: signal indexes first, then Brancheliste streamed into scoring |
| Single-flight | At most one recompute runs at a time per worker process, and other callers share its outcome |
| Stale-while-revalidate | Serving the previous snapshot while a new one is built, then swapping atomically |
| Last good snapshot | The most recent snapshot built successfully, kept in service when a later recompute fails |
| Staleness/error indicator | A signal in response meta telling callers that the served snapshot is stale because of a failed refresh |
| Brancheliste | The largest source workbook (about 25k rows), which provides the candidate lead population |
| Scoringsmodel | The source workbook holding the scoring weights and scaling sheets |
| Signal indexes | The 9 small lookup tables derived from the non-Brancheliste source workbooks and used during scoring |
| Per-request transient | Memory allocated while serving one request, above the pre-request level |
| Process baseline | Worker process RSS before the recompute starts |
| Reference parser | The current full-load spreadsheet library, kept development-only for differential comparison |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-11-09 | Initial draft from brainstorm and orchestrator-run interview | Claude (specify) |
| 2026-11-10 | Split into per-repository specs (fugue / fugue-dags); requirement text unchanged | Claude (orchestrator) |
