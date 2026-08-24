# PR Remediation Plan — 2026-08-17 (Round 6)

**Branch:** `feat/f6-file-durable-runtime`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-120118-f6-file-durable-runtime`
**Authority:** `result.json` (tally-published, digest `c47ad62a8288ffd9b38f9317b804ec618abf60c3a361f45b7f2357502cb4eb9c`)
**Head at review:** `d39fd38` (base `6c316cb5`)

## Review outcome

- Reviewers: 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier) — 66 frozen files.
- Raw criticals: 4 · **Surviving criticals: 4** · **Refuted criticals: 0** · Advisories: 21.
- Refutation Panel: 3 lenses (reproduction / intent / security), `review-verifier-agent` × 3, threshold 2, pinned by the engine tally.
- architecture-tech-lead emitted no findings (confidence ≥75 gate); every prior-round fix (C1–C4, A1–A19 of the 2026-08-17 plan, deferrals D1/D2) verified landed in the frozen source.

## Refuted-finding audit

None. All four surviving criticals were upheld 3/3 (reproduction + intent + security) with no refuting evidence. No `refuted_critical_findings` entries exist in `result.json`.

## Surviving criticals (all mandatory)

### C1 — `code-reviewer-1` — `file/event-log.ts:111`
**Claim (panel-upheld 3/3):** `readStrict`'s deterministic-squat gate pins `ENOTDIR`, but the documented scenario — a non-regular entry (a directory) squatting a record name — makes `readFileSync` throw **`EISDIR`** (verified on node and bun). The adjacent comment claims "pin 'permanent', parity with the append-time gate in journal.ts `listEventFiles`", and that gate does pin `"permanent"` for the identical condition; the pinned test (`file-journal.test.ts:1076`) documents EISDIR yet asserts `failureClass` undefined / `retriable`. Three-way contradiction: comment ↔ errno check ↔ sibling gate.
**Analysis:** at this site (per-file read AFTER a successful `readdirSync(eventsDir)`), `ENOTDIR` can only come from a component substituting between listing and read — the race case the comment itself classifies as environment. The deterministic squat is `EISDIR`. The current pin thus misclassifies in both directions.
**Fix:** pin `EISDIR` (not `ENOTDIR`) as the deterministic-squat errno at `event-log.ts:111`; rewrite the comment to state exactly that (directory / symlink-to-directory squat ⇒ EISDIR ⇒ permanent, parity with `listEventFiles`; every other errno, including a racing ENOTDIR, stays environment-class). Update the `file-journal.test.ts:1076` pin to `failureClass: "permanent"` + `retriabilityOf: "non-retriable"` and correct its comment (it is deterministic, not an environment failure — only manual removal clears it).

### C2 — `silent-failure-hunter-1` — `checkpoint/checkpointer.ts:308` (+ `:312`)
**Claim (panel-upheld 3/3):** `saveNode`'s catch re-interpolates the hostile raw `nodeId` (`` `state for node ${nodeId} is not cloneable…` ``), so a brand-bypassed non-string `nodeId` whose `toString` throws rejects the async port with a raw untyped value instead of a `checkpoint-write-failed` `Result` — directly contradicting the `checkpointWriteFailed` doc in the same file ("never throws on a hostile raw `nodeId`", FR-040). The security lens additionally verified a second escape at `:312`: the computed map key `[nodeId]` coerces the raw `nodeId` outside any guard on the success path.
**Fix (total, string-behavior byte-identical):**
1. Catch message renders the id through `safeDiagnosticRender(nodeId)` (total — never executes a throwing `toString`).
2. Add the file backend's exact `stringOf` discipline as a module-private total key renderer (`string` ⇒ identity; non-string ⇒ `String` in try, `"<unprintable>"` on throw) and use it for the storage key `[stringOf(nodeId)]`. Valid string ids key exactly as before; hostile ids never reject raw and degrade to the documented unprintable placeholder instead of throwing. (Rejecting non-boundary ids in the in-memory backend is the port-branding revision — deferred D-item territory, not this fix.)
3. New hostile-input pins in `redis-checkpointer.test.ts` (in-memory totality block): throwing-`toString` nodeId with non-cloneable state ⇒ typed `checkpoint-write-failed`; throwing-`toString` nodeId with cloneable state ⇒ resolves (no raw rejection); `invalidNodeId` renders bounded.

### C3 — `silent-failure-hunter-2` — `checkpoint/checkpointer.ts:279`
**Claim (panel-upheld 3/3):** `load`'s stored-state catch passes the raw `runId` to `frameworkError.checkpointCorrupt`, whose `toRunId` re-validation stringifies non-strings (and a hostile `toString` can throw building that message), so a hostile `runId` object stored by `setMeta` under the same Map reference escapes the very catch whose comment says "ADR-0080 forbids a raw rejection here". Reachable deterministically (`setMeta(h, meta)` then `load(h)` with one hostile reference + non-cloneable state).
**Fix (total):**
1. The try-block `what` string (`` `checkpoint nodes for ${runId}` ``) renders `runId` through `safeDiagnosticRender` (total on the trigger path).
2. The catch constructs the error without re-branding an unvalidated value: grammar-valid `runId` (string matching `ID_PATTERN`) goes through `frameworkError.checkpointCorrupt` exactly as today; any other raw value yields a literal `{ kind: "checkpoint-corrupt", runId: INVALID_RUN_ID, message: …safeDiagnosticRender(runId)… }` with a new module-private `INVALID_RUN_ID: RunId = __brandRunId("checkpoint_invalid_run")` placeholder (identical string to the file backend's — the `checkpoint-corrupt` variant has no additive `invalidRunId` field, so the rejected bytes ride safely in the message, per the errors.ts rendering contract).
3. New pin: hostile `runId` + undetachable stored state ⇒ typed `checkpoint-corrupt`, never a raw rejection; a plain non-string (e.g. `42`) + undetachable state ⇒ typed `checkpoint-corrupt` (the `toRunId` throw class).

### C4 — `code-simplifier-1` — `checkpoint/checkpointer.ts:166`
**Claim (panel-upheld 3/3):** in-memory `checkpointWriteFailed` stores `invalidNodeId: safeDiagnosticRender(nodeIdRaw)` — a JSON-quoted, 60-char-truncated diagnostic — while the file backend twin (`writeFailed`, `checkpointer-codec.ts:115-118`) and the type contract (`types/errors.ts:78-82`: the field carries the rejected **RAW bytes**; bounding is `formatFrameworkError`'s job) carry the raw string. Same invalid input ⇒ different structured errors across backends, and `formatFrameworkError` double-renders the in-memory value into escaped quotes. Secondary facet of the same split: the in-memory variant never emits `invalidRunId` while the file variant re-renders it.
**Fix (single encoding, mirrors `writeFailed`):**
1. `invalidNodeId` carries the raw bytes via the same total `stringOf` renderer as C2 (string ⇒ unmodified raw; non-string ⇒ total `String` with `<unprintable>` fallback). No pre-truncation, no pre-quoting — `formatFrameworkError` remains the single bounding point.
2. Run the same truthfulness check on `runId` (string + `ID_PATTERN`): invalid raw `runId` ⇒ `INVALID_RUN_ID` placeholder (from C3) + additive `invalidRunId: stringOf(runIdRaw)`, making the "parity with the file backend's construction" doc at `:150-163` true on both fields.
3. Update the doc comments accordingly. Pin in `redis-checkpointer.test.ts`: for a string invalid `nodeId`, `invalidNodeId` is the unmodified raw string (no quotes/truncation — extends the loose `toBeDefined()` pin at `:82`), and `formatFrameworkError` output is bounded without double-quoting.

## Advisory dispositions (21 total: 19 accepted · 2 deferred · 0 dismissed)

### Accepted (19)

| # | Finding | Fix |
|---|---------|-----|
| A1 | `silent-failure-hunter-3` — `file/atomic.ts:390` documented "≈5 s" ceiling understates the worst case: each stale-owner/tomb attempt also `await`s `fencedReap`'s own 50×100 ms birth-barrier wait, so a stalled live contender can stretch wall time to ~50×5 s | Correct the `acquireFileLock` JSDoc: ≤50 acquire attempts × 100 ms backoff is the backoff budget; each stale-owner/tomb attempt additionally nests one bounded `fencedReap` birth-barrier wait (50×100 ms), so the absolute worst case is larger than ≈5 s — the typed `cache-error(acquireFileLock)` still always fires (never a hang). Behavior unchanged (folding the budgets would alter pinned concurrency semantics). `file-atomic.test.ts:695`'s "documented ~5s ceiling" cross-reference stays accurate for the backoff budget — adjust its wording only if it overclaims the absolute bound. |
| A2 | `silent-failure-hunter-4` — `scripts/check-imports.ts:478` bypass audit misses destructured bindings: `const { cacheError } = frameworkError; cacheError(…)` is a bare-identifier call the AST gate cannot attribute | In `findFileCacheErrorBypasses`, collect local bindings initialized from the imported `frameworkError` (destructuring `const { cacheError } = frameworkError` / `ns.frameworkError`, and direct member refs `const cacheError = frameworkError.cacheError`) and flag bare-identifier `cacheError(…)` calls bound to them; add gate fixtures (positive: destructured bypass is caught; negative: a same-named local not derived from the import is not flagged) to `boundary-imports.test.ts`. |
| A3 | `pr-test-analyzer-1` — `freshness-index.ts:475` ADR-0079 recordWrite-over-corrupt-singleton fail-closed is unpinned (only the findConflict warn+absent side is tested) | Pin in `file-freshness-index.test.ts`: seed a corrupt singleton, `recordWrite` ⇒ `err` with `operation: "freshness:recordWrite"`, `failureClass: "permanent"`, corrupt bytes byte-identical on disk afterward. |
| A4 | `pr-test-analyzer-2` — `journal.ts:302` `appendEvent`'s `mkdirSync(eventsDir, { recursive: true })` create-failure path has no typed `cache-error(appendEvent)` pin | Pin in `file-journal.test.ts`: squatted `events` path (file where dir expected) and unwritable parent ⇒ typed `cache-error` `appendEvent` (not a raw throw, not misclassified permanent). |
| A5 | `pr-test-analyzer-3` — `file/checkpointer.ts:605` symlinked `nodes/<digest>.json` has no end-to-end pin through the load shell | Pin in `file-checkpointer.test.ts`: symlinked node entry ⇒ typed `cache-error(load)` naming the entry (never a drop, never a corrupt verdict). |
| A6 | `pr-test-analyzer-4` — `state-machine/serialize.ts:99` `validateSerializedValueGrammar` options-validation branches never exercised | Pin in `state-machine-serialize.test.ts` (support path): `maxDepth`/`initialDepth` non-safe-integer/negative ⇒ `err` with the exact messages. |
| A7 | `pr-test-analyzer-5` — `file/checkpointer.ts:253` own-key `now` with captured value `undefined` (treated as omission ⇒ `Date.now`) unpinned | Pin in `file-checkpointer.test.ts`: `createFileCheckpointer(dir, { now: undefined })` behaves exactly like `createFileCheckpointer(dir)` (accepts, `Date.now` default) — the documented grammar edge. |
| A8 | `type-design-analyzer-1` — `TTL_SECONDS` (24h port contract) encoded twice: export in `file/layout.ts:82` + module-private copy in `checkpoint/checkpointer.ts:17` | Export `TTL_SECONDS` from the port file `checkpoint/checkpointer.ts` (the contract owner — FR-027 expiry semantics) and import it in `file/layout.ts`; delete the layout copy. The Redis backend's copy is outside the review scope — noted, not touched. |
| A9 | `type-design-analyzer-2` / `code-simplifier-5` (same sites) — `isBoundaryIdString` (`checkpointer-codec.ts:203` / `freshness-index.ts:105`) and `isPlainRecord` (`:182` / `:99`) hand-duplicated | Hoist both to `file/layout.ts`: `isBoundaryIdString` beside its `isBoundaryId` owner (guard form), `isPlainRecord` as the shared plain-record predicate; import from `checkpointer-codec.ts` and `freshness-index.ts`, delete the private copies (keep the "one rule, two views" doc on the layout.ts guard). |
| A10 | `type-design-analyzer-3` / `code-simplifier-4` (same contract) — event-file naming triple-encoded: `layout.eventFileName` + `journal.ts:116` `EVENT_FILE_NAME_PATTERN` regex + `event-log.ts:74` `prefixOf` | Add `parseEventFileName(name): Readonly<{sequence: number; digest: string}> \| null` to `layout.ts` (owns the pattern). `journal.ts` listing gate consumes `parseEventFileName(name) === null` (identical rejection set; local regex deleted). `event-log.ts` check 1 becomes `parseEventFileName(name) === null \|\| parsed.sequence !== record.sequence` with the same message (local `prefixOf` deleted). Outcome-identical for every well-formed name (both pinned message tests keep firing at their current checks); a malformed name whose 6-char prefix happens to match now fails at check 1 instead of check 3 — same `permanent` class, diagnostic-order refinement, unpinned input. |
| A11 | `type-design-analyzer-4` — `file/job.ts:154` `data` getter typed plain `{ state: S; context: C }` though it returns a deep-frozen clone per the documented snapshot contract | Type the getter return as `Readonly<{ readonly state: S; readonly context: C }>` and move the frozen-clone contract sentence onto the type; document the Map/Set/Date clone-isolation carve-out there. Type-only change. |
| A12 | `type-design-analyzer-6` — `saveNodeBoundaryViolation` (`checkpointer-codec.ts:831`) misnames its Ok side (returns the parsed canonical value) | Rename to `parseSaveNodeBoundary` (exported; update the two importers: `file/checkpointer.ts` and `file-checkpointer-codec.test.ts`), keeping the parse-named sibling convention (`parseLoadOpts`/`parseStoredMeta`/`parseNodeFile`). |
| A13 | `comment-analyzer-1` — "advisory A8 of the 2026-08-14 PR remediation" provenance citation does not resolve anywhere in the tree (plan file rewritten in place by later rounds) — 5 sites | Make the provenance self-contained: `extracted from checkpointer.ts during the 2026-08-14 codec separation remediation (pure core split from the I/O shell) — see review run .claude/reviews/review-and-fix-runs/standalone-2026-08-14-f6-file-durable-runtime`; phrase the "1,600-line adapter" claim as historical ("the pre-split adapter"). Sites: `file/checkpointer-codec.ts:3`, `file/verified-directory.ts:2-3`, `file/checkpointer.ts:60/:131`, `__tests__/file-checkpointer-codec.test.ts:3-4`. |
| A14 | `comment-analyzer-2` — write-side losslessness enforcement in `event-record.ts`/`checkpoint-record.ts` is tagged `(FR-009)`, but the frozen spec's FR-009 mandates only read-side strict validation | Amend `.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md` FR-009 to state BOTH duties the code already implements: (1) the writer enforces losslessness at the write boundary (pre-scan + round-trip backstop — anything the serializer cannot represent losslessly is rejected before bytes exist), and (2) the reader strictly validates every record and fails closed. The existing read-side text is preserved; the write-side duty is added under the same number the code already cites in comments and runtime error strings. |
| A15 | `code-simplifier-2` — `parseDecimalComponent` (`composite-node-key.ts:151`) unused `kind` parameter | Delete the parameter; drop the `"index"`/`"attempt"` literals at both call sites (`:199`, `:201`). |
| A16 | `code-simplifier-3` — `checkpoint/checkpointer.ts:131` mid-file `import { err }` | Merge into the top import block (join the existing `import { ok }` from `../types/result.js`). |
| A17 | `code-simplifier-4` — `event-log.ts:74` `prefixOf` duplicates `layout.ts:165` `pad6` | Resolved by the A10 change (single `parseEventFileName` encoding; no local padding helper remains in `event-log.ts`). |
| A18 | `code-simplifier-5` — `isBoundaryIdString`/`isPlainRecord` verbatim duplication | Resolved by the A9 change (single home in `layout.ts`). |
| A19 | `code-simplifier-7` — `llm/fake-client.ts:110-317` eleven identical `{ kind: "node-crash", retriability: "retriable", nodeId: req.nodeId, message }` literals | One local `crash(message)` builder per method (`sendStructured`/`sendWithTools`); the single deliberate `non-retriable` iteration-limit site stays explicit and stands out. Byte-identical error values (message-only change sites are the collapsed literals). |

### Deferred (2)

| # | Finding | Reason |
|---|---------|--------|
| D1 | `type-design-analyzer-5` — `Checkpointer` port leaves the node address unbranded (`saveNode` `nodeId: string`, `NodeState.nodeId`, `RunState.nodes` keyed by raw nodeKey strings) | FR-040 freezes the public port signature; branding `NodeId`/`NodeKey` is a public type-surface change that alters fold behavior for structurally-matching raw types and requires a compatibility decision + ADR (same class as the prior round's D1). The file backend's boundary re-validation + truthful branding compensates in the interim (verified by this review). Schedule for the next port/state-machine design pass. |
| D2 | `code-simplifier-6` — `checkpointerCacheError` (`file/checkpointer.ts:151`) is a pure pass-through to `fileCacheError`, adding only a re-narrowing to the 3-op `FileCheckpointerCacheOperation` alias | The reviewer explicitly rated this the lowest-value finding and left the choice open ("keeping it is defensible"). The alias is a deliberate module-local vocabulary marker at ~10 call sites (a checkpointer operation typo is a compile error), it adds zero behavior, and both sides are typed to the same closed `FileOperation` — no drift risk exists today. Recording the retention as a deliberate choice; revisit if a second in-module wrapper pattern appears. |

### Dismissed

None.

## Remediation file set

Production (all in review scope):
- `packages/framework/src/file/event-log.ts` (C1 + A10)
- `packages/framework/src/checkpoint/checkpointer.ts` (C2/C3/C4 + A8 export + A16)
- `packages/framework/src/file/layout.ts` (A8 + A9 + A10)
- `packages/framework/src/file/journal.ts` (A10)
- `packages/framework/src/file/checkpointer-codec.ts` (A9 + A12 + A13)
- `packages/framework/src/file/checkpointer.ts` (A13)
- `packages/framework/src/file/freshness-index.ts` (A9)
- `packages/framework/src/file/verified-directory.ts` (A13)
- `packages/framework/src/file/job.ts` (A11)
- `packages/framework/src/file/atomic.ts` (A1)
- `packages/framework/src/checkpoint/composite-node-key.ts` (A15)
- `packages/framework/src/llm/fake-client.ts` (A19)
- `packages/framework/src/scripts/check-imports.ts` (A2)

Tests:
- `packages/framework/src/__tests__/file-journal.test.ts` (C1 pin + A4)
- `packages/framework/src/__tests__/redis-checkpointer.test.ts` (C2/C3/C4 pins)
- `packages/framework/src/__tests__/file-freshness-index.test.ts` (A3)
- `packages/framework/src/__tests__/file-checkpointer.test.ts` (A5 + A7)
- `packages/framework/src/__tests__/boundary-imports.test.ts` (A2 fixtures)
- `packages/framework/src/__tests__/file-checkpointer-codec.test.ts` (A12 rename)
- `packages/framework/src/__tests__/state-machine-serialize.test.ts` (A6) — **support path (not in reviewed scope)**

Spec:
- `.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md` (A14 FR-009 amendment)

Support paths for the remediation run:
- `.claude/plans/2026-08-17-pr-remediation-round-6.md` (this plan)
- `packages/framework/src/__tests__/state-machine-serialize.test.ts`

## Validation

1. `bun run typecheck` (framework workspace) — clean.
2. Full framework suite: `bun test` in `packages/framework` — all green (baseline 2775 pass / 38 skip at review head).
3. `bun packages/framework/src/scripts/check-imports.ts` (FR-041 gate) — clean, including the new destructured-bypass fixtures.
