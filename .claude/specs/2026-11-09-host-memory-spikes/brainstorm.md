# Brainstorm Summary

**Building:** Remove fugue-host's memory spikes (up to 2 GB) on the direct-sales DAGs (lead-scoring, lead-opener). The source workbooks change rarely and only by manual update, so the scored index is computed once per input change rather than on every request. Every request reads a precomputed in-memory snapshot. The recompute is built on a new streaming @fuguejs/xlsx reader so that recompute itself never spikes. Measured baseline: a cold lead-scoring run peaks at 1.25 GB, or 1.49 GB with the checkpoint writer. 5 concurrent warm runs take the host from 719 MB to 1652 MB. Brancheliste through parseWorkbook peaks at about 570 MB.

**Approach:** An in-host, fingerprint-keyed scored-index snapshot with stale-while-revalidate freshness, fed by a streaming xlsx parser. One snapshot per worker process, recomputed in the background with single-flight when a throttled metadata check sees a source fingerprint change. Requests return only small slices.

## Confirmed decisions
1. **Compute once per input change.** The scored index (about 25k leads) is derived once per distinct set of source inputs. Requests read the snapshot and never re-read, re-parse or re-score the workbooks.
2. **Everything stays in fugue-host, made as efficient as possible.** No separate compute runner, OpenShift CronJob, secrets or Argo manifest.
3. **No database.** The snapshot lives in memory, one per worker process. It is keyed by a fingerprint made of the 10 source files' eTag (or lastModified+size) plus the asOf month, because recency is quantized monthly. A restart means a recompute. This is accepted on the condition that the footprint is small (tens of MB). The footprint budget is a success criterion.
4. **Freshness through a throttled check on fetch.**
   - A request triggers a metadata-only check (`getMetadata`, no downloads) at most once per window, about 60 s by default and configurable.
   - If any fingerprint changed, a background recompute starts. It is single-flight, so only one recompute runs at a time per process.
   - Requests keep getting the previous snapshot until the new one is swapped in atomically (stale-while-revalidate).
   - The snapshot is warmed at startup or on first load of the DAG.
   - An explicit refresh trigger (for example a refresh route or DAG) forces a check and recompute right after a workbook is uploaded.
   - No `setInterval` or other background timers in DAG modules. Modules are re-imported per SHA via `import(path?v=sha)`, so timers would leak.
5. **Streaming xlsx is required.**
   - `parseWorkbook` in @fuguejs/xlsx moves from SheetJS full-load to a real streaming reader: `fflate` for incremental unzip, `saxes` for SAX parsing, sharedStrings, styles.xml for date detection, and per-row Zod validation as rows stream.
   - The `parseWorkbook` contract stays exactly as it is.
   - A new streaming/row-callback form is added. The recompute uses it to build the 9 small signal indexes first, then stream Brancheliste rows straight into `scoreLead` without ever materializing its 25k raw rows.
   - SheetJS stays only as a dev dependency, used as a reference to check the new parser's output against.
   - A memory regression benchmark is added.
6. **Small per-request outputs.**
   - `/score-leads` returns the filtered and capped slice (`accountManager`, `minScore`, `limit`, as in `applyFilters` in lib/scoring-model.ts).
   - lead-opener gets one lead's facts by CVR from the snapshot.
   - The 10 source nodes leave the request path, which removes the 21 MB fan-in and about 29 MB of checkpoint JSON per run.
   - The output contracts for lead-scoring and lead-opener (fugue-dags lib/contract.ts, packages/contract) stay unchanged.
   - The Scoringsmodel double parse is fixed: the weights and scaling sheets come from one read.
7. **Dropped:** the per-node checkpoint opt-out in the framework and host. With small outputs it is no longer needed.
8. **Versioning.**
   - All @fuguejs packages are bumped together to 0.6.0. The user pushes the `v0.6.0` tag.
   - Local builds are used during development.
   - After the release, fugue-dags is pinned to 0.6.0 and the peak-RSS benchmarks are re-run for before/after numbers. The benchmark scripts are bench2.ts, sources.ts and parse.ts in /private/tmp/claude-502/-Users-hansen142-dev-agentic-fugue/58e58967-5556-40e1-963d-131a1747c592/scratchpad/.

## Key Constraints
- **The `parseWorkbook` contract stays exactly as it is.** That covers:
  - the signature and the `Result<{ rows }, FrameworkError>` shape
  - non-ZIP bytes (missing PK magic) giving a non-retriable node-crash
  - a missing sheet, by name or 1-based index, giving a node-crash
  - `headerRow` handling
  - blank header columns being skipped, and duplicate headers giving a node-crash
  - prototype-free row objects
  - `normalizeCell` semantics: formula gives the cached result, rich text and hyperlinks give text, dates stay `Date`, error cells become null
  - all-empty rows, including rows made only of error cells, being skipped
  - `validation` errors naming the row
  - deterministic and concurrency-safe behaviour under Bun
- **Memory budgets are success criteria and must be verified by benchmark.**
  - Recompute peak: well under 100 MB. This is an estimate until measured.
  - Steady-state snapshot: small, tens of MB.
  - Per-request transient: small.
  - None of these is a regression versus the baseline above.
- **Snapshot identity.** The key is the 10 source fingerprints (eTag, or lastModified+size) plus the asOf month. A swap is atomic. Readers never see a partially built snapshot.
- **Single-flight recompute per process.** Concurrent requests during a recompute are served the previous snapshot. When no snapshot exists yet (cold start), they wait on the in-flight build.
- **No timers in DAG modules.** Module-scope state persists across SHAs because relative lib imports are shared under `import(path?v=sha)`. The snapshot holder must tolerate that: no leaked intervals, and the state is safe to share across SHAs.
- **FC/IS.** Building the signal indexes and scoring stay pure. Fingerprinting, the throttle, single-flight, the snapshot holder and I/O live in the shell. Errors cross the boundary as `Result`.
- **One host image serves all tenants** (thin-init, supervisor, per-tenant workers). The snapshot is per worker process. Other tenants' DAGs must be unaffected.
- **The 0.6.0 release is user-gated** (tag push, lockstep enforced by release.yaml). Until then fugue-dags stays on 0.5.1 from npm, except for local development builds.

## In Scope
- **@fuguejs/xlsx**
  - a streaming `parseWorkbook` (fflate + saxes, sharedStrings, styles-based date detection, workbook and rels mapping from sheet name or index to a path, per-row validation)
  - a streaming/row-callback API
  - multi-sheet reading from one load, for the Scoringsmodel weights and scaling sheets
  - SheetJS demoted to a dev dependency
  - a differential test against SheetJS on fixtures and on the real data files
  - a memory regression benchmark with a peak-RSS budget
- **fugue-dags**
  - a process-level scored-index snapshot: fingerprint key, throttled metadata check (default 60 s, configurable), single-flight background recompute, atomic swap, stale-while-revalidate
  - warmup at startup or on first load
  - an explicit refresh trigger
  - lead-scoring and lead-opener restructured so the request path reads the snapshot and outputs only small slices, with output contracts unchanged
  - the recompute streams Brancheliste into `scoreLead` after building the 9 signal indexes
  - the Scoringsmodel single-read fix
  - tests, and READMEs and `fugue describe` output updated
- **Release and measurement**
  - lockstep bump to 0.6.0
  - local builds during development, then fugue-dags pinned to 0.6.0
  - before/after peak-RSS benchmarks re-run and recorded: cold run, 5 concurrent warm runs, recompute peak, steady-state snapshot size, per-request transient

## Out of Scope
- **Per-node checkpoint opt-out** in the framework or host (old D2). It was dropped because small outputs make it unnecessary.
- **A separate compute worker or runner, OpenShift CronJob, secrets or Argo manifest.** These are reintroduced only if measurement shows in-host recompute can't meet the memory budget, for example if the recompute peak stays well above the target after the streaming parser.
- **Persisting the snapshot to Redis, MySQL or any database.** Reconsidered only if the measured steady-state snapshot footprint turns out not to be small.
- **Background timers or polling inside DAG modules.**
- **Changes to `maxConcurrent`, host worker memory limits, Redis checkpoint compression or TTLs, or Zod output and fan-in re-validation in run-node.ts.**
- **xlsx writing or streaming writes.** ExcelJS remains test-only.

## Open Questions
- Does startup warmup need a host lifecycle hook, or can it be lazy, on first request or on DAG registration/load?
- How is the refresh trigger exposed (a route, a dedicated DAG, an admin endpoint), and how is it authorized in the multi-tenant host?
- What are the exact numeric budgets: recompute peak (target well under 100 MB), steady-state snapshot size, and per-request transient?
- What happens when a changed workbook fails to parse or validate? Proposed: keep serving the last good snapshot and surface the error (log, metric or health signal). What if no good snapshot exists yet?
