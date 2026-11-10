# Plan: Eliminate fugue-host Memory Spikes from the Direct-Sales DAGs

**Spec:** /Users/hansen142/dev/agentic/fugue/.claude/specs/2026-11-09-host-memory-spikes/spec.md
**Created:** 2026-11-09

## Summary

Two changes, in two repos. In fugue, `@fuguejs/xlsx` replaces the SheetJS full-load parser with a streaming reader built on fflate and saxes. It reads the ZIP central directory, streams the inflated sheet XML and replicates SheetJS cell semantics exactly. It adds `openWorkbook` (one load, many sheets) and `foldRows` (row streaming) beside the unchanged `parseWorkbook`. In fugue-dags, both direct-sales DAGs stop re-reading the ten workbooks on every request. They serve from a process-local, fingerprinted, in-memory lead snapshot owned by a module-scope holder. The holder's behaviour (single-flight, stale-while-revalidate, last-good, 60 s throttled metadata check) is a pure typed reducer, warmed lazily by the first request to either DAG.

**Repositories.** This plan spans two repos on branch `fix/host-memory-spikes`:
- **fugue** is the Loom project root (`/Users/hansen142/dev/agentic/fugue`). Its paths are written repo-relative, e.g. `packages/xlsx/src/index.ts`.
- **fugue-dags** lives at `/Users/hansen142/dev/agentic/fugue-dags`. Every path that starts with `fugue-dags/` is relative to that root, so `fugue-dags/lib/sources.ts` means `/Users/hansen142/dev/agentic/fugue-dags/lib/sources.ts`.

---

## Architectural Decisions

### AD-1: In-host snapshot owned by fugue-dags, warmed lazily (Approach A)

**Choice:** The scored lead snapshot is DAG-local code in fugue-dags (`fugue-dags/lib/lead-snapshot/`), shared by lead-scoring and lead-opener through one module-scope holder per worker process.
- **Warmup is lazy.** The first request to either DAG builds the snapshot (FR-015 is a SHOULD), and every concurrent cold request joins that one in-flight build (FR-011).
- **No framework or host changes.** `@fuguejs/document-source` only gets a doc-comment correction (AD-4).

**Why:**
- The memory result is the same for all three candidates. Memory inside fugue-host is the primary axis and simplicity is the secondary one, and A is the smallest design that meets every requirement without touching the shared multi-tenant host.
- No host lifecycle hook exists. `DagRegistration` is `{ dag, inputSchema, route, config, meta }`, and capabilities (`documents`, `clock`) only exist inside a node invocation, so warmup before the first request would need a host change.
- Workers are spawned lazily and evicted when idle (ADR-0070). For a non-pinned tenant, "startup" is the first request anyway.
- The holder can be extracted into a generic primitive later, if a second DAG needs one.

**Rejected:**
- B: a generic `createDocumentSnapshot` primitive in `@fuguejs/document-source`. It adds a public API surface to design and maintain for a single consumer, and it couples the fugue-dags snapshot to the framework release cadence. There is no memory benefit over A.
- C: a host-managed derived dataset with a `DagRegistration` warmup hook. It would give true startup warmup, but it changes the host contract in the shared multi-tenant host (ADR-0033) and raises capability-broker authority questions for a build at hook time. It is also the largest effort, and idle-evicted workers would still rebuild on respawn.

### AD-2: Streaming xlsx reader with central-directory random access and exact SheetJS semantics

**Choice:** `@fuguejs/xlsx` reads the workbook bytes, which are already in memory as a `Uint8Array` from `getContent`.

Load sequence:
- Parse the ZIP central directory and inflate entries in any order: `workbook.xml`, `workbook.xml.rels`, `styles.xml` and `sharedStrings.xml` first.
- Then stream the selected sheet's XML: compressed slices go through fflate `Inflate`, then `TextDecoder` (stream mode), then saxes, then a row assembler. Each completed row is projected through the header map, validated with Zod, and handed to a fold step.
- Only the decompressed sheet XML is streamed. The 2.1 MB compressed input is kept as-is.

Public surface:
- `openWorkbook(bytes)` does the one-time load and returns an opaque, immutable `WorkbookHandle`. Shared strings and styles are loaded eagerly once per handle, so several sheets cost one load (FR-022, FR-040, AS-016).
- `foldRows(handle, schema, opts, init, step)` is the row-streaming form (FR-039).
- `parseWorkbook(bytes, schema, opts)` is now `openWorkbook` followed by a collecting `foldRows`. Its signature, `Result` shape, error kinds, retriability and messages are unchanged (FR-030 to FR-037).
- `foldRows` is async and cooperative: it yields to the event loop (`await` of a resolved macrotask via `setImmediate`, not a timer) after every N KiB of compressed input. This keeps a running recompute from stalling requests that are served from the old snapshot.

The reader must reproduce SheetJS 0.18.5 behaviour (`XLSX.read(buf, { type: "buffer", cellDates: true })`). These semantics are frozen and decided by the differential test:
- **Dates.** Detection follows the number format: built-in format ids 14–22, 27–36, 45–47 and 50–58, plus custom format strings through a port of SheetJS `SSF.is_date`. Serial-to-`Date` conversion ports SheetJS `numdate`, which depends on the local time zone, has the 1900 leap-year bug for serials ≤ 60, and honours `workbookPr date1904`.
- **Strings.** Shared strings, inline strings (`t="inlineStr"`) and formula strings (`t="str"`) are supported. Rich-text runs are concatenated, phonetic `rPh` runs are excluded, and `_xHHHH_` escapes are decoded.
- **Other cell types.** Booleans (`t="b"`) are supported. Error cells (`t="e"`) become `null`. Formula cells use their cached `<v>` and are never evaluated.
- **Row range.** Comes from `<dimension ref>` merged with the observed cells exactly as SheetJS `parse_ws_xml` does. Rows and cells with no `r` attribute advance implicitly.
- **Sheet selection.** By exact name, or by 1-based index in `workbook.xml` `<sheets>` order resolved through the rels.
- **Rows.** Row objects are prototype-free. Blank header columns are skipped, a duplicate header is a node-crash, and all-empty or all-error rows are skipped.
- **Errors.** The validation message stays `row <n>: <zod message>`. A new exported helper `xlsxErrorRow(e)` recovers `<n>` from errors this module minted.

**Why:**
- SheetJS full-load peaks at about 570 MB on Brancheliste. A SAX stream over inflated chunks bounds memory to the shared-strings table plus one row.
- The input bytes are already resident, so random access through the central directory is free. That avoids the "sharedStrings comes after the sheet" ordering problem of a forward-only unzip.
- Replicating SheetJS (rather than "fixing" its time-zone quirk) is the only way to meet AS-009 parity. Production containers run in UTC, and the differential test pins `TZ`.

**Rejected:**
- Forward-only streaming unzip (fflate `Unzip`). Shared strings can appear after the sheet in the archive, which would force buffering the sheet XML and defeat the purpose.
- ExcelJS streaming reader. It is non-deterministically broken under Bun (shared global state, see the existing `packages/xlsx/src/index.ts` header) and is heavy.
- SheetJS with lean options (`dense`, no `cellNF` or `cellText`). It still materializes the whole sheet, and it misses the 100 MB parse budget.
- A row `AsyncIterable` instead of a fold. A fold keeps backpressure and accumulation inside one call, has no consumer-abandonment cleanup path, and composes with pure step functions.

### AD-3: Runtime dependencies fflate and saxes; SheetJS, ExcelJS and JSZip become dev-only

**Choice:** `@fuguejs/xlsx` `dependencies` become `@fuguejs/framework`, `fflate` (^0.8.2) and `saxes` (^6.0.0).
- `xlsx` (SheetJS 0.18.5), `exceljs` and `jszip` move to `devDependencies`. SheetJS is used only as the differential oracle (`packages/xlsx/src/__tests__/support/sheetjs-oracle.ts` and `*.test.ts`). ExcelJS and JSZip are only used to build test fixtures.
- INV-1 enforces the SheetJS prohibition on every edit.

**Why:**
- Both packages are small, have zero dependencies and ship ESM with types.
- fflate gives synchronous chunked inflate with no native code. saxes is a strict, well-formed XML SAX parser that is safe on hostile input (no entity expansion).
- Today exceljs and jszip are runtime dependencies only by accident, and they inflate every DAG image that installs `@fuguejs/xlsx`.

**Rejected:**
- `node:zlib` streaming inflate. It is Bun-compat sensitive and asynchronous per chunk, which complicates the deterministic fold.
- `sax` (the original package). It is less strict and less maintained than saxes.
- A hand-written XML tokenizer. That is new untested parsing code on a hostile-input boundary.

### AD-4: Snapshot lifecycle as a pure typed reducer; module-scope holder; detached background recompute

**Choice:**
- **The reducer.** The holder's behaviour is a pure reducer `transition(state, event, now) → { state, effects }` over closed unions in `fugue-dags/lib/lead-snapshot/lifecycle.ts`. It covers single-flight, stale-while-revalidate, last-good, the throttle, the month rollover and refresh. Its laws are checked by fast-check property tests.
- **The shell.** `fugue-dags/lib/lead-snapshot/holder.ts` is a thin shell that interprets the effects (start a check, start a build) and keeps one settle promise per in-flight activity.
- **One holder per process.** The singleton lives at the module scope of `holder.ts`. `dag.ts` is imported as `?v=<sha>`, but `lib/` imports resolve to plain absolute paths that Bun caches once per worker, so the holder survives revision re-imports with no duplicate state (FR-021, FR-052, AS-027). A dedicated test imports `dag.ts?v=a` and `?v=b` and asserts one holder and one build.
- **No timers.** Freshness is driven by `ctx.clock.now()` on incoming requests (FR-020).
- **Detached recompute.** A recompute is detached from the triggering request. It never receives the request's `AbortSignal`, it outlives the run timeout, and every rejection becomes a `build-failed` event, never an unhandled rejection (NFR-021). Cold requests await the shared in-flight build. If a request times out (lead-opener's `timeoutMs` is 30 s), only that request fails; the build continues and later requests get it.
- **Trust assumption, documented in the READMEs and the ADR.** The recompute uses the `DocumentSource` client of the request that triggered it, and the resulting snapshot is served to every caller of that tenant's worker. This is correct while SharePoint reads use app-only authority, as they do in production today. If `documents` were ever minted per user identity (ADR-0053), the snapshot would leak one caller's read authority to others, and this design would have to be revisited.
- **Stale doc comment.** `createCachedDocumentParser`'s doc comment wrongly claims "module cache-busting on deploy gives a fresh memo per code version". It is corrected to describe the real behaviour: lib and package modules are shared across `?v=sha` re-imports, and `lib/` changes take effect on worker restart.
- **Why this lifecycle is not declared under `## Lifecycles`.** The reducer is a real lifecycle, but its machine file lives in fugue-dags. Loom machine-file paths must be relative to the fugue repo and are bound against fugue's task file lists and Wave Gate. A cross-repo machine file cannot be bound validly. The reducer is therefore specified fully under Component Design ("Snapshot lifecycle reducer") and gets its own task with property tests, in place of a Loom lifecycle declaration. For the same reason no invariant or contract is declared for fugue-dags files.

**Why:**
- The reducer is where every concurrency rule lives. Making it pure makes single-flight, last-good and atomic swap provable with property tests and no mocks.
- The shell only maps effects to I/O.
- Module scope is the simplest correct placement given how the host's module loader re-imports DAG modules.

**Rejected:**
- A `globalThis` registry keyed by `Symbol.for(...)`. It is robust to future lib cache-busting, but a schema-version bump orphans the old holder in memory.
- A host-provided per-worker state capability. That is a framework and host change, for the same reasons as AD-1 option C.
- An ad-hoc closure with mutable flags. Single-flight and last-good would only be testable through timing-sensitive integration tests.

### AD-5: Leads contract 0.5.0, an additive `refresh` input and an always-present `meta.snapshot`

**Choice:** `@oister-flexii/fugue-leads-contract` goes from 0.4.0 to 0.5.0, with additive changes only.
- `ScoreLeadsInputSchema` gains `refresh: z.boolean().optional()`.
- `ScoreLeadsOutputSchema.meta` gains `snapshot: SnapshotMetaSchema.optional()`:
  - `{ fingerprint, builtAt, asOfMonth, status: "fresh" | "stale", staleReason? }`
  - `staleReason` is `{ kind: "recompute-failed" | "check-failed", source?, row?, since }`.
- `select-leads` always emits `meta.snapshot`. lead-opener gets no indicator, and `OpenerOutputSchema` is unchanged.
- Publishing 0.5.0 means running `publish-contract.yml` in fugue-dags. Like the fugue tag push, that is gated on the user.

**Why:**
- Zod `z.object` strips unknown keys, so the field must be in the schema or host output validation silently drops it.
- An optional field keeps existing lead-desk consumers source- and wire-compatible (FR-005).
- Always emitting the field lets a caller show the snapshot's age even when it is fresh.

**Rejected:**
- Emitting `meta.snapshot` only when stale. The absence of a field is a weaker signal than an explicit `status: "fresh"`.
- An indicator on lead-opener too. The user declined it, and `OpenerOutput` has no `meta`.
- A new `/refresh` route. FR-017 and NFR-010 forbid new routes.

### AD-6: Release flow: lockstep 0.6.0, local links during development, user-gated tags

**Choice:**
- All nine published `@fuguejs/*` packages go from 0.5.1 to 0.6.0 in lockstep, together with the matching workspace `version` fields in `bun.lock`. `release.yaml` refuses stale workspace pins.
- During development, fugue-dags consumes the local fugue workspace through `bun link`. All six consumed packages are linked (`framework`, `document-source`, `xlsx`, `fs`, `host`, `ms-graph`) so there is exactly one framework copy. This happens only after the baseline benchmark has been recorded against npm 0.5.1.
- The fugue-dags branch is not merged while it carries `link:` specifiers.
- The user pushes `v0.6.0` (fugue) and runs `publish-contract.yml` for contract 0.5.0 (fugue-dags). Only then does the final task pin fugue-dags to `0.6.0` and `0.5.0`, reinstall, re-run every test, and re-run the benchmarks for the after column of the report.

**Why:**
- FR-060, FR-061 and AS-036 require this.
- Lockstep is already enforced by `release.yaml`.
- Linking every consumed package avoids two `@fuguejs/framework` copies coexisting at runtime.

**Rejected:**
- `file:` dependencies on the fugue packages. The packages' own `workspace:*` dependencies do not resolve outside the monorepo.
- Publishing a 0.6.0 prerelease to npm. That needs a tag push, which the user reserves.
- Bumping only `@fuguejs/xlsx`. That breaks lockstep and the release workflow refuses it.

### AD-7: Memory budgets: per-request scope, real-data local acceptance, synthetic CI regression

**Choice:**
- **Per-request budget scope.** The ≤ 10 MB per-request budget (AS-003, NFR-004, SC-004) applies to filtered or limited requests. The benchmark uses `{ limit: 50 }` and `{ accountManager }`. An unfiltered `/score-leads` request keeps today's contract and returns all of about 25.6k leads, roughly 21 MB of JSON. It is documented as exempt in the lead-scoring README and the ADR. Lead selection stops early once `limit` matches are found.
- **Acceptance bar.** The real-workbook SheetJS differential (SC-007) and the real-data budget benchmarks (SC-001 to SC-006) run locally against the real files. They are opt-in through `FUGUE_REAL_DATA_DIR` and skip cleanly when it is absent. This local run is the acceptance bar, and it feeds the before/after report.
- **CI.** CI keeps deterministic synthetic fixtures: a generator for a workbook shaped like Brancheliste (about 25.6k rows with shared strings, styles, dates, formulas, errors, rich text and `_xHHHH_`) plus the other nine shapes. They drive the parser differential, parity and regression tests, and cheap synthetic peak-RSS budget assertions.
- **No new work in `sharepoint-live.yml`.**

**Why:**
- The real workbooks are gitignored business data (`fugue-dags/.gitignore`: `data/`). They can never be in either repo's CI.
- Today's contract returns every lead when there is no filter. Capping it would break FR-003 and FR-005.
- Synthetic budgets in CI still catch regressions cheaply. The real data decides acceptance.

**Rejected:**
- A default or maximum `limit`. That changes contract behaviour (FR-003, FR-005).
- Committing anonymized real-shaped fixtures. It is a data-governance risk and adds little over a generator.
- Real-data runs in `sharepoint-live.yml`. The user declined.

### AD-8: Observability: structured snapshot log events, `meta.snapshot` and a reads witness

**Choice:**
- **Log events.** A pure `SnapshotLogEvent` ADT is rendered to one-line JSON by `renderSnapshotLog` and written through the triggering request's `ctx.logger`. `Logger` only has `warn` and `error`, so routine events go through `warn` with `"level":"info"` in the payload, and failures go through `error`. The events are:
  - `lead-snapshot.check`: trigger, duration, outcome `unchanged | changed | failed`, the changed source file names.
  - `lead-snapshot.recompute.started`: trigger `cold | changed | month | refresh`, build id.
  - `lead-snapshot.recompute.succeeded`: duration, row counts per source, lead count, fingerprint, RSS before and after, heap used.
  - `lead-snapshot.recompute.failed`: duration, failing source file name, row, error kind, issue path.
- **No lead data in logs (NFR-011).** No CVRs, names or cell values are logged, and the raw Zod message is not logged.
- **GlobalConnect diagnostics.** `globalConnectWarning` moves from every request to once per recompute.
- **Snapshot identity.** Callers see it through `meta.snapshot`. Run telemetry sees it through the `select-leads` and `lookup-lead` nodes' `sideEffects: { kind: "reads", resource: resourceName("lead-snapshot"), extractWitness }`, which emits `witnessValue("etag", fingerprint)`.
- No new metrics pipeline and no OTel spans.

**Why:**
- These use only existing channels: the node logger, the response meta and the witness events (ADR-0025).
- A pure log ADT keeps the content testable and keeps lead data out by construction.

**Rejected:**
- An OTel span around the recompute, and application metrics. The user declined both.
- Adding `info` to the framework `Logger`. That is a cross-cutting framework change outside this feature's scope.

---

## File Structure

### @fuguejs/xlsx: streaming reader (fugue)

```
packages/xlsx/package.json                                  — deps: fflate, saxes; SheetJS/exceljs/jszip → devDependencies; version 0.6.0 (bump in release task)
packages/xlsx/src/index.ts                                  — public surface: parseWorkbook (unchanged contract), openWorkbook, foldRows, xlsxErrorRow, normalizeCell, types
packages/xlsx/src/zip.ts                                    — ZIP central-directory reader over in-memory bytes; streaming entry inflate (fflate Inflate) with cooperative yield
packages/xlsx/src/xml.ts                                    — tiny saxes wrappers: parse a small part to a value; streaming feed for the sheet
packages/xlsx/src/workbook-parts.ts                         — workbook.xml (sheet order, names, rIds, date1904) + rels → sheet path resolution (pure)
packages/xlsx/src/shared-strings.ts                         — sharedStrings.xml → readonly string[] (rich runs joined, rPh excluded, _xHHHH_ decoded)
packages/xlsx/src/styles.ts                                 — styles.xml numFmts + cellXfs → isDateStyle(styleIndex) (built-in ids + SSF.is_date port)
packages/xlsx/src/cell-value.ts                             — pure raw cell (t, v, inline text, style) → primitive | Date | null; SheetJS numdate port; _xHHHH_ decoder
packages/xlsx/src/sheet-stream.ts                           — saxes-driven row assembler (r/implicit addressing, dimension tracking) → RawRow callbacks
packages/xlsx/src/rows.ts                                   — pure header map + row projection (null-proto, blank skip, duplicate header) + validation step
packages/xlsx/src/__tests__/xlsx.test.ts                    — existing contract tests (kept, must stay green unchanged)
packages/xlsx/src/__tests__/date-group-item.test.ts         — existing (kept)
packages/xlsx/src/__tests__/end-to-end.test.ts              — existing (kept)
packages/xlsx/src/__tests__/cell-value.property.test.ts     — fast-check: numdate port, _xHHHH_ round-trip, date-format detection table
packages/xlsx/src/__tests__/zip.test.ts                     — central directory, non-ZIP → crash, entry inflate chunking
packages/xlsx/src/__tests__/stream-api.test.ts              — openWorkbook/foldRows: multi-sheet one load, optional-sheet probing, fold order, concurrency determinism, yielding
```

### @fuguejs/xlsx: differential oracle, fixtures, benchmark (fugue)

```
packages/xlsx/src/__tests__/support/sheetjs-oracle.ts       — reference parse via SheetJS (dev-only; the ONLY non-test file allowed to import it, INV-1)
packages/xlsx/src/__tests__/support/fixtures.ts             — deterministic synthetic workbook generators (Brancheliste-shaped 25.6k rows + 9 source shapes + edge-case cell matrix)
packages/xlsx/src/__tests__/parity.test.ts                  — differential: new reader vs SheetJS on every fixture, TZ pinned (AS-009, AS-014, AS-017)
packages/xlsx/src/__tests__/real-data.local.test.ts         — differential on the real workbooks under FUGUE_REAL_DATA_DIR (skips when unset)
packages/xlsx/bench/parse-memory.ts                         — peak-RSS benchmark (synthetic always; real Brancheliste when FUGUE_REAL_DATA_DIR set); prints value vs budget, exits non-zero on breach
packages/xlsx/src/__tests__/memory-budget.test.ts           — CI: spawns bench on the synthetic Brancheliste, asserts ≤ 100 MB
packages/xlsx/README.md                                     — streaming API, SheetJS-semantics note, budgets
```

### Release prep and docs (fugue)

```
packages/*/package.json (9 published packages)              — version 0.5.1 → 0.6.0 lockstep
bun.lock                                                    — workspace version fields → 0.6.0
packages/document-source/src/index.ts                       — correct createCachedDocumentParser doc comment (module sharing across ?v=sha)
packages/document-source/docs/llm-document-source.md        — document openWorkbook/foldRows for large workbooks; snapshot pattern pointer
docs/adr/README.md                                          — index entries for the new ADRs (ADR tasks)
```

### Leads contract 0.5.0 (fugue-dags)

```
fugue-dags/packages/contract/src/index.ts                   — ScoreLeadsInputSchema.refresh?, SnapshotMetaSchema, ScoreLeadsOutputSchema.meta.snapshot?
fugue-dags/packages/contract/package.json                   — 0.4.0 → 0.5.0
fugue-dags/packages/contract/src/__tests__/leads.test.ts    — additive-compat tests (0.4.0-shaped payloads still parse; refresh/snapshot round-trip)
```

### Snapshot lifecycle and holder (fugue-dags)

```
fugue-dags/lib/lead-snapshot/lifecycle.ts                   — pure reducer: SnapshotState<S>, SnapshotEvent<S>, SnapshotEffect, transition, serveDecision
fugue-dags/lib/lead-snapshot/fingerprint.ts                 — pure: SourceFingerprint, SnapshotFingerprint (branded), AsOfMonth, fingerprintOf, monthOf
fugue-dags/lib/lead-snapshot/log.ts                         — pure SnapshotLogEvent ADT + renderSnapshotLog
fugue-dags/lib/lead-snapshot/holder.ts                      — shell: createLeadSnapshotHolder, module-scope leadSnapshotHolder, effect interpreter, settle promises
fugue-dags/lib/lead-snapshot/__tests__/lifecycle.property.test.ts — fast-check laws (single-flight, last-good, throttle, id-gating, refresh, month)
fugue-dags/lib/lead-snapshot/__tests__/fingerprint.test.ts  — eTag vs lastModified:size, fileRefKey inclusion, order independence, month change
fugue-dags/lib/lead-snapshot/__tests__/holder.test.ts       — fake check/build: single-flight under concurrency, SWR, cold wait, cold failure typed error, abort/timeout detachment
```

### Snapshot data, selectors and recompute (fugue-dags)

```
fugue-dags/lib/scoring-model.ts                             — extract parseMasterRow + buildBrancheByCvr (parseMaster reuses them; behaviour identical)
fugue-dags/lib/lead-snapshot/snapshot.ts                    — LeadSnapshot type + pure selectLeads (early stop), lookupLead (first-wins), summarize
fugue-dags/lib/lead-snapshot/recompute.ts                   — buildLeadSnapshot: sequential source reads, one-load Scoringsmodel, indexes first, foldRows(Brancheliste) → scoreLead
fugue-dags/lib/lead-snapshot/check.ts                       — checkSources: 10 parallel getMetadata → Result<SourceFingerprints, CheckFailure>
fugue-dags/lib/sources.ts                                   — drop the 10 source nodes, READERS, SourceFanInSchemas; add SOURCE_SPECS table; keep FILE_NAMES, schemas, sheets, docRef
fugue-dags/lib/lead-snapshot/__tests__/snapshot.property.test.ts — selectLeads(sortLeads(xs), f) ≡ applyFilters(xs, f); lookupLead first-wins
fugue-dags/lib/lead-snapshot/__tests__/recompute.test.ts    — synthetic workbooks via fake DocumentSource: parity with legacy pipeline, failures name file/row, optional scaling sheet
fugue-dags/lib/__tests__/domain.test.ts                     — add parseMasterRow/buildBrancheByCvr cases (existing file)
```

### DAG restructure and tests (fugue-dags)

```
fugue-dags/dags/direct-sales/leads/lead-scoring/dag.ts      — single select-leads fetch node (DAG_INPUT → select-leads); refresh flag; meta.snapshot; reads witness
fugue-dags/dags/direct-sales/leads/lead-opener/dag.ts       — lookup-lead fetch node replaces 10 sources + score-one-lead; generate-opener/assemble-opener unchanged
fugue-dags/dags/direct-sales/leads/lead-scoring/README.md   — snapshot behaviour, freshness window env, refresh flag, stale indicator, unfiltered-request budget exemption, trust assumption
fugue-dags/dags/direct-sales/leads/lead-opener/README.md    — snapshot-served facts, cold-build wait vs 30 s timeout
fugue-dags/README.md                                        — local @fuguejs link workflow, FUGUE_REAL_DATA_DIR, benchmark commands
fugue-dags/CLAUDE.md                                        — replace the "multi-root sources → join" lead DAG idiom with the snapshot idiom
fugue-dags/tests/dags.test.ts                               — rewrite removed-design cases (listed in Testing Strategy); new refresh/stale/cold-failure cases
fugue-dags/tests/lead-snapshot-reimport.test.ts             — dag.ts?v=a and ?v=b → one holder, one build
fugue-dags/tests/snapshot-parity.test.ts                    — new DAG outputs ≡ legacy pipeline on synthetic workbooks; real-data variant under FUGUE_REAL_DATA_DIR
```

### Benchmarks and report (fugue-dags)

```
fugue-dags/scripts/bench/sampler.ts                         — RSS peak sampler worker (moved from the session scratchpad)
fugue-dags/scripts/bench/legacy-baseline.ts                 — before numbers: cold run, 5-concurrent warm, checkpoint bytes (from bench2.ts/sources.ts/parse.ts)
fugue-dags/scripts/bench/snapshot-memory.ts                 — after numbers: recompute peak, steady snapshot size, per-request transient ({limit:50},{accountManager}), 5-concurrent, checkpoint bytes; budget check, non-zero exit on breach
fugue-dags/scripts/bench/__tests__/budgets.test.ts          — pure budget evaluation (value vs budget → named breach)
fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md    — before/after report (baseline, after-on-links, after-on-0.6.0)
fugue-dags/package.json                                     — bench scripts; @fuguejs/* → link (dev) → 0.6.0 (final); contract → 0.5.0
fugue-dags/bun.lock                                         — lockfile updates
```

---

## Component Design

### Streaming workbook reader

**Responsibility:** Turn in-memory `.xlsx` bytes into Zod-validated rows with bounded memory and SheetJS-identical semantics.
**Files:** `packages/xlsx/src/index.ts`, `zip.ts`, `xml.ts`, `workbook-parts.ts`, `shared-strings.ts`, `styles.ts`, `cell-value.ts`, `sheet-stream.ts`, `rows.ts`
**Interface:**

```ts
// Unchanged contract (FR-030..FR-037)
export interface ParseWorkbookOpts { readonly sheet?: string | number; readonly headerRow?: number }
export const parseWorkbook: <T>(bytes: Uint8Array, rowSchema: z.ZodType<T>, opts?: ParseWorkbookOpts)
  => Promise<Result<{ rows: readonly T[] }, FrameworkError>>;
export const normalizeCell: (value: unknown) => string | number | boolean | Date | null;

// New
declare const WorkbookBrand: unique symbol;
export interface WorkbookHandle {                       // opaque, immutable; parts loaded once
  readonly [WorkbookBrand]: true;
  readonly sheetNames: readonly string[];               // workbook.xml order
}
export const openWorkbook: (bytes: Uint8Array) => Result<WorkbookHandle, FrameworkError>;
  // non-ZIP / unreadable parts → node-crash, non-retriable (FR-031)
export interface FoldOpts extends ParseWorkbookOpts { readonly yieldEveryBytes?: number } // default 16 KiB compressed (changed from 64 KiB during T1: measured ~13 MB lower peak on the real Brancheliste export; see FoldOpts docs in packages/xlsx/src/index.ts)
export const foldRows: <T, A>(
  workbook: WorkbookHandle, rowSchema: z.ZodType<T>, opts: FoldOpts,
  init: A, step: (acc: A, row: T, rowNumber: number) => A,
) => Promise<Result<A, FrameworkError>>;
  // missing sheet → node-crash (FR-032); row validation → validation "row <n>: …" (FR-037)
export const xlsxErrorRow: (e: FrameworkError) => number | null; // parses this module's own "row <n>:" prefix

// Internal pure core (cell-value.ts, rows.ts)
type RawCell = { readonly t: "s" | "str" | "inlineStr" | "n" | "b" | "e" | "d" | undefined;
                 readonly v: string | null; readonly inline: string | null; readonly style: number };
export const decodeCell: (c: RawCell, ctx: { sst: readonly string[]; isDate: (s: number) => boolean; date1904: boolean })
  => string | number | boolean | Date | null;
export const serialToDate: (serial: number, date1904: boolean) => Date;   // SheetJS numdate port
export const decodeXmlEscapes: (s: string) => string;                    // _xHHHH_
export const buildHeaderMap: (cells: ReadonlyMap<number, unknown>, headerRow: number)
  => Result<ReadonlyMap<number, string>, FrameworkError>;
export const projectRow: (cells: ReadonlyMap<number, unknown>, headers: ReadonlyMap<number, string>)
  => Record<string, unknown> | null;                                     // null = all-empty, skip
```

The fold accumulator is a builder owned by the single `foldRows` call. `step` may push into `acc` for performance, and callers freeze what they return. `parseWorkbook` must keep returning exactly the same `Result` values as today for every existing test. The existing `xlsx.test.ts` must pass without changes.
**Depends on:** none (fflate, saxes, zod peer, `@fuguejs/framework` for `Result` and `FrameworkError`)

### SheetJS differential oracle and fixtures

**Responsibility:** Decide parity between the new reader and SheetJS on synthetic fixtures in CI and on the real workbooks locally.
**Files:** `packages/xlsx/src/__tests__/support/sheetjs-oracle.ts`, `support/fixtures.ts`, `parity.test.ts`, `real-data.local.test.ts`
**Interface:**

```ts
export const oracleParse: <T>(bytes: Uint8Array, schema: z.ZodType<T>, opts?: ParseWorkbookOpts)
  => Result<{ rows: readonly T[] }, FrameworkError>;   // the pre-change SheetJS implementation, verbatim
export const syntheticBrancheliste: (rows: number, seed: number) => Promise<Uint8Array>;
export const syntheticSources: (seed: number) => Promise<Readonly<Record<SourceShape, Uint8Array>>>;
export const edgeCaseWorkbook: () => Promise<Uint8Array>; // formulas, rich text, hyperlinks, dates (built-in + custom fmt,
                                                          // serial ≤ 60, date1904 variant), errors, _xHHHH_, inline/str,
                                                          // sparse r attrs, wrong <dimension>, blank/dup headers, multi-sheet
```

Comparison checks rows, keys, key order, value types and `Date` epoch milliseconds. Both implementations run in the same process with `process.env.TZ` pinned. The suite runs under `TZ=UTC` and again under a non-UTC zone (`Europe/Copenhagen`), so the `numdate` port is proven equal in both.
**Depends on:** none (it runs against the current `parseWorkbook` first, then guards the new reader)

### Snapshot lifecycle reducer

**Responsibility:** Decide, purely, what the holder serves and which I/O it starts, for every request, check outcome and build outcome.
**Files:** `fugue-dags/lib/lead-snapshot/lifecycle.ts`, `fugue-dags/lib/lead-snapshot/fingerprint.ts`
**Interface:**

```ts
type Instant = number;                                   // epoch ms from ctx.clock
type OpId = number & { readonly __brand: "OpId" };        // monotonic per holder
type Trigger = "cold" | "changed" | "month" | "refresh";
type StaleReason =
  | { readonly kind: "recompute-failed"; readonly source: string; readonly row: number | null; readonly since: Instant }
  | { readonly kind: "check-failed"; readonly source: string | null; readonly since: Instant };
type Health = { readonly kind: "fresh" } | { readonly kind: "stale"; readonly reason: StaleReason };
type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly id: OpId; readonly trigger: "window" | "refresh" }
  | { readonly kind: "rebuilding"; readonly id: OpId; readonly trigger: Trigger };
type BuildFailure = { readonly source: string; readonly row: number | null; readonly kind: string; readonly path: string | null };

export type SnapshotState<S> =
  | { readonly kind: "cold" }
  | { readonly kind: "building-cold"; readonly id: OpId; readonly trigger: "cold" | "refresh" }
  | { readonly kind: "failed-cold"; readonly failure: BuildFailure; readonly failedAt: Instant }
  | { readonly kind: "ready"; readonly snapshot: S; readonly fingerprint: SnapshotFingerprint;
      readonly health: Health; readonly checkedAt: Instant; readonly activity: Activity };

export type SnapshotEvent<S> =
  | { readonly kind: "requested"; readonly refresh: boolean }
  | { readonly kind: "check-succeeded"; readonly id: OpId; readonly observed: SnapshotFingerprint }
  | { readonly kind: "check-failed"; readonly id: OpId; readonly source: string | null }
  | { readonly kind: "build-succeeded"; readonly id: OpId; readonly snapshot: S; readonly fingerprint: SnapshotFingerprint }
  | { readonly kind: "build-failed"; readonly id: OpId; readonly failure: BuildFailure };

export type SnapshotEffect =
  | { readonly kind: "start-check"; readonly id: OpId }
  | { readonly kind: "start-build"; readonly id: OpId; readonly trigger: Trigger };

export interface LifecycleConfig { readonly windowMs: number }
export const transition: <S>(state: SnapshotState<S>, event: SnapshotEvent<S>, now: Instant, cfg: LifecycleConfig, nextId: OpId)
  => { readonly state: SnapshotState<S>; readonly effects: readonly SnapshotEffect[] };

export type ServeDecision<S> =
  | { readonly kind: "serve"; readonly snapshot: S; readonly fingerprint: SnapshotFingerprint; readonly health: Health }
  | { readonly kind: "await-activity" }                  // cold build in flight, or refresh joined a check/build
  | { readonly kind: "unavailable"; readonly failure: BuildFailure };
export const serveDecision: <S>(state: SnapshotState<S>, request: { readonly refresh: boolean }) => ServeDecision<S>;

// fingerprint.ts
export type AsOfMonth = string & { readonly __brand: "AsOfMonth" };          // "YYYY-MM", UTC
export type SnapshotFingerprint = string & { readonly __brand: "SnapshotFingerprint" }; // sha256 hex[0..16]
export interface SourceFingerprint { readonly refKey: string; readonly version: string } // fileRefKey + (eTag ?? lastModified:size)
export const monthOf: (now: Instant) => AsOfMonth;
export const fingerprintOf: (sources: readonly SourceFingerprint[], month: AsOfMonth) => SnapshotFingerprint; // order-independent
```

Transition rules. Every rule is a property-test law.
1. `cold` + `requested` emits `start-build(cold)` and moves to `building-cold`. `building-cold` + `requested` starts nothing (FR-011, AS-026).
2. `ready` + `requested{refresh:false}` starts a check only when `now ≥ checkedAt + windowMs` and the activity is `idle` (FR-012, AS-002, AS-020).
3. `ready` + `requested{refresh:true}` with activity `idle` starts a check immediately. With an activity in flight it starts nothing, and the request awaits that activity (AS-028, AS-031).
4. `check-succeeded` with `observed ≠ fingerprint` starts `rebuilding`. The trigger is `month` when only the month part differs, otherwise `changed` (FR-014, AS-021, AS-023). `observed = fingerprint` makes health `fresh`, and `checkedAt = now`.
5. `check-failed` keeps the snapshot, sets health `stale(check-failed)` and `checkedAt = now` (AS-035).
6. `build-succeeded` replaces `snapshot` and `fingerprint` as one value, with health `fresh` (FR-008, AS-024). `build-failed` in `ready` keeps the snapshot and sets `stale(recompute-failed)` (NFR-020, AS-032). The next window's check re-detects the change and retries (AS-033).
7. `build-failed` from `building-cold` moves to `failed-cold`, which serves `unavailable` (FR-019, AS-034). A `requested` event at or after `failedAt + windowMs` retries with `start-build(cold)`.
8. An event whose `id` does not match the current activity or build id is ignored and the state is returned unchanged. That makes late or duplicate results harmless.
9. Single-flight (FR-009, AS-022, SC-010) holds structurally. There is at most one `Activity` in `ready`, and `building-cold` is itself the only activity.

**Depends on:** none

### Snapshot holder (shell)

**Responsibility:** Own the one per-process `SnapshotState<LeadSnapshot>`, interpret reducer effects as detached I/O, and give requests a served snapshot or a typed unavailability.
**Files:** `fugue-dags/lib/lead-snapshot/holder.ts`, `fugue-dags/lib/lead-snapshot/log.ts`
**Interface:**

```ts
export interface SnapshotDeps { readonly documents: DocumentSource; readonly clock: ClockCapability; readonly logger: Logger }
export interface Served<S> { readonly snapshot: S; readonly fingerprint: SnapshotFingerprint; readonly health: Health }
export type SnapshotUnavailable = { readonly kind: "snapshot-unavailable"; readonly failure: BuildFailure };
export interface LeadSnapshotHolder<S> {
  readonly acquire: (deps: SnapshotDeps, req: { readonly refresh: boolean }) => Promise<Result<Served<S>, SnapshotUnavailable>>;
  readonly inspect: () => SnapshotState<S>;            // tests/diagnostics only
}
export const createLeadSnapshotHolder: <S>(cfg: {
  readonly windowMs: number;
  readonly check: (deps: SnapshotDeps) => Promise<Result<SnapshotFingerprint, { source: string | null }>>;
  readonly build: (deps: SnapshotDeps, trigger: Trigger) => Promise<Result<{ snapshot: S; fingerprint: SnapshotFingerprint }, BuildFailure>>;
}) => LeadSnapshotHolder<S>;
export const leadSnapshotHolder: LeadSnapshotHolder<LeadSnapshot>;   // module scope; windowMs from LEAD_SNAPSHOT_FRESHNESS_MS
                                                                       // (Zod-parsed positive int, default 60_000; FR-013) read on first acquire
export const toFrameworkError: (u: SnapshotUnavailable, nodeId: string) => FrameworkError; // node-crash, retriable, names the source file (+ row)

// log.ts
export type SnapshotLogEvent =
  | { readonly event: "lead-snapshot.check"; readonly trigger: "window" | "refresh"; readonly durationMs: number;
      readonly outcome: "unchanged" | "changed" | "failed"; readonly changedSources: readonly string[] }
  | { readonly event: "lead-snapshot.recompute.started"; readonly trigger: Trigger; readonly buildId: number }
  | { readonly event: "lead-snapshot.recompute.succeeded"; readonly durationMs: number; readonly rows: Readonly<Record<string, number>>;
      readonly leads: number; readonly fingerprint: string; readonly rssBeforeMb: number; readonly rssAfterMb: number; readonly heapUsedMb: number }
  | { readonly event: "lead-snapshot.recompute.failed"; readonly durationMs: number; readonly source: string;
      readonly row: number | null; readonly errorKind: string; readonly path: string | null };
export const renderSnapshotLog: (e: SnapshotLogEvent) => string;     // one-line JSON with "level"
```

How `acquire` works:
1. Dispatch `requested`.
2. Run the effects. Each effect is started with `void` on a promise that turns every outcome into an event and never rejects. It gets no request `AbortSignal`. RSS and timing are read in the shell.
3. Evaluate `serveDecision`. On `await-activity`, await the current settle promise and re-evaluate. A refresh awaits the whole chain: a check, then the rebuild it triggers.

Logging goes through the logger of the request that started the effect.
**Depends on:** Snapshot lifecycle reducer

### Lead snapshot data, selectors and recompute

**Responsibility:**
- Build the immutable `LeadSnapshot` from the ten workbooks within the recompute memory budget.
- Answer filtered-slice and by-CVR queries without per-request allocation beyond the slice.

**Files:** `fugue-dags/lib/lead-snapshot/snapshot.ts`, `recompute.ts`, `check.ts`, `fugue-dags/lib/sources.ts`, `fugue-dags/lib/scoring-model.ts`
**Interface:**

```ts
export interface LeadSnapshot {
  readonly fingerprint: SnapshotFingerprint;
  readonly builtAt: IsoUtcTimestamp;
  readonly asOfMonth: AsOfMonth;
  readonly asOf: string;                                // month-start UTC ISO, exactly today's ScoringConfig.asOf
  readonly leadsSorted: readonly ScoredLead[];          // frozen; sortLeads order (score desc, name asc "da")
  readonly firstByCvr: ReadonlyMap<Cvr, ScoredLead>;    // first occurrence in Brancheliste order (opener's find semantics)
  readonly summary: { readonly totalCompanies: number; readonly withSignals: number; readonly skippedInvalidCvr: number;
                      readonly maxScore: number; readonly weights: Weights; readonly scoringParams: ScoringParams;
                      readonly paramsSource: "sheet" | "defaults" };
  readonly scoringFingerprint: string;                  // scoringFingerprint(weights, params) — opener LLM cache key input
  readonly sourceRows: Readonly<Record<SourceKey, number>>;
}
export const selectLeads: (snapshot: LeadSnapshot, f: LeadFilters) => readonly ScoredLead[]; // single pass, stops at limit
export const lookupLead: (snapshot: LeadSnapshot, cvr: Cvr) => ScoredLead | null;

// recompute.ts
export const buildLeadSnapshot: (deps: SnapshotDeps, trigger: Trigger)
  => Promise<Result<{ snapshot: LeadSnapshot; fingerprint: SnapshotFingerprint }, BuildFailure>>;
// check.ts
export const checkSources: (deps: SnapshotDeps) => Promise<Result<SnapshotFingerprint, { source: string | null }>>;

// sources.ts
export type SourceKey = keyof typeof FILE_NAMES;
export const SOURCE_SPECS: Readonly<Record<SourceKey, { fileName: string; sheet?: string | number; headerRow?: number }>>;

// scoring-model.ts (extractions; parseMaster delegates to them)
export const parseMasterRow: (row: RawBranchelisteRow, brancheByCvr: ReadonlyMap<Cvr, string>) => CompanyRecord | null;
export const buildBrancheByCvr: (rows: readonly RawDanskErhvervRow[]) => ReadonlyMap<Cvr, string>;
```

Recompute order. It is sequential to bound peak memory, and each source's bytes and rows go out of scope before the next large read.
1. `getMetadata` × 10 gives the build's own fingerprint. The month comes from `ctx.clock`.
2. Scoringsmodel: one `getContent`, one `openWorkbook`, then the weights sheet, plus the scaling sheet only if `sheetNames` includes `SCALING_SHEET`. Any scaling read or validation failure falls back to defaults, as today. A weights failure is a `BuildFailure` naming the file (FR-022).
3. The eight signal workbooks go through `parseWorkbook`, then `buildSignalIndexes` and `buildBrancheByCvr`. GlobalConnect diagnostics are logged once.
4. Brancheliste goes through `foldRows`, with a step of `parseMasterRow` then `scoreLead`, pushing to the builder, counting invalid CVRs and signals, and setting `firstByCvr` first-wins (FR-041).
5. `sortLeads` and `Object.freeze`, then assembly.

Every failure maps to `BuildFailure { source: fileName, row: xlsxErrorRow(e), kind, path }`.

If a workbook changes between step 1 and its content read, the snapshot is labelled with the older fingerprint. The next window's check then sees a difference and rebuilds once, which is harmless.

`selectLeads` filters the pre-sorted array in order and stops at `limit`. It equals `applyFilters(allLeads, f)` because `Array.prototype.sort` is stable and filtering preserves relative order.
**Depends on:** Streaming workbook reader, Snapshot holder (types), Leads contract (meta types)

### Direct-sales DAGs

**Responsibility:** Serve `/score-leads` and `/lead-opener` from the snapshot with unchanged output contracts.
**Files:** `fugue-dags/dags/direct-sales/leads/lead-scoring/dag.ts`, `fugue-dags/dags/direct-sales/leads/lead-opener/dag.ts`
**Interface:**

```ts
// lead-scoring: defineDag { nodes: { "select-leads" }, edges: [{ from: DAG_INPUT, to: "select-leads" }], outputNodeId: "select-leads" }
createFetchNode<ScoreLeadsInput, ScoreLeadsOutput, readonly ["documents", "clock"]>({
  id: "select-leads",
  sideEffects: { kind: "reads", resource: resourceName("lead-snapshot"),
                 extractWitness: (o) => witnessValue("etag", o.meta.snapshot!.fingerprint) },
  fetch: async (input, ctx) => /* holder.acquire(ctx, { refresh: input.refresh ?? false })
                                  → selectLeads → { leads, meta: { ...summary, returned, asOf, snapshot } }
                                  | toFrameworkError */,
});
export const createScoringDag: (opts?: { holder?: LeadSnapshotHolder<LeadSnapshot> }) => DagDef;

// lead-opener: DAG_INPUT → lookup-lead → generate-opener → assemble-opener; DAG_INPUT edge only to lookup-lead
//   lookup-lead output: { lead: ScoredLead, scoringFingerprint: string, snapshotFingerprint: string }
//   malformed CVR → validation "'<cvr>' is not a valid 8-digit CVR" (path cvr) BEFORE acquire;
//   absent CVR → validation "CVR <cvr> not found in the master list (Brancheliste)" (path cvr) — messages verbatim from today
export const createOpenerDag: (opts?: OpenerDagOpts & { holder?: LeadSnapshotHolder<LeadSnapshot> }) => DagDef;
```

The registration `route`, `inputSchema` (the contract's), `config` and `meta.description` stay. The descriptions are updated to say "served from a fingerprinted in-memory snapshot", and `meta.version` gets a minor bump. The opener LLM cache key is unchanged: brand, CVR, `scoringFingerprint`, band and signal facts.
**Depends on:** Lead snapshot data/selectors/recompute, Leads contract

### Leads contract 0.5.0

**Responsibility:** Publish the additive `refresh` input and the `meta.snapshot` indicator.
**Files:** `fugue-dags/packages/contract/src/index.ts`, `fugue-dags/packages/contract/package.json`
**Interface:**

```ts
export const SnapshotStaleReasonSchema = z.object({
  kind: z.enum(["recompute-failed", "check-failed"]),
  source: z.string().optional(), row: z.number().int().positive().optional(), since: z.string() });
export const SnapshotMetaSchema = z.object({
  fingerprint: z.string(), builtAt: z.string(), asOfMonth: z.string(),
  status: z.enum(["fresh", "stale"]), staleReason: SnapshotStaleReasonSchema.optional() });
// ScoreLeadsInputSchema += refresh: z.boolean().optional()
// ScoreLeadsOutputSchema.meta += snapshot: SnapshotMetaSchema.optional()
```

**Depends on:** none

### Benchmarks

**Responsibility:** Measure and enforce the memory budgets, and produce the before/after report.
**Files:** `fugue-dags/scripts/bench/*`, `packages/xlsx/bench/parse-memory.ts`, `fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md`
**Interface:**

```ts
type Budget = { readonly name: "recompute" | "brancheliste-parse" | "snapshot" | "per-request" | "five-concurrent"; readonly limitMb: number };
type Measurement = { readonly budget: Budget; readonly valueMb: number };
export const evaluateBudgets: (ms: readonly Measurement[]) =>
  { readonly ok: boolean; readonly lines: readonly string[] };   // "recompute: 132 MB / 150 MB OK", breach names budget + value (AS-018, AS-019)
```

Budgets:
- recompute: ≤ 150 MB above the pre-recompute RSS
- Brancheliste parse: ≤ 100 MB
- snapshot: ≤ 60 MB of retained heap delta after a full GC
- per-request: ≤ 10 MB for `{ limit: 50 }` and `{ accountManager }`
- five concurrent warm requests: ≤ 50 MB in total

Checkpoint bytes per request are measured with a counting checkpoint writer. The scripts run against synthetic data by default and against the real files when `FUGUE_REAL_DATA_DIR` is set.
**Depends on:** DAGs (after-measurements), nothing (baseline)

---

## Data Flow

```
Request (/score-leads | /lead-opener)
  → select-leads | lookup-lead node
  → leadSnapshotHolder.acquire(ctx.documents, ctx.clock, ctx.logger, {refresh})
      → transition(state, requested, now)                      [pure]
          ├─ effects: start-check  → checkSources: 10× getMetadata → fingerprintOf(…, monthOf(now))   [detached]
          │                         → check-succeeded/failed → transition → maybe start-build
          └─ effects: start-build  → buildLeadSnapshot                                                  [detached]
                 getMetadata×10 → Scoringsmodel (openWorkbook once: weights + optional scaling)
                 → 8 signal workbooks (parseWorkbook) → buildSignalIndexes, buildBrancheByCvr
                 → Brancheliste foldRows(step: parseMasterRow → scoreLead)  [streamed, never materialized]
                 → sortLeads + freeze → LeadSnapshot → build-succeeded → atomic swap
      → serveDecision(state) → serve | await in-flight | unavailable(typed)
  → selectLeads(snapshot, filters) [early stop] | lookupLead(snapshot, cvr)   [pure]
  → ScoreLeadsOutput (+ meta.snapshot) | ScoredOne → generate-opener → assemble-opener
```

All I/O is the `documents` capability, at the edges inside `check.ts`, `recompute.ts` and the holder's effect runner. Parsing, indexing, scoring, selection, transitions and log rendering are pure. The request path does no SharePoint I/O inside the window and allocates only the returned slice.

---

## Invariants

### INV-1: SheetJS is never a runtime import

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-sheetjs-runtime-import.json`
**Owner module:** none
**Unowned reason:** It is a prohibition on every production `.ts` file in the fugue repo, not a rule that one module implements. The only sanctioned importers are `*.test.ts` files and `packages/xlsx/src/__tests__/support/sheetjs-oracle.ts`.
**Statement:** No fugue `.ts`, `.tsx`, `.mts` or `.cts` file imports the `xlsx` package (static import, side-effect import, dynamic `import()` or `require`), except files ending in `.test.ts` and the oracle harness `sheetjs-oracle.ts` (FR-042). The rule covers `packages/xlsx/src/index.ts`, which still imports SheetJS today. The streaming-reader task removes that import, and every intermediate edit that keeps it is flagged. fugue-dags is a separate repo and is not covered. It does not import SheetJS directly.

---

## Implementation Phases

Phases map to decompose waves. Tasks marked "(fugue-dags)" edit `/Users/hansen142/dev/agentic/fugue-dags` and are verified by running that repo's commands explicitly (see Verification).

### Phase 1: Foundations (no dependencies)

- **T1, streaming workbook reader (fugue).**
  - Implement the full reader: `zip.ts`, `xml.ts`, `workbook-parts.ts`, `shared-strings.ts`, `styles.ts`, `cell-value.ts`, `sheet-stream.ts`, `rows.ts`.
  - Rewrite `index.ts` (`openWorkbook`, `foldRows` with cooperative yield, `parseWorkbook` via fold, `xlsxErrorRow`), replicating the SheetJS semantics listed in AD-2. The implementer reads the SheetJS 0.18.5 sources for `numdate`, `SSF.is_date`, `parse_ws_xml` and the `_xHHHH_` handling.
  - Update `package.json`: add fflate and saxes, and move SheetJS, exceljs and jszip to devDependencies.
  - Add unit and property tests (`cell-value.property.test.ts`, `zip.test.ts`, `stream-api.test.ts`).
  - The existing xlsx tests must pass unchanged. Anchors: FR-030 to FR-040, FR-042, AS-010 to AS-014, AS-016, AS-017.
  - **Files:** `packages/xlsx/package.json`, `packages/xlsx/src/index.ts`, `packages/xlsx/src/zip.ts`, `packages/xlsx/src/xml.ts`, `packages/xlsx/src/workbook-parts.ts`, `packages/xlsx/src/shared-strings.ts`, `packages/xlsx/src/styles.ts`, `packages/xlsx/src/cell-value.ts`, `packages/xlsx/src/sheet-stream.ts`, `packages/xlsx/src/rows.ts`, `packages/xlsx/src/__tests__/cell-value.property.test.ts`, `packages/xlsx/src/__tests__/zip.test.ts`, `packages/xlsx/src/__tests__/stream-api.test.ts`, `bun.lock`
- **T2, differential oracle and synthetic fixtures (fugue).**
  - Copy the current SheetJS `parseWorkbook` verbatim into `sheetjs-oracle.ts`.
  - Build the deterministic fixture generators (Brancheliste-shaped, the nine source shapes, the edge-case matrix).
  - Write `parity.test.ts` (TZ-pinned, run under UTC and Europe/Copenhagen) and `real-data.local.test.ts` (skips unless `FUGUE_REAL_DATA_DIR` is set).
  - It is green against the current implementation from the start and becomes the parity gate for T1. Anchors: AS-009, AS-014, AS-017, FR-043, SC-007.
  - **Files:** `packages/xlsx/src/__tests__/support/sheetjs-oracle.ts`, `packages/xlsx/src/__tests__/support/fixtures.ts`, `packages/xlsx/src/__tests__/parity.test.ts`, `packages/xlsx/src/__tests__/real-data.local.test.ts`
- **T3, leads contract 0.5.0 (fugue-dags).**
  - Add `refresh` and `SnapshotMetaSchema` / `meta.snapshot`.
  - Bump the package to 0.5.0.
  - Add compatibility tests. Anchors: FR-005, FR-016 (input shape), AS-029.
  - **Files:** `fugue-dags/packages/contract/src/index.ts`, `fugue-dags/packages/contract/package.json`, `fugue-dags/packages/contract/src/__tests__/leads.test.ts`
- **T4, snapshot lifecycle reducer and holder (fugue-dags).**
  - `lifecycle.ts` (transition and serveDecision exactly as in Component Design), `fingerprint.ts`, `log.ts`, and `holder.ts` with `createLeadSnapshotHolder`, the module-scope singleton and env-configured `windowMs`.
  - Property tests for transition rules 1–9.
  - Holder tests using fake check and build functions: concurrency, SWR, cold wait, cold failure, refresh joining an in-flight activity, and a recompute that survives the caller's abort or timeout. No timers anywhere.
  - Anchors: FR-007 to FR-013, FR-018 to FR-021, FR-050 to FR-052, AS-020 to AS-028, AS-031 to AS-035, SC-010, NFR-020, NFR-021.
  - **Files:** `fugue-dags/lib/lead-snapshot/lifecycle.ts`, `fugue-dags/lib/lead-snapshot/fingerprint.ts`, `fugue-dags/lib/lead-snapshot/log.ts`, `fugue-dags/lib/lead-snapshot/holder.ts`, `fugue-dags/lib/lead-snapshot/__tests__/lifecycle.property.test.ts`, `fugue-dags/lib/lead-snapshot/__tests__/fingerprint.test.ts`, `fugue-dags/lib/lead-snapshot/__tests__/holder.test.ts`
- **T5, snapshot data and selectors (fugue-dags).**
  - Extract `parseMasterRow` and `buildBrancheByCvr` in `scoring-model.ts`, with `parseMaster` delegating so its behaviour is identical.
  - `snapshot.ts`: the `LeadSnapshot` type, `selectLeads` (early stop) and `lookupLead` (first-wins).
  - Property tests: `selectLeads ≡ applyFilters` and first-wins lookup. Anchors: FR-003, FR-004, AS-001, AS-005, AS-007.
  - **Files:** `fugue-dags/lib/scoring-model.ts`, `fugue-dags/lib/lead-snapshot/snapshot.ts`, `fugue-dags/lib/lead-snapshot/__tests__/snapshot.property.test.ts`, `fugue-dags/lib/__tests__/domain.test.ts`
- **T6, benchmark harness and legacy baseline (fugue-dags).**
  - Move the scratchpad scripts (`bench2.ts`, `sources.ts`, `parse.ts`, `sampler.ts`) into `fugue-dags/scripts/bench/` as `sampler.ts` and `legacy-baseline.ts`.
  - Add the pure `evaluateBudgets` with tests.
  - Run the baseline locally against npm `@fuguejs` 0.5.1 with `FUGUE_REAL_DATA_DIR=/Users/hansen142/dev/agentic/fugue-dags/data` and record the before column of the report: cold peak, 5-concurrent warm, checkpoint bytes per run, Brancheliste parse peak.
  - This MUST complete before any task links local fugue builds. Anchors: AS-038 (baseline half).
  - **Files:** `fugue-dags/scripts/bench/sampler.ts`, `fugue-dags/scripts/bench/legacy-baseline.ts`, `fugue-dags/scripts/bench/__tests__/budgets.test.ts`, `fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md`, `fugue-dags/package.json`

### Phase 2: Recompute and package release prep (depends on Phase 1)

- **T7, recompute, metadata check and slimmed sources (fugue-dags).** Depends on T1, T4, T5 and T6, the last because the baseline must exist before linking.
  - Link the local fugue workspace into fugue-dags with `bun link` for all six `@fuguejs` packages (AD-6).
  - Implement `check.ts` and `recompute.ts` per the Component Design order.
  - Slim `sources.ts` to `SOURCE_SPECS`, schemas and `docRef`, removing the source nodes, `READERS` and `SourceFanInSchemas`.
  - Wire `leadSnapshotHolder`'s check and build.
  - Recompute tests on synthetic workbooks through the fake `DocumentSource`: legacy-pipeline parity, a failure naming the file and row, the optional scaling sheet, and a one-load Scoringsmodel shown by a `getContent` count.
  - Anchors: FR-001, FR-002, FR-007, FR-022, FR-041, AS-016, AS-032.
  - **Files:** `fugue-dags/lib/lead-snapshot/check.ts`, `fugue-dags/lib/lead-snapshot/recompute.ts`, `fugue-dags/lib/sources.ts`, `fugue-dags/lib/lead-snapshot/holder.ts`, `fugue-dags/lib/lead-snapshot/__tests__/recompute.test.ts`, `fugue-dags/lib/__tests__/sources.test.ts`, `fugue-dags/package.json`, `fugue-dags/bun.lock`
- **T8, xlsx memory benchmark, docs and lockstep 0.6.0 prep (fugue).** Depends on T1 and T2.
  - `packages/xlsx/bench/parse-memory.ts` and a CI `memory-budget.test.ts` (synthetic Brancheliste ≤ 100 MB).
  - README updates (streaming API, semantics, budgets).
  - Correct the `createCachedDocumentParser` doc comment, and update `llm-document-source.md`.
  - Bump all nine published packages and the `bun.lock` workspace versions to 0.6.0.
  - Run `bun run verify`. Anchors: AS-015, FR-060, FR-063 (package docs), SC-002, SC-013 (parse).
  - **Files:** `packages/xlsx/bench/parse-memory.ts`, `packages/xlsx/src/__tests__/memory-budget.test.ts`, `packages/xlsx/README.md`, `packages/document-source/src/index.ts`, `packages/document-source/docs/llm-document-source.md`, `packages/adapter-fs/package.json`, `packages/adapter-ms-graph/package.json`, `packages/adapter-oracle/package.json`, `packages/adapter-pg/package.json`, `packages/document-source/package.json`, `packages/framework/package.json`, `packages/host/package.json`, `packages/http-auth/package.json`, `packages/xlsx/package.json`, `bun.lock`

### Phase 3: DAG restructure (depends on Phase 1+2)

- **T9, both DAGs served from the snapshot (fugue-dags).** Depends on T3 and T7.
  - Rewrite `lead-scoring/dag.ts` (single `select-leads`, refresh, `meta.snapshot`, reads witness, injectable holder) and `lead-opener/dag.ts` (`lookup-lead`, malformed CVR rejected before `acquire`, messages verbatim).
  - Rewrite the removed-design cases in `dags.test.ts` and add new cases (Testing Strategy).
  - Add the re-import test and `snapshot-parity.test.ts` (synthetic; real data under `FUGUE_REAL_DATA_DIR`).
  - Update the READMEs (snapshot, window env, refresh, stale indicator, unfiltered exemption, trust assumption, cold wait vs the 30 s opener timeout) and `fugue-dags/CLAUDE.md`.
  - `fugue lint` and `fugue describe` must pass on both DAGs.
  - Anchors: FR-001 to FR-006, FR-016, FR-017, FR-063, AS-001 to AS-008, AS-028 to AS-030, SC-008, SC-009, SC-011.
  - **Files:** `fugue-dags/dags/direct-sales/leads/lead-scoring/dag.ts`, `fugue-dags/dags/direct-sales/leads/lead-opener/dag.ts`, `fugue-dags/dags/direct-sales/leads/lead-scoring/README.md`, `fugue-dags/dags/direct-sales/leads/lead-opener/README.md`, `fugue-dags/README.md`, `fugue-dags/CLAUDE.md`, `fugue-dags/tests/dags.test.ts`, `fugue-dags/tests/lead-snapshot-reimport.test.ts`, `fugue-dags/tests/snapshot-parity.test.ts`

### Phase 4: Local acceptance benchmarks (depends on Phase 3)

- **T10, after-benchmarks on linked builds: the acceptance bar (fugue-dags).** Depends on T6, T8 and T9.
  - `snapshot-memory.ts` measures recompute peak, steady snapshot size, per-request transient for `{limit:50}` and `{accountManager}`, the 5-concurrent warm total, checkpoint bytes per request, and cold-build duration.
  - Run it locally with `FUGUE_REAL_DATA_DIR` against the linked 0.6.0-candidate builds, plus the xlsx real-data differential (`real-data.local.test.ts`) and the `parse-memory.ts` real Brancheliste run.
  - Every budget must pass. A breach is reported verbatim and blocks completion; never raise a budget.
  - If the cold build exceeds 25 s on real data, raise lead-opener `timeoutMs` to 60 000 and record why.
  - Fill the "after (linked)" column of the report.
  - Add a synthetic-data budget assertion to the fugue-dags test suite.
  - Anchors: NFR-001 to NFR-005, SC-001 to SC-007, SC-009, SC-012, SC-013, AS-018, AS-019, AS-038 (pre-release).
  - **Files:** `fugue-dags/scripts/bench/snapshot-memory.ts`, `fugue-dags/scripts/bench/__tests__/budgets.test.ts`, `fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md`, `fugue-dags/package.json`, `fugue-dags/dags/direct-sales/leads/lead-opener/dag.ts`

### Phase 5: Release pin, gated on the user (depends on Phase 4)

- **T11, pin fugue-dags to the published 0.6.0 and contract 0.5.0 (fugue-dags). BLOCKED until the user has pushed `v0.6.0` in fugue and run `publish-contract.yml` for contract 0.5.0.** Depends on T8 and T10.
  - Before starting, verify the published versions with `npm view @fuguejs/xlsx@0.6.0 version` (and the other eight).
  - Replace every `link:` specifier with `0.6.0` and set the contract dependency to the published `0.5.0` where it is consumed externally (the workspace dependency stays `workspace:*`).
  - Run `bun install`, then the full `verify:junit`.
  - Re-run `snapshot-memory.ts` and `parse-memory.ts` with real data and fill the "after (0.6.0)" column.
  - Anchors: FR-061, FR-062, AS-036, AS-037, AS-038, SC-011.
  - **Files:** `fugue-dags/package.json`, `fugue-dags/bun.lock`, `fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Streaming reader (T1) | `decodeCell` per cell type; `buildHeaderMap` (blank skip, duplicate crash); `projectRow` null-proto and blank skip; workbook-parts sheet resolution by name or index; shared strings (rich runs, rPh, escapes); styles date detection table; non-ZIP crash; missing sheet crash | existing `xlsx.test.ts`, `date-group-item.test.ts` and `end-to-end.test.ts` unchanged; `stream-api.test.ts`: one load serves two sheets, a probe for an absent optional sheet, fold order, 20 concurrent parses equal sequential (AS-017), the fold yields at least once on a large sheet | `serialToDate` vs the SheetJS oracle over random serials and both date systems; `decodeXmlEscapes` round-trip; `parseWorkbook ≡ foldRows-collect` |
| Differential oracle (T2) | n/a | `parity.test.ts`: every fixture, new reader ≡ SheetJS under TZ=UTC and Europe/Copenhagen; `real-data.local.test.ts` on all 10 real workbooks (local, opt-in) | random synthetic workbooks (cell type mix, sparse addressing) give equal output |
| Contract 0.5.0 (T3) | a 0.4.0-shaped input and output still parse; `refresh` accepted; `meta.snapshot` fresh and stale round-trip; unknown `staleReason.kind` rejected | n/a | n/a |
| Lifecycle reducer (T4) | each transition rule 1–9 as a named example | holder with fake check and build: N concurrent cold requests give 1 build (SC-010); SWR serves old during a rebuild; a refresh waits for the chain; cold failure gives a typed `snapshot-unavailable` naming the file; aborting the triggering request does not cancel the build; the window is honoured via a mutable test clock (0 checks inside the window, 1 after it) | random event sequences: at most one activity; a failure never changes `snapshot`; no `start-check` inside the window without refresh; stale-id events are no-ops; a served snapshot is always a complete `build-succeeded` payload |
| Snapshot data and selectors (T5) | `selectLeads` early stop at `limit`; empty match returns `[]` (AS-005); `parseMasterRow`/`buildBrancheByCvr` vs existing `parseMaster` cases | n/a | `selectLeads(sorted(xs), f) ≡ applyFilters(xs, f)` over random leads and filters (SC-008); `lookupLead` returns the first occurrence for duplicate CVRs |
| Recompute and check (T7) | `BuildFailure` mapping (file, row via `xlsxErrorRow`); `SOURCE_SPECS` completeness | fake `DocumentSource` with synthetic workbooks: snapshot ≡ legacy pipeline (parseWorkbook → parseMaster → scoreLead → sortLeads); a missing scaling sheet gives defaults; Scoringsmodel `getContent` called once (FR-022, AS-016); a bad workbook gives a failure naming the file and row; `checkSources` makes 10 metadata calls and 0 downloads | n/a |
| DAGs (T9) | n/a | see the list below; `lead-snapshot-reimport.test.ts`; `snapshot-parity.test.ts` (synthetic in CI, real data opt-in) | n/a |
| Benchmarks (T6, T8, T10) | `evaluateBudgets` breach naming and value formatting | `memory-budget.test.ts` (synthetic parse ≤ 100 MB, CI); local real-data runs are the acceptance bar | n/a |

**`fugue-dags/tests/dags.test.ts` cases that assert the removed design and are rewritten (FR-062 conflict resolution).** FR-062 is interpreted as "the suite stays green with every behavioural guarantee preserved"; structural assertions on the removed design are replaced.
- "workbooks are parsed once per file version — repeat runs cost only getMetadata" is replaced by "inside the freshness window a repeat run makes 0 document calls; after the window, exactly 10 getMetadata and 0 getContent when nothing changed; a changed eTag triggers one rebuild" (AS-002, AS-020, SC-009).
- "both DAG nodes warn on nonzero GlobalConnect read diagnostics" (in the `GlobalConnect diagnostics surfacing` describe) is replaced by "one recompute warns once; both DAGs served from it emit no further warning".
- The fixture plumbing that wires per-source fan-in node ids, and any assertion on `fetch-*` or `score-leads`/`score-one-lead`/`assemble-leads` node ids or outputs, is replaced by snapshot-served equivalents with an injected fresh holder per test.
- Kept unchanged in intent: the worked example scoring (all signals, ordering); the accountManager/minScore/limit filters; the opener happy path; the zero-signal fallback; brand in prompt and cache key; the LLM boundary rule; rebrand cache miss; unknown CVR validation error (path `cvr`); malformed CVR rejected before lookup; a repeat opener call hits the LLM cache; every host-contract test.
- New cases: `refresh: true` bypasses the window and reflects a changed workbook in its own response (AS-028, SC-012); a request without `refresh` behaves identically (AS-029); a bad workbook after a good build gives the last good snapshot with `meta.snapshot.status = "stale"` and `staleReason.recompute-failed` naming the file (AS-032) and recovery on the next window (AS-033); a cold bad workbook gives a typed error naming the file and no lead list (AS-034); a metadata failure gives a stale `check-failed` (AS-035); a month rollover with an unchanged workbook gives a rebuild (AS-023); a scoring response and an opener response from the same snapshot agree on score and facts (AS-008).

---

## Security & NFR Notes

- **Security.**
  - No new routes, roles or secrets. `refresh` rides the existing `/score-leads` authorization, because the host validates `inputSchema` after auth (FR-017, NFR-010, AS-030).
  - Trust assumption (AD-4): the snapshot is built with the triggering invocation's `documents` client and served to all callers of the tenant worker. This is valid only for app-only reads, and it is documented in the READMEs and the ADR.
  - Logs and the stale indicator carry only file names, row numbers, error kinds and fingerprints (NFR-011).
  - saxes is strict and does no entity expansion. A ZIP entry whose declared uncompressed size or cumulative inflate exceeds a cap (default 512 MiB per entry) is rejected as a non-retriable node-crash, which guards against zip bombs from hostile uploads.
- **Isolation.** The snapshot is per worker process, and each tenant has its own worker, so tenants are unaffected (FR-053, NFR-021). Recompute failures become events and never crash the process.
- **Performance.**
  - The request path is a pre-sorted scan with early stop. The per-request da-locale sort over about 25.6k leads is gone.
  - The snapshot measured at about 34 MB of heap as full `ScoredLead` objects (25,658 leads, 20.6 MB of JSON), under the 60 MB budget without a compact encoding.
  - Recompute reads sources sequentially to bound the peak. `foldRows` yields to the event loop so requests served from the old snapshot stay responsive during a rebuild.
  - Unfiltered `/score-leads` is exempt from the per-request budget (AD-7).
- **Known pre-existing limitation, documented and not changed.** `lib/` code changes take effect on worker restart because lib modules are shared across `?v=sha` re-imports. The holder's placement relies on exactly this.

---

## Verification

1. fugue build and type checks: `cd /Users/hansen142/dev/agentic/fugue && bun run typecheck`, then `bun run verify` (repo verification, including the INV-1 lint rule load).
2. fugue xlsx tests: `cd /Users/hansen142/dev/agentic/fugue/packages/xlsx && bun test`. The existing contract tests pass unchanged; `parity.test.ts` and `memory-budget.test.ts` pass; `real-data.local.test.ts` reports as skipped.
3. Local real-data parity: `FUGUE_REAL_DATA_DIR=/Users/hansen142/dev/agentic/fugue-dags/data bun test packages/xlsx/src/__tests__/real-data.local.test.ts` gives 10/10 workbooks identical to SheetJS (SC-007).
4. Local parse budget: `FUGUE_REAL_DATA_DIR=/Users/hansen142/dev/agentic/fugue-dags/data bun packages/xlsx/bench/parse-memory.ts` prints the Brancheliste peak against 100 MB and exits 0.
5. fugue-dags tasks (T3, T4, T5, T6, T7, T9, T10, T11): `cd /Users/hansen142/dev/agentic/fugue-dags && bun run verify:junit`. This runs tsc, `fugue lint` and `fugue describe` on both DAGs, `fugue prompts check` and the full `bun test`, writing `.loom/completion-reports/verify.junit.xml`. Narrow loops are `bun test lib/lead-snapshot` and `bunx tsc --noEmit`. These commands must be run explicitly, because fugue's Wave Gate does not observe the fugue-dags repo.
6. Local acceptance benchmark (T10, T11): `cd /Users/hansen142/dev/agentic/fugue-dags && FUGUE_REAL_DATA_DIR=$PWD/data bun scripts/bench/snapshot-memory.ts` prints each measured value next to its budget and exits 0 (AS-019). The report at `fugue-dags/docs/benchmarks/2026-11-host-memory-spikes.md` holds the baseline, after (linked) and after (0.6.0) columns.
7. Manual: run the host locally against fugue-dags (`run-host.sh`, fs adapter).
   - Call `/score-leads {limit:50}` twice. The second call makes no document I/O, and `meta.snapshot.status` is `"fresh"`.
   - Replace `data/Brancheliste.xlsx` with a corrupt file and call with `refresh: true`. The response is stale with `staleReason.source = "Brancheliste.xlsx"`.
   - Restore the file and call `refresh: true`. The response is fresh again.
   - `/lead-opener` for a known CVR returns facts that agree with the scoring row.
8. Release gate (user): push `v0.6.0` in fugue (`release.yaml` validates lockstep and publishes) and run `publish-contract.yml` in fugue-dags. Then do T11.

**Loom scope notes.**
- **No `## Contracts`.** `.loom/verification-manifest.json` in fugue has one check, which runs only `packages/framework/src/__tests__/cli/authored-map.test.ts` into JUnit. Acceptance testcases for this feature would never appear in its report, so RED and GREEN could not be observed. Adding a check is an operator change to that manifest, and decompose never assigns it. The xlsx parity guarantee is enforced by the T2 differential suite instead.
- **No `## Lifecycles` and no fugue-dags invariants.** These are cross-repo; see AD-4.
- **INV-1 needs no mutation runner.** It is unowned, so no schema-2 manifest is needed.
