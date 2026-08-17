# Plan Alignment Report — F6 File-backed durable runtime

**Spec:** `.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md`
**Plan:** `.claude/plans/2026-08-12-f6-file-durable-runtime.md`
**Date:** 2026-08-12
**Method:** Semantic matching (coverage by meaning, not literal text). Out-of-scope items are not gaps.

## Summary

The plan fully covers the spec: all 48 extracted requirements (34 FR, 4 NFR, 7 SC, 3 US) are addressed by meaning. The plan's architecture (AD-1 composite node-key codec with canonical folding; AD-2 ProgramJournal-parity on-disk layout with the digest-filename adaptation; AD-3 log-authoritative resume agreement proof; AD-4 single-writer append lock; AD-5 digest-addressed freshness index with lazy TTL; AD-6 typed `Result<_, FrameworkError>` failure surface) maps 1:1 onto the spec's requirements, and every acceptance scenario, success criterion, and measurement approach has a corresponding implementation phase, test file, or verification step. Zero gaps.

Notable semantic matches worth recording (not gaps):

- **FR-040 vs AD-6 (JobLike throw surface):** the spec demands no throws across the port boundary; the plan documents the single honest exception — `JobLike` methods are `Promise<void>` with no Result channel, and the BullMQ adapter's established pattern is to throw. The plan throws a *typed* `FrameworkError` (converted identity-safely by the kernel shell), preserving FR-040's intent to the maximum degree the port contract permits, and documents it in the module header. This is consistent with the spec's own "same semantics as the in-memory/Redis adapters" (FR-001) and was judged aligned by meaning.
- **SC-001 composite addressing vs shared-suite split:** the plan keeps the shared `checkpointerSuite` untouched (per FR-023 — in-memory/Redis are not extended) and covers composite addressing in file-specific tests that run against the same extracted suite factory. This is the only reading consistent with FR-023.
- **US1 progress round-trip:** progress durability is implemented (FR-007, atomic `progress.json`) and exercised by the job "progress/checkpoint round-trip" test; the kernel `JobLike` port has no progress reader, so write-side durability + round-trip test is the full extent the port admits.
- **FR-042 "framework frozen at 0.4.0":** satisfied by absence — no plan step bumps the version; the subpath export and unchanged main-barrel surface are explicit (Phase 1, verification step 8).

## Executable-Models Policy Check (phase-template step 3.5)

- **No `## Lifecycles` / `## Pipeline` declared** — plan notes framework library code, ruling 13. Absence is NOT a gap per policy.
- **Three invariants (INV-1, INV-2, INV-3), all tiered `advisory`** — each with an honest justification for why a deterministic gate exists elsewhere or why a lint regex cannot express it:
  - INV-1 (import boundary): actually enforced by the repo's own deterministic `check-imports.ts` rule via `boundary-imports.test.ts` (SC-006) — stronger than any regex; the advisory tier cites this instead of claiming regex checkability.
  - INV-2 (sequence = happens-before): concurrency/interleaving property — not regex-checkable. Honest.
  - INV-3 (lazy TTL only, no sweeper): a regex cannot distinguish a legitimate timer from a sweeper. Honest.
- **No invariant is declared checkable-tiered while being uncheckable by a regex rule** — therefore no MODEL-N tag is warranted.

## Gaps

None.

## Coverage Table

| ID | Description | Status |
|----|-------------|--------|
| FR-001 | `JobLike` implementation (`createFileJob`: `data`, `updateData`, `updateProgress`, `appendEvent`), in-memory/Redis-equivalent semantics | Covered — `file/job.ts`, AD-6, Phase 2 |
| FR-002 | Appends durably persisted in append order; sequence = happens-before | Covered — AD-4 lock + `sequence = count` under lock |
| FR-003 | Journal under caller-supplied dir; fully recoverable from dir alone in a fresh process | Covered — AD-2 layout; cross-instance durability tests |
| FR-004 | `appendEvent` idempotent under `dedupKey`; no-op keeps first record's content/position; dedup decision durable across crash-retry | Covered — digest-filename dedup (AD-2), no index, re-check on retry; SC-003 |
| FR-005 | Append returns only after durable persist; append-before-checkpoint ordering; crash window = benign lag | Covered — atomic rename commit (AD-2); AD-3 step 5; SC-002(a) |
| FR-006 | `updateData` atomic post-state snapshot | Covered — `atomicWriteFile` tmp+rename on `checkpoint.json` |
| FR-007 | `updateProgress` durable with same atomicity | Covered — atomic `progress.json` |
| FR-008 | Event-log reader exposes `RecordedEvent` envelopes (`recordedAtMs`, `event`) | Covered — `readFileEvents` envelope mapping |
| FR-009 | Write-boundary losslessness (writer rejects anything the serializer cannot represent) + strict read-side validation (schema version, non-negative seq, finite timestamp, dedup charset); fail closed, never silent drop | Covered — `assertLosslessEvent` pre-scan + round-trip backstop at write time; `parseFileEventRecord` strict matrix; `readFileEventRecords` fails closed with `checkpoint-corrupt` |
| FR-010 | Log authoritative, checkpoint may lag; disagreement with any strict-prefix replay fails closed (`checkpoint-corrupt`) | Covered — AD-3 algorithm (steps 2, 5, 6) |
| FR-011 | Resume replays through pure machine, never re-invokes executor/side effects | Covered — AD-3; replay-only resume test |
| FR-012 | Terminal-failed state never persisted as checkpoint; not resumable | Covered — AD-3 (failed-state key in no prefix replay) + terminal-failed test |
| FR-013 | Appends serialized (sequence = happens-before even when interleaved); single-writer contract enforced by design and documented | Covered — AD-4 lock + documented contract on `createFileJob` |
| FR-014 | No recoverable state ⇒ typed `checkpoint-missing`, never silent fresh start | Covered — AD-3 step 1 |
| FR-015 | `dedupKey` charset `^[A-Za-z0-9:_-]{1,256}$` at persistence boundary; typed rejection | Covered — `DEDUP_KEY_PATTERN` / `dedupKeyError` in `file/event-record.ts`, record parse, charset validated at append (Security notes) |
| FR-016 | Job-side identifiers re-validated (`^[A-Za-z0-9_:-]{1,128}$`); no path escape, fail closed | Covered — boundary validator + `join`-after-validation discipline; hostile-identifier tests |
| FR-020 | File Checkpointer implements full port (`load`, `saveNode`, `setMeta`), durable, per-run dir; passes entire shared `checkpointerSuite` | Covered — Phase 4; zero carve-outs |
| FR-021 | Backend-agnostic composite node-key extension `(namespace, nodeId, index, attempt)`, default `"dag"`, canonical fallback = plain `nodeId` | Covered — AD-1 exactly |
| FR-022 | Full composite addressing: distinct addresses ⇒ distinct durable entries; load returns every stored node | Covered — AD-1 `@`-separator collision-freedom by construction + file-specific composite tests |
| FR-023 | Extension changes nothing in in-memory/Redis backends or layouts; shared suite stays green | Covered — AD-1 ("not extended in this pass") |
| FR-024 | `setMeta` stamps `FRAMEWORK_VERSION` unless caller supplies one | Covered — `frameworkVersion: meta.frameworkVersion ?? FRAMEWORK_VERSION` |
| FR-025 | Load rejects `checkpoint-version-mismatch` on framework-version difference (ADR-0017) | Covered — AD-6 table; suite case |
| FR-026 | Load rejects `checkpoint-version-mismatch` when `expectedDagFingerprint` supplied and absent/different | Covered — AD-6 table; load opts |
| FR-027 | 24h expiry evaluated lazily at load ⇒ `checkpoint-expired`; no sweeper, no physical GC | Covered — AD-6, INV-3, `now()`-injected TTL |
| FR-028 | Corrupt node entry dropped + surfaced in `corruptNodeIds`; corrupt metadata ⇒ typed `checkpoint-corrupt` | Covered — checkpointer load behavior + `fwLogger().warn` parity |
| FR-029 | Checkpointer writes atomic; run/node identifiers re-validated at fs boundary, fail closed | Covered — `atomic.ts` + Security notes; `checkpoint-write-failed` mapping |
| FR-030 | File FreshnessIndex implements `recordWrite`/`findConflict` durably across restart | Covered — AD-5; SC-007 |
| FR-031 | `recordWrite` atomic latest-write replace per resource | Covered — AD-5 tmp+rename replace |
| FR-032 | `findConflict` Redis-identical semantics (first conflicting write after `sinceMs`); no record ⇒ clean no-conflict, never error | Covered — AD-5 conflict predicate; absent ⇒ `ok(null)` |
| FR-040 | Every boundary failure typed `Result<_, FrameworkError>` with existing kinds; nothing throws across the port boundary | Covered (note) — AD-6: `Result` everywhere the port admits; the one `JobLike` exception (port is `Promise<void>`, BullMQ-parity) throws a *typed* `FrameworkError`, documented; kernel shell converts identity-safely |
| FR-041 | Only `node:fs`, `node:crypto`, `node:path`; no new package dependencies | Covered — INV-1; layout.ts module note; check-imports rule |
| FR-042 | Clean `@fuguejs/framework/file` subpath export; framework frozen at 0.4.0; existing surface unchanged | Covered — Phase 1 `package.json` exports + verification step 8 (no version bump anywhere) |
| FR-043 | `check-imports.ts` boundary rules green; no `bullmq`/`ioredis`/`queue-bullmq` in file backend; no new violations | Covered — INV-1, new `["file", "file.ts"]` scope rule, SC-006 |
| FR-044 | Run-directory lifecycle consumer-owned, documented; no background/out-of-band directory management | Covered — AD-4 contract; INV-3; AD-5 no sweeper |
| NFR-001 | Crash at any write point ⇒ recover exactly (benign lag) or fail closed; never silent bogus state | Covered — tmp+rename atomicity + SC-002 both directions |
| NFR-002 | Resume/replay deterministic; same journal in same order ⇒ same state; no executor invocation | Covered — AD-3 pure fold + replay-determinism property test |
| NFR-010 | Identifiers never address outside caller-supplied dir; verified by hostile-identifier boundary tests | Covered — `file-boundary.test.ts` sweep (traversal, absolute paths, NUL, charset violations, 129-char ids) |
| NFR-020 | Backend swap transparency proven by shared suites against all backends | Covered — suite parametrized over InMemory + env-gated Redis + File (verification 2–3) |
| SC-001 | `createFileCheckpointer` passes ENTIRE shared `checkpointerSuite`, zero failures (version, fingerprint, TTL, corrupt-drop, composite addressing, atomicity) | Covered — Phase 4 + verification 3; composite coverage additive in file-specific tests per FR-023 |
| SC-002 | Crash-window resume test both directions (benign lag recovers; manufactured disagreement fails closed `checkpoint-corrupt`) | Covered — Phase 3 `file-resume.test.ts`; verification 4 |
| SC-003 | Dedup idempotency test: same key twice ⇒ exactly one record (first preserved), holds across simulated crash | Covered — Phase 2 `file-journal.test.ts` (cross-instance = simulated crash); verification 5 |
| SC-004 | `bun run typecheck` green | Covered — verification 1 (both tsconfigs) |
| SC-005 | Full framework suite green, no regressions in in-memory/Redis/BullMQ | Covered — verification 2; shared-suite extraction refactor keeps Redis suite intact |
| SC-006 | `check-imports.ts` green incl. no broker imports in file backend | Covered — verification 6; INV-1 |
| SC-007 | FreshnessIndex durability: write visible to `findConflict` after restart; Redis-identical conflict semantics | Covered — Phase 5 `file-freshness-index.test.ts`; verification 7 |
| US1 | Durable file-backed job with crash-safe resume (5 acceptance scenarios: identical-final-state round-trip; benign lag window recovered by replay; strict-prefix disagreement fails closed; corrupt/truncated JSON never silently skipped; invalid identifiers rejected at boundary) | Covered — via FR-004/005/008/009/010/014/015/016; completed-journal round-trip test; progress round-trip exercised |
| US2 | File-backed Checkpointer over the composite address space (6 acceptance scenarios: unknown run ⇒ `null`; all composite/canonical nodes returned with exact outputs, corrupt entries via `corruptNodeIds`; version mismatch; fingerprint opt-in; lazy 24h expiry; invalid node IDs fail closed) | Covered — via FR-020…FR-029; `file-checkpointer.test.ts` covers every scenario |
| US3 | Durable single-process FreshnessIndex (3 acceptance scenarios: restart visibility + stale-write detection; atomic latest-write replace; no-record ⇒ clean no-conflict) | Covered — via FR-030…FR-032 + SC-007; scenario parity vs `InMemoryFreshnessIndex` |

## Verification

- Gap report path: `.claude/specs/2026-08-12-f6-file-durable-runtime/plan-alignment.md` (verified on disk, non-empty)
- Total requirements checked: **48** (34 FR + 4 NFR + 7 SC + 3 US)
- Total gaps: **0**
- Gap IDs: none
- MODEL-N tags: none (policy check passed; no checkable-tiered invariant is regex-uncheckable)
- Out-of-scope items confirmed excluded by the plan: file QueueBackend/workers, SQLite, Store capability, workflow DSL, F1/F8/F4 consumption, changes to existing backends/layouts, historical Loom run-directory migration, background sweeper/GC, parallel writers (single-writer contract documented in AD-4).
