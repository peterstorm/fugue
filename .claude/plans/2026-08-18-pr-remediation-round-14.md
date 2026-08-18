# PR Remediation Plan — Round 14 (2026-08-18)

## Identity

- **Branch:** `feat/f6-file-durable-runtime` (head `5f80c85`, base `origin/main` @ `6c316cb`)
- **Scope:** engine-derived changed-path union `origin/main...HEAD` — 307 files, ~30k additions (F6 file-backed durable runtime + host supervisor/registry/sync wave + plans/specs/ADRs)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-08-18T09-22-f6-file-durable-runtime-review`
- **Canonical result:** `result.json` (digest `7a344297d9b9b57046682b206468c0bf570509f6203423c10a0800bb91c93974`, 30,827 bytes) — sole authoritative remediation input
- **Roster:** 7 reviewers (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier)
- **Refutation Panel:** lenses `reproduction`, `intent`, `blast-radius`; threshold 2; outcome 3/3 upheld

## Review outcome (from `result.json`)

- Critical claims raised: 1 (comment-analyzer)
- **Surviving criticals: 1** (mandatory)
- **Refuted criticals: 0** — panel audit: `standalone-review:comment-analyzer-1` upheld by all three lenses (`refuted_by: []`); no other critical was ever raised
- Advisory claims: 13 — dispositions below (11 accepted, 2 deferred, 0 dismissed)

## Surviving critical findings — mandatory fixes

### C1 — `CONTEXT.md:176` — stale `HostError` variant count (comment-analyzer-1)

- **Claim (canonical):** "CONTEXT.md:176 describes domain/host-error.ts as a \"28-variant discriminated union\" but the frozen HostError union has 33 variants, so the count is stale"
- **Verified against worktree:** line 176 reads ``| `domain/host-error.ts` | 28-variant discriminated union, exhaustive HTTP mapping |``; `packages/host/src/domain/host-error.ts` declares **33** `kind` variants (counted; corroborated by the 33 `.with` arms in `httpStatusFor` and `formatHostError`).
- **Panel evidence:**
  - *reproduction*: mismatch reproduces; actionable staleness claim confirmed from code.
  - *intent*: table row is a present-tense inventory with no pinned baseline; the five post-28 kinds carry deliberate design comments (AD-10 multi-tenant block + later additions) — 28 matches no intentional subset.
  - *blast-radius*: defect is real and confined to the single named doc line; the verifier cautioned the fix must use the verified count or drop the brittle number.
- **Concrete fix:** replace the brittle count with the rot-resistant invariant (the finding's own "better" suggestion, endorsed by the blast-radius lens):
  - `| `domain/host-error.ts` | Discriminated union of host errors, exhaustively mapped to HTTP status via `httpStatusFor` |`
  - No other line changes. Sibling counts that are currently accurate (line 40 "27 error kinds", line 81 "13 event types") are untouched — they are not in this finding's scope.

## Advisory dispositions (all 13)

### Accepted — 11 (fixes below)

| # | id | file:line | disposition |
|---|----|-----------|-------------|
| A1 | silent-failure-hunter-1 | `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts:449` | **accepted** — verified asymmetry: `onCrash` chain is caught, the drain branch (and `clock()`/`logger.error`/`drainComplete` throws inside the callback) is not; a throw escapes as an unhandled rejection with the supervisor's rejection policy set outside scope. Sound claim, small local fix that only adds a logged attribution path. |
| A2 | pr-test-analyzer-1 | `packages/framework/src/file/journal.ts:322` | **accepted** — ADR-0078's headline contract is a *journal* contract, but stale-lock reaping is pinned only at the `withFileLock` primitive (file-atomic.test.ts:657). Closing it end-to-end through `createFileJournal` is practical with the existing child-process helpers. |
| A3 | pr-test-analyzer-2 | `packages/framework/src/file/checkpointer.ts:496` | **accepted** — `load()` on a run path squatting with a regular file is unpinned; the US2 contract ("unknown run ⇒ clean `null`") and the "filesystem conflict ⇒ typed error" verdicts need one test to distinguish them. Small. |
| A4 | pr-test-analyzer-3 | `packages/framework/src/file/resume.ts:191` | **accepted** — NFR-001's end-to-end claim ("crash at any point ⇒ recover or fail closed, never partially observed state") is strongest proven at the resume seam with a real child writer; currently pinned only at the `atomicWriteFile` primitive. Child-writer pattern already exists in file-resume.test.ts. |
| A5 | pr-test-analyzer-4 | `packages/framework/src/file/freshness-index.ts:472` | **accepted** — EISDIR class missing for the per-resource `<digest>.json` singleton in `recordWrite`/`findConflict`; sibling modules already carry the errno-class matrix. Small. |
| A6 | pr-test-analyzer-5 | `packages/framework/src/file/job.ts:144` | **accepted** — throwing getters on seed/`updateData` `state`/`context` fields are pinned on the checkpointer metadata surface but not the job surface; same guard, same shape. Small. |
| A8 | type-design-analyzer-2 | `packages/framework/src/file/checkpoint-record.ts:51` | **accepted** — verified: `serializeFileCheckpoint(undefined/null/42)` mints a valid commit because the sole envelope gate (`hasOwnProperty("data")`) passes on the `__undefined__` tag and the deep-equal compares caller-vs-bytes (catches loss, never shape). The sibling `serializeFileEventRecord` explicitly rejects a top-level `undefined` event with a named FR-009 reason (event-record.ts:820). Making the write boundary match its own `FileCheckpointData` type is a few lines + test pins. Pre-merge branch: no external consumers of a public API to break. |
| A9 | comment-analyzer-2 | `CONTEXT.md:20` | **accepted** — verified: Phase row lists 7 of 8 `DagPhase` kinds, omitting `suspended` (ADR-0060). One-word doc fix, same file as C1. |
| A10 | comment-analyzer-3 | `packages/framework/src/file/journal.ts:110` | **accepted** — verified orphaned JSDoc block (parseEventFileName naming contract) floating between `fsFailure` and `journalCapacityError`'s doc; its unique "parity in both directions" sentence belongs in the `listEventFiles` doc. Comments-only. |
| A12 | code-simplifier-1 | `packages/framework/src/file/freshness-index.ts:437` | **accepted** — verified: `recordWrite` (L437-470) and `findConflict` (L549-582) inline byte-parallel clock-guard pairs differing only in operation literal and context phrase; both checkpointer backends already consolidated this exact pair into `readClock` (file/checkpointer.ts:313, checkpoint/checkpointer.ts:285). In-wave distill move, messages/classes stay byte-identical, covered by the existing 58+ call-site tests. |
| A13 | code-simplifier-2 | `packages/framework/src/file/event-record.ts:31` | **accepted** — verified: the `-0`→`0` / `===`-not-`Object.is` rationale is stated in full at 4 sites (L31 header, L85, L436, L785), against the module's own one-canonical-site-plus-pointers policy. Comments-only. |

### Deferred — 2 (concrete reasons)

| # | id | file:line | reason |
|---|----|-----------|--------|
| A7 | type-design-analyzer-1 | `packages/framework/src/file/checkpointer-codec.ts:402` | **Deferred to the scheduled `file/` deepen round.** Consolidating `assertLosslessEvent` and `materializeCanonicalOutput` into one shared primitive is a seam/interface change (deepening, not distill), and the round-13 simplifier audit already records this item as a tracked deepening deferral pending the `toJSON`-gate divergence ruling. No wrongness rides on it now: both boundaries remain fail-closed and the divergence only surfaces on rare hostile shapes (set-only accessor, sparse array). |
| A11 | architecture-tech-lead-1 | `packages/framework/src/file/freshness-index.ts:311` | **Deferred to the scheduled `file/` deepen round.** Extracting the FreshnessIndex pure core is a structural change (new module, rewiring, new test file) and is already a tracked deepening deferral on the round-13 record ("freshness decision-core extraction … belongs to the scheduled deepen round"). The ADR-0079 algorithm is fully integration-pinned (1147-line suite, 58 call sites) and no correctness defect is open in the interim; 4/5 backends follow the pattern, so the debt is bounded and scheduled. |

### Dismissed — 0

## Accepted-advisory fixes (concrete)

1. **A1** — `worker-lifecycle-manager.ts:449`: append `.catch((e) => logger.error("[worker-lifecycle] exit watcher threw", { tenant, error: e instanceof Error ? e.message : String(e) }))` to the outer `void handle.exited.then(…)` chain (mirrors the existing `onCrash` catch shape). No behavior change on the success path; a previously-unhandled rejection becomes a logged, tenant-attributed error.
2. **A2** — `file-journal.test.ts`: new test — a spawned child acquires `<dir>/events/append.lock` (via `withFileLock` or direct lock-file creation matching the crashed-writer layout), is killed without release; a fresh process then `createFileJournal(dir)` + `appendEvent` succeeds after the stale lock is reaped (asserts the event file lands with the correct name/digest).
3. **A3** — `file-checkpointer.test.ts`: new test — run path created as a **regular file**; `checkpointer.load(runId)` resolves to `err` with kind `cache-error`, operation `load` (never `ok(null)`, never raw throw).
4. **A4** — `file-resume.test.ts`: new cross-process test — child writer appends N events with a delay; parent calls `resumeFileJob` repeatedly during the write window; every observed state is a consistent prefix (all-or-nothing per append) and the final observation equals the full N.
5. **A5** — `file-freshness-index.test.ts`: new test — a **directory** squats `<resourceDigest>.json`; `recordWrite` and `findConflict` both fail closed with typed `cache-error` (EISDIR class), no raw escape.
6. **A6** — `file-job.test.ts`: new test — hostile `Object.defineProperty` throwing getters on seed and `updateData` `state`/`context` fields; every call returns a typed failure (no raw rejection), mirroring the checkpointer metadata pin (file-checkpointer.test.ts:460).
7. **A8** — `checkpoint-record.ts`: in `serializeFileCheckpointUnchecked`, before the pre-scan, reject non-object `data` with a named reason mirroring the event-record sibling: `data must be a plain object or null-typed checkpoint state, got <runtime type> — the reader cannot reconstruct a non-object FileCheckpointData (FR-009)`. Wait — decision: reject `undefined`, `null`, arrays, and primitives (`typeof` not `object`); the `FileCheckpointData<S,C>` shape is `{ state, context }` (plain object). Pin with tests: `undefined`/`null`/`42`/`[]` each throw the typed `serializeFileCheckpoint` rejection (closed `cache-error` via the existing shell), and a valid object still round-trips.
8. **A9** — `CONTEXT.md:20`: Phase row becomes `` `pending`, `running`, `retrying`, `awaiting-human`, `suspended`, `retrying-hook`, `succeeded`, `failed` ``.
9. **A10** — `journal.ts`: move the "parity in both directions" sentence from the orphaned block (L108-117) into the `listEventFiles` doc block, then delete the orphaned block.
10. **A12** — `freshness-index.ts`: add module-private `readClock(operation: "freshness:recordWrite" | "freshness:findConflict", digest: string, contextPhrase: string): Result<number, FrameworkError>` reproducing the exact current messages (`clock failed while stamping the write: …` / `clock failed while evaluating the freshness TTL: …` / `clock must return a finite timestamp`) and the `permanent` class; use it in both sites; delete the duplicated inline pairs.
11. **A13** — `event-record.ts`: keep the full `-0` rationale at the header FR-009 paragraph (L25-31); reduce L85, L436, L785 to one-line pointers to that paragraph.

## Refuted-finding audit

None. `refuted_critical_findings: []` — the single critical claim raised (comment-analyzer-1) was upheld 3/3 by the panel; nothing was refuted, so nothing is audited-out. No finding is fixed on refutation evidence (invariant: refuted criticals are never fixed).

## Files changed by this remediation

- `CONTEXT.md` (C1, A9)
- `packages/host/src/supervisor/lifecycle/worker-lifecycle-manager.ts` (A1)
- `packages/framework/src/file/checkpoint-record.ts` (A8)
- `packages/framework/src/file/journal.ts` (A10)
- `packages/framework/src/file/freshness-index.ts` (A12)
- `packages/framework/src/file/event-record.ts` (A13)
- `packages/framework/src/__tests__/file-journal.test.ts` (A2)
- `packages/framework/src/__tests__/file-checkpointer.test.ts` (A3)
- `packages/framework/src/__tests__/file-resume.test.ts` (A4)
- `packages/framework/src/__tests__/file-freshness-index.test.ts` (A5)
- `packages/framework/src/__tests__/file-job.test.ts` (A6)
- `packages/framework/src/__tests__/file-checkpoint-record.test.ts` or the existing checkpoint-record test home (A8 pins) — to be confirmed against the existing suite layout during implementation

Support path (not in reviewed scope, registered in remediation start): `.claude/plans/2026-08-18-pr-remediation-round-14.md`

## Validation commands

1. `bun run typecheck` (root — all workspaces)
2. `bun test packages/framework` (full framework suite, incl. the new file-backend tests)
3. `bun test packages/host` (full host suite, covers A1)
4. `bun run check:docs` (doc links, after CONTEXT.md edits)

All must pass before remediation installation.
