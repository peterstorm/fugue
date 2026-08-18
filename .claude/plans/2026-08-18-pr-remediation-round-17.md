# PR Remediation — Round 17

- **Branch:** `feat/f6-file-durable-runtime`
- **Date:** 2026-08-18
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-18-192126-f6-file-durable-runtime`
- **Authority:** that run's canonical `result.json` (published by the registered Standalone Review Program after its registered Refutation Panel; threshold 2 of 3 lenses). All remediation inputs below are read from `result.json` — nothing hand-built.
- **Frozen scope:** the 342 files in `result.json.scope` (the full branch delta vs `main`).

## Panel outcome

- Surviving criticals: **5** (all mandatory)
- Refuted criticals: **0** — nothing was refuted; the refutation panel's full verdict set is preserved in the run's `result.json.panel.outcomes` and verifier transcripts (`refutation-slot:*`).
- Advisories: **18** — dispositions below (16 accepted, 2 deferred, 0 dismissed).

## Surviving criticals — mandatory fixes

### C1 + C2 (one root cause) — `resumeFileJob` reads the log before the checkpoint; a concurrent resumer can observe a checkpoint *ahead of* the log and receive a spurious `checkpoint-corrupt`

- `code-reviewer-1` (file-resume.test.ts:1793): the pinned round-14 A4 cross-process test intermittently fails — reproduced (`checkpoint count 16 vs replay 15`; `27 vs 26`), so the frozen suite is not green as SC-005 requires. Upheld 3/3 lenses.
- `pr-test-analyzer-1` (resume.ts:216): the root cause — `resumeFileJob` acquires `readFileEvents` (resume.ts:216) before `readCheckpoint` (resume.ts:237). Against a healthy append-first writer (FR-005: append, then checkpoint — two separate atomic renames), a resumer whose log listing lands before the Nth append and whose checkpoint read lands after that iteration's checkpoint rename observes checkpoint strictly ahead of the log — the *mirror* of the benign lag window, which the ADR-0077 proof classifies `checkpoint-corrupt`. Reproduced 3/3 with a minimal two-process probe. Upheld 3/3 lenses.

**Fix (both findings):**
1. `packages/framework/src/file/resume.ts` — swap the acquisition order: read `checkpoint.json` FIRST, then the event log. For an append-first writer, checkpoint(t₁) ≤ log(t₁) ≤ log(t₂): the pair is then always full-agreement or benign *lagging* checkpoint — exactly the two directions the ADR-0077 proof accepts. Update the module header's step enumeration (steps 1↔2) and add the concurrency rationale to the acquisition contract: the lagging side must be acquired first so a concurrent reader can never observe the projection ahead of the log snapshot.
2. Error-precedence change to pin: when BOTH the log is unreadable/corrupt AND `checkpoint.json` is an fs-failure, the checkpoint's typed `cache-error` now surfaces first (previously the log's `checkpoint-corrupt`). Kinds are unchanged (ADR-0080 surface already documents both); add a pin in `file-resume.test.ts`.
3. `docs/adr/0077-…checkpoint-may-lag.md` — amend (Amended 2026-08-18 marker + note on the decision enumeration): the shell acquires the checkpoint projection before the authoritative log, with the interleaving argument above; the proof itself is unchanged.
4. `packages/framework/src/__tests__/file-resume.test.ts` — re-pin round-14 A4:
   - invariant unchanged: during active writes the resumer sees only consistent prefixes or `checkpoint-missing` (now holds by construction, not by scheduling luck);
   - replace the schedule-dependent `intermediates.length > 0` assertion (advisory, accepted) with a deterministic overlap pin: the writer emits a `writer-ready` marker before its append loop and the parent waits for it before polling; the parent asserts at least one successful resume BEFORE the `writer-done` marker exists (mid-flight sampling proven) — the test's failure mode is the invariant itself, not sampling luck.

### C3 — `comment-analyzer-1` (CONTEXT.md:135): the documented FR-qualification disambiguation is absent from most host-pod citations

CONTEXT.md:135 asserts host-pod (`packages/host/src/supervisor/`) FR/SC/NFR citations "are qualified in the code as `multi-tenant spec FR-xxx`". At HEAD only 3 of the 24 citation-bearing files are fully qualified; 12 files have zero qualifications — including live number collisions (host FR-032 per-tenant admission vs F6 FR-032 freshness singleton parity; host FR-004/FR-005 vs F6 append semantics). Upheld 2/3 (test-coverage lens uncertain — no test pins comment state; not a refutation).

**Fix:** complete the established rule rather than weaken it — qualify every bare FR/SC/NFR citation in `packages/host/src/supervisor/` with `multi-tenant spec FR-xxx` (the form the three already-qualified files use), verifying each citation against the 2026-06-18 multi-tenant-single-host spec's numbering as it is qualified (a citation that does not exist in that spec is qualified with its actual owning spec, not mis-attributed). The CONTEXT.md note then states what is true. ~250 citations across 24 files; 8 of those files are outside the frozen scope and are registered as `supportPaths`.

### C4 — `comment-analyzer-2` (file.ts:59): barrel comment mislocates `META_RECORD_NODE_ID`'s canonical home

After deepening-round D2 the canonical `META_RECORD_NODE_ID` and `buildCheckpointWriteFailed` live in `types/error-factories.ts`; `file/checkpointer-codec.ts` only re-exports them — a fact the codec's own header documents, contradicting the barrel comment. Upheld 2/3.

**Fix:** rewrite `packages/framework/src/file.ts` comment to name `types/error-factories.ts` as canonical (D2) and state the codec re-exports so the barrel and test imports keep their paths.

### C5 — `architecture-tech-lead-1` (redis-checkpointer.ts:199): `RedisCheckpointer.load` breaks the Checkpointer seam's save→load round-trip for the legal nodeId `__proto__`

`__proto__` matches `ID_PATTERN` (legal `NodeId`). `load` keys the returned `nodes` map with plain bracket assignment — the `Object.prototype.__proto__` setter re-parents the map instead of creating an own entry (no entry, no `corruptNodeIds` trace, no error → silent re-execution on resume). The file adapter uses `Object.defineProperty` (file/checkpointer.ts:658) and the in-memory adapter a computed-key spread (checkpoint/checkpointer.ts:414); two dedicated pins establish the shared own-entry round-trip contract. The existing "redis-checkpointer.test.ts:371" pin actually lives in the file's IN-MEMORY describe block — the Redis leg (opt-in `REDIS_URL` shared-suite run) and the shared `_checkpointer-suite.ts` contain no `__proto__` case, so the suite is green with the break in place. Upheld 3/3 lenses.

**Fix:**
1. `packages/framework/src/checkpoint/redis-checkpointer.ts` `load`: replace `nodes[nodeId] = deserializeNode(raw)` with `Object.defineProperty(nodes, nodeId, { value, enumerable: true, writable: true, configurable: true })` — byte-matching the file backend's choice (also preserves the ordinary map prototype).
2. Lift a prototype-named-nodeId save→load round-trip pin into the shared `checkpointerSuite` (`packages/framework/src/__tests__/_checkpointer-suite.ts`) — public API only (`saveNode` → `load`; assert own entry, prototype integrity, no re-parenting) — so all three legs, including the opt-in Redis leg, are held to the same contract.

## Advisory dispositions (18)

Accepted (16) — claim verified sound and the complete in-scope fix is practical:

| # | Finding (agent) | Fix |
|---|---|---|
| A0 | replay-determinism property test flake (code-reviewer) | explicit generous timeout on the `fc.assert` test (file-resume.test.ts:1076) |
| A1 | recordWrite commit failure surfaces as `withFileLock` not `freshness:recordWrite` (silent-failure-hunter) | re-tag at the freshness public boundary (merged with A15 below) |
| A2 | `BufferedObserver` run-end dispatch failure uncounted (silent-failure-hunter) | route run-end dispatch failure through `dispatchErrors` + `onReplayFailure` (mirror the replay loop); pin in `buffered-observer.test.ts` |
| A3 | property + cli.test.ts:350 subprocess-lint default-timeout flakes (pr-test-analyzer) | explicit generous timeouts on both (merged with A0) |
| A4 | A4 `intermediates` assertion is schedule-dependent (pr-test-analyzer) | deterministic overlap pin — writer-ready gate + pre-completion observation (merged into C1/C2 fix step 4) |
| A5 | — | DEFERRED (see below) |
| A6 | `FileEventRecord.recordedAtMs` finiteness invariant unbranded (type-design-analyzer) | add `RecordedAtMs` brand + `parseRecordedAtMs` in event-record.ts over the single finiteness clause; `recordedAtMs: RecordedAtMs`; mint at the journal's own finiteness-checked clock seam; consume in serialize/parse. Zero runtime behavior change; keep it distinct from `isRepresentableTimestampMs` (D6 two-domain split intact) |
| A7 | readClock docblocks reference the pre-D6 "per-method blocks" (comment-analyzer) | trim the transitional clauses in file/checkpointer.ts:313 and file/freshness-index.ts:438, keeping the load-bearing content and resolvable cross-pointers |
| A8 | gitignored review-run paths in module headers (comment-analyzer) | delete the `.claude/reviews/…` paths from checkpointer-codec.ts:4-5 and verified-directory.ts:3-4; keep the lasting provenance (the codec-separation split) |
| A9 | serialize.ts:57 depth sentence off-by-one (comment-analyzer) | "the envelope (or node output) is scanned at depth 1, its children at depth 2" — matching the code and resume-proof.ts's pinned statement |
| A10 | types/freshness.ts:15 adapter enumeration omits the file backend (comment-analyzer) | add the file backend to the enumeration |
| A11 | stacked contradictory `InMemoryStoredMeta` docblocks (comment-analyzer) | delete the pre-D4 "Internal storage shape… public type stays clean" docblock; merge its still-true content into the D4 docblock |
| A12 | boundary-error.ts:107 "ONE encoding" enumeration omits resume.ts (comment-analyzer) | add the `resumeFileJob` directory gate to the enumeration |
| A13 | apps/customer-summary bootstrap.ts unqualified observability-spec citations collide with F6 numbers (comment-analyzer) | qualify the `apps/customer-summary/src/bootstrap.ts` citations with their owning spec (`observability spec FR-xxx` form, each verified against the 2026-05-30 azure-foundry-observability spec) and widen the CONTEXT.md note's scope sentence to cover the app |
| A14 | — | DEFERRED (see below) |
| A15 | ADR-0080 table / pinned ride-through / journal behavior disagree on the freshness operation field (architecture-tech-lead) | same root as A1: re-tag lock-protocol-boundary failures at the freshness public surface, mirroring journal.ts:413 — in `recordWrite`/`findConflict` outer catches, a caught typed FrameworkError whose operation is in the closed lock-protocol set (`acquireFileLock`/`withFileLock`/`releaseFileLock`/`stealStaleFileLock`, defined once where `FileOperation` lives) is re-tagged via `fileOperationError` to `freshness:recordWrite`/`freshness:findConflict`, preserving the inner `failureClass` and diagnostic chain; body-internal typed failures (already port-operation) ride through unchanged. Update the ride-through pin (file-freshness-index.test.ts:876-899: the lock-squatter acquire case now asserts `freshness:recordWrite`, lock path still in the message) and ADD a deterministic in-body commit-failure operation pin (test-only seam threading `AtomicWriteFileTestHooks` through `FileFreshnessIndexOptions`, tmp-path squatter). Amend ADR-0080's FreshnessIndex row to state the re-tag explicitly; correct the inaccurate "journal.ts parity" comment. |
| A16 | duplicate `TTL_SECONDS` in redis-checkpointer.ts:11 (code-simplifier) | import the port's `TTL_SECONDS` from `checkpoint/checkpointer.js` (same file the module already imports); delete the local const — byte-identical at every use, and makes the port docblock's "ONE encoding" claim true |
| A17 | dead test hooks `afterFenceEstablished`/`inspectReleasePath` in atomic.ts (code-simplifier) | delete both `FileLockTestHooks` fields and their reference sites (`await hooks.afterFenceEstablished?.()` in fencedReap; the `if (hooks.inspectReleasePath !== undefined) … else lstatSync` branch in `releaseLockIsAbsent` collapses to the plain `lstatSync`). Behavior-neutral (production always passed `{}`); re-verify zero consumers workspace-wide before deleting |

Deferred (2) — concrete evidence-based reasons:

- **A5** (pr-test-analyzer): `packages/host` `bun test` intermittently exits 0 mid-suite without a summary (2 of 3 observed runs; per-file runs pass; no `process.exit`/`afterAll` found in handler tests). **Reason:** no mechanism identified — the reviewer timeboxed without a root cause, and a detection-only gate change ("require the summary line") does not fix the underlying silent early exit while risking false reds on healthy runs. Needs a dedicated investigation with a stable repro; tracked here and reported to the operator.
- **A14** (architecture-tech-lead): extract `freshness-index.ts`'s pure decision core (score monotonicity, Redis reverse-binary tie order, lazy TTL, ADR-0079 singleton codec) into a `freshness-codec.ts` pure module. **Reason:** a large behavior-preservation refactor of the highest-risk parity logic in the branch, explicitly not covered by the 2026-08-18 deepening round; the current shape works and is tested (temp-dir harnesses + `__test*` seams); the reviewer's own rating is "leverage, not wrongness". The right vehicle is a dedicated deepening round (which would also retire the `__test*` exports); doing it inside a review-remediation round couples an optional refactor to mandatory fixes.

Dismissed: none.

## Refuted-finding audit

None. The registered Refutation Panel refuted zero criticals (`result.json.refuted_critical_findings` is empty; every surviving finding's per-lens verdicts are retained in `result.json.panel.outcomes` and the verifier transcripts in the run directory).

## Files changed

In frozen scope: `packages/framework/src/file/resume.ts`, `packages/framework/src/__tests__/file-resume.test.ts`, `packages/framework/src/__tests__/cli/cli.test.ts`, `packages/framework/src/checkpoint/redis-checkpointer.ts`, `packages/framework/src/checkpoint/checkpointer.ts`, `packages/framework/src/file.ts`, `CONTEXT.md`, `docs/adr/0077-resume-agreement-proof-log-authoritative-checkpoint-may-lag.md`, `docs/adr/0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md`, `packages/framework/src/observer/buffered.ts`, `packages/framework/src/file/freshness-index.ts`, `packages/framework/src/file/event-record.ts`, `packages/framework/src/file/checkpointer.ts`, `packages/framework/src/file/checkpointer-codec.ts`, `packages/framework/src/file/verified-directory.ts`, `packages/framework/src/state-machine/serialize.ts`, `packages/framework/src/types/freshness.ts`, `packages/framework/src/file/boundary-error.ts`, `packages/framework/src/file/atomic.ts`, `packages/framework/src/file/journal.ts` (RecordedAtMs mint), `packages/framework/src/__tests__/_checkpointer-suite.ts`, `packages/framework/src/__tests__/redis-checkpointer.test.ts` (pin relocation/adjustment), `packages/framework/src/__tests__/file-freshness-index.test.ts`, `packages/framework/src/__tests__/buffered-observer.test.ts`, `apps/customer-summary/src/bootstrap.ts`, plus the 13 in-scope `packages/host/src/supervisor/**` files with citations.

Support paths (NOT in frozen scope — registered in the remediation start input):
- `.claude/plans/2026-08-18-pr-remediation-round-17.md` (this plan)
- `packages/host/src/supervisor/bootstrap/parse-bootstrap.ts`
- `packages/host/src/supervisor/lifecycle/purge-keyspace.ts`
- `packages/host/src/supervisor/lifecycle/spawn-port.ts`
- `packages/host/src/supervisor/registry/parse-tenant-config.ts`
- `packages/host/src/supervisor/routing.ts`
- `packages/host/src/supervisor/secrets/env-file-secrets-source.ts`
- `packages/host/src/supervisor/secrets/redis-acl.ts`
- `packages/host/src/supervisor/secrets/secrets-source.ts`

## Validation

1. `cd packages/framework && bun run typecheck` (both tsconfigs)
2. `bun test packages/framework` — full framework suite green (SC-005), including the re-pinned A4 (run ≥3× under load to confirm the straddle class is gone) and the new error-precedence + freshness-operation + shared-suite `__proto__` pins
3. `bun packages/framework/scripts/check-imports.ts` (SC-006 boundary gate)
4. `bun test packages/host` (supervisor suites; require the summary line — see deferred A5) + host typecheck
5. `bun test apps/customer-summary` + app typecheck
6. workspace lint (bun run lint if wired)
