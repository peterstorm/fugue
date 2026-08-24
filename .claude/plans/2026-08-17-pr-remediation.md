# PR Remediation Plan — 2026-08-17

**Branch:** `feat/f6-file-durable-runtime`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-072002-f6-file-durable-runtime`
**Authority:** `result.json` (tally-published, digest `beb5127ce6435a925393471d2ac4708e4d87e23befd720726dced5a6a06b8567`)
**Head at review:** `7c8631e` (base `6c316cb5`)

## Review outcome

- Reviewers: 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier)
- Raw criticals: 4 · **Surviving criticals: 4** · **Refuted criticals: 0** · Advisories: 21
- Refutation Panel: 3 lenses (reproduction / intent / test-coverage), `review-verifier-agent` × 3, threshold-pinned by tally.

## Refuted-finding audit

None. Every surviving critical was upheld by the panel (3/3 on the first three; 2 upheld + 1 uncertain on `code-simplifier-1` — the uncertain vote was the test-coverage lens, which correctly reported it had no adjudicating test evidence, not a counter-example).

## Surviving criticals (all mandatory)

### C1 — `silent-failure-hunter-1` — `file/job.ts:218-221`
**Claim (panel-upheld 3/3):** `createFileJob().appendEvent`'s `|`-hint branch converts the journal's `failureClass: "permanent"` FR-015 rejection into a plain-string reason; `fileOperationError` infers a class only from a wrapped `FrameworkError`, so the thrown `cache-error` loses its class and `retriabilityOf` classifies the deterministic rejection as retriable — burning the node's retry budget instead of fast-failing (ADR-0080).
**Fix:** pass `"permanent"` explicitly as the fourth `fileOperationError` argument on the `|` branch. Safe: `parseOptionalDedupKey` runs in `journal.appendEvent` BEFORE mkdir/lock/I/O (journal.ts:319-334), so on this branch the rejection is always the permanent FR-015 one.

### C2 — `type-design-analyzer-1` — `file/job.ts:217`
**Claim (panel-upheld 3/3):** same mechanism as C1, independently reported (type-level framing: the `failureClass` discriminant is severed on the one 100%-permanent-traffic path).
**Fix:** resolved by the identical change (one code site serves both findings).

### C3 — `comment-analyzer-1` — `__tests__/file-atomic.test.ts:695` (+ header `:18`)
**Claim (panel-upheld 3/3):** the test asserts "the documented ~5s ceiling" / "The ceiling is documented on `acquireFileLock`", but `atomic.ts` documents it nowhere — the bound exists only as bare constants (`MAX_ACQUIRE_ATTEMPTS = 50`, `RETRY_MS = 100`) and the runtime error string.
**Fix:** document the bounded-acquisition contract on `acquireFileLock`'s JSDoc: at most `MAX_ACQUIRE_ATTEMPTS` (50) attempts × `RETRY_MS` (100 ms) ≈ 5 s; on exhaustion throws typed `cache-error(acquireFileLock)` naming the lock path plus any blocking fence entries and last owner-probe diagnostic. The test comment's cross-reference then resolves.

### C4 — `code-simplifier-1` — `file/checkpointer.ts:602-604` (+ `:366`, `:426`, `:432`)
**Claim (panel: 2 upheld + 1 uncertain-no-evidence):** the `load` loop's `nodes directory disappeared after listing` throw is unreachable (non-empty `fileNames` ⇒ non-null `nodesDirectory`; the local is never reassigned; no `await` in the loop body), and the message names a race the check structurally cannot detect; the `create: true` null checks at `:366/:426/:432` are likewise impossible — `verifyDirectory(..., create: true)` only throws or returns a frozen non-null anchor (its sole `return null` is gated on `!create`).
**Fix (single-encoding):** overload `verifyDirectory` in `verified-directory.ts` — `create: true` ⇒ `VerifiedDirectory`, `create: false` ⇒ `VerifiedDirectory | null`; overload `runDirectoryOf` to match. Delete the three impossible null checks (they become type errors) and in `load` replace the in-loop throw with an `if (nodesDirectory !== null) { … }` wrap (behavior-identical: the loop is already a no-op when null). Real disappearance races stay covered by `verifyExistingFile`/`assertDirectoryIdentity` in the surrounding catch.

## Advisory dispositions (21 total: 18 accepted · 2 deferred · 0 dismissed)

### Accepted

| # | Finding | Fix |
|---|---------|-----|
| A1 | `silent-failure-hunter-2` — `__tests__/file-job.test.ts:575-600` default-keyer FR-015 test never asserts `failureClass`/`retriabilityOf` (the one unguarded surface for C1/C2) | add `expect(typed.failureClass).toBe("permanent")` + `expect(retriabilityOf(typed)).toBe("non-retriable")` to the existing test (mirrors `:397-410` pin) |
| A2 | `pr-test-analyzer-1` — `llm/fake-client.ts` `sendWithTools` loop-exit branches unpinned (script exhaustion, iteration limit — the file's only `non-retriable` node-crash, `toolChoice: "none"`, signal abort) | add a loop-exit table to `llm-fake-client.test.ts` pinning each branch's `kind`/`retriability`/message |
| A3 | `pr-test-analyzer-2` — `checkpoint/checkpointer.ts:306` `InMemoryCheckpointer.saveNode` has no `__proto__`-nodeId own-entry pin (file backend defends + pins at `file-checkpointer.test.ts:911`) | add an in-memory pin mirroring the file-backend test: save with nodeId `__proto__` round-trips as an OWN entry and the map is not re-parented |
| A4 | `type-design-analyzer-2` — `freshness-index.ts:522,526` `findConflict` omits the `permanent` class its `recordWrite` twin pins for the same deterministic rejections (`parseConditionedOn` failure, non-finite `sinceMs`) | add `"permanent"` to both `cacheFailure("freshness:findConflict", …)` calls |
| A5 | `type-design-analyzer-3` — `event-log.ts:105` `readStrict` leaves a non-regular file under a record name (ENOTDIR) unclassified, while `journal.ts` `listEventFiles` pins the same deterministic condition `permanent` | classify the `readFileSync` catch: `probeErrorCode` ENOTDIR ⇒ `permanent: true` (deterministic squat — parity with the append-time gate); other errno stays environment-class |
| A6 | `comment-analyzer-2` — `event-record.ts:262-267` orphaned `deepJsonEqual` JSDoc stranded above `RESERVED_TAG_KEYS`' own doc | delete the orphaned block |
| A7 | `comment-analyzer-3` — `journal.ts:93-97` orphaned first JSDoc stacked on the real `fsFailure` doc | delete the orphaned first block |
| A8 | `comment-analyzer-4` — `checkpoint-record.ts:42-46` floating `deepJsonEqual` semantics comment reads as `serializeFileCheckpointUnchecked`'s doc | replace with an actual doc for `serializeFileCheckpointUnchecked` (mint bytes + detached snapshot from exact committed bytes; pre-scan → serialize → round-trip verify → deep-equal verdict) |
| A9 | `comment-analyzer-5` — `job.ts:4` header documents `createFileJob(directory, initial)`; the API takes one options object `{ directory, initial, now? }` | rewrite the header call form to match `CreateFileJobArgs` |
| A10 | `comment-analyzer-6` — `file/checkpointer.ts:143` "fail both framework typechecks" — garbled, no referent | rewrite: the `Extract<FileOperation, …>` narrowing makes a file-backend operation typo a compile error while leaving the public `cache-error.operation: string` contract untouched |
| A11 | `comment-analyzer-7` — `checkpoint/checkpointer.ts:134` parity claim overstated: bare `ID_PATTERN.test(nodeIdRaw)` at `:153` coerces non-strings (`ID_PATTERN.test(42)` matches), so a bypassed numeric brand can inhabit the branded `nodeId` field, unlike the file backend's `typeof`-guarded `writeFailed` | add `typeof nodeIdRaw === "string" &&` guard (restores the claimed parity; matches `isIdComponent`/`isBoundaryId` documented discipline) |
| A12 | `comment-analyzer-8` — `verified-directory.ts:29` claims helpers throw "raw `Error`/`TypeError`" — module throws `Error` (and rethrows raw fs errors), never `TypeError` (verified: 7× `new Error`, zero `TypeError`) | drop "or `TypeError`" from the header |
| A13 | `comment-analyzer-9` — `llm-fake-client.test.ts:233` "Pins the documented lookup order" — no documentation of the Map resolution order exists anywhere | add a one-line doc on `FakeResponseProvider` stating the order (model key first, system-prompt key fallback) so the test's claim resolves |
| A14 | `code-simplifier-2` — `journal.ts:376` generic fallback after the capacity check is unreachable (`parseJournalSequence(existing.length)` can only fail on `> MAX`; array lengths are always non-negative safe integers; the comment at `:372` concedes it) | throw `journalCapacityError` directly on parse failure; drop fallback + hedging comment |
| A15 | `code-simplifier-3` — `resume.ts:106` `errorMessageOf` is a pure passthrough to `messageOf` with one call site | inline `messageOf(events.error)` at `:176`; keep the rationale comment at the call site |
| A16 | `code-simplifier-4` — serialize.ts's closed sets re-encoded by hand: pollution keys ×5 (`serialize.ts:21`, inline `:282`/`:396`, `event-record.ts:295`, `checkpointer-codec.ts:380`), reserved tags ×3 (`serialize.ts:18`, `event-record.ts:284`, `checkpointer-codec.ts:373`) — a serializer change would silently desync the FR-009 pre-scans | export `RESERVED_TAGS` + `POLLUTION_KEYS` from `serialize.ts`; import in `event-record.ts`/`checkpointer-codec.ts` (keep their semantic doc comments, use the shared sets); use the sets for the two inline literal checks in `serializeValue`/`deserializeValue` |
| A17 | `code-simplifier-5` — `serializedPath` (`serialize.ts:30`) and `outputPath` (`checkpointer-codec.ts:386`) are byte-identical | export `serializedPath` from `serialize.ts`; delete the codec's copy and import it |
| A18 | `code-simplifier-6` — the `{ now? }` factory-options grammar is hand-rolled line-for-line in `createFileJournal` (`journal.ts:213-246`) and `createFileFreshnessIndexUnchecked` (`freshness-index.ts:428-446`) | extract ONE shared `{now?}` parser (plain-object + prototype check, `ownKeys` find `key !== "now"`, `now` must be a function, `Date.now` default, identical messages) for these two same-discipline factories; each shell keeps its own wrapping so final messages stay byte-identical (test-pinned). `checkpointer.ts`'s deliberately stricter descriptor-isolated `parseFileCheckpointerClock` stays separate |
| A19 | `code-simplifier-7` — `checkpoint/checkpointer.ts:153` missing `typeof` guard (in-memory `checkpointWriteFailed` brands via bare `ID_PATTERN.test`) | resolved by the identical A11 change (one code site serves both findings) |

### Deferred

| # | Finding | Reason |
|---|---------|--------|
| D1 | `type-design-analyzer-4` — `replay.ts:40` `RecordedEvent` envelope distinguished from a raw machine event only by structural shape | Sound claim, but the complete fix is a PUBLIC TYPE-SURFACE change: branding the envelope (unique symbol + mint at both reader sites + `isRecordedEvent` runtime check) changes fold behavior for any raw event type that structurally matches `{recordedAtMs, event, synthetic?}` and breaks manual envelope construction that is legal today for typed callers. Requires a compatibility decision + ADR (the `FileCheckpointCommit` pattern) — schedule for the next state-machine design pass rather than a drive-by. In-scope consumers always pass real envelopes (documented narrowing contract). |
| D2 | `architecture-tech-lead-1` — `{ now? }` options grammar encoded THREE times with divergent trap handling (checkpointer's descriptor-isolated `Reflect.apply` variant vs the two direct-read copies) | The two-factory drift it names is removed by accepted A18 (journal + freshness share one encoding). The remaining question — making the descriptor-isolated checkpointer variant the single strictest encoding for all three — changes hostile-input behavior of two factories and their pinned hostile-options suites; that is a design decision for the next `file/` design pass, not a behavior-identical consolidation. |

### Dismissed

None.

## Remediation file set (all in review scope)

Production:
- `packages/framework/src/file/job.ts` (C1/C2 + A9)
- `packages/framework/src/file/atomic.ts` (C3)
- `packages/framework/src/file/verified-directory.ts` (C4 + A12)
- `packages/framework/src/file/checkpointer.ts` (C4 + A10)
- `packages/framework/src/file/journal.ts` (A7 + A14 + A18)
- `packages/framework/src/file/freshness-index.ts` (A4 + A18)
- `packages/framework/src/file/event-log.ts` (A5)
- `packages/framework/src/file/event-record.ts` (A6 + A16)
- `packages/framework/src/file/checkpoint-record.ts` (A8)
- `packages/framework/src/file/checkpointer-codec.ts` (A16 + A17)
- `packages/framework/src/file/resume.ts` (A15)
- `packages/framework/src/checkpoint/checkpointer.ts` (A11/A19)
- `packages/framework/src/llm/fake-client.ts` (A13)
- `packages/framework/src/state-machine/serialize.ts` (A16 + A17)

Tests:
- `packages/framework/src/__tests__/file-job.test.ts` (A1)
- `packages/framework/src/__tests__/llm-fake-client.test.ts` (A2)
- `packages/framework/src/__tests__/redis-checkpointer.test.ts` (A3)

Support path (outside reviewed scope — registered in remediation start input):
- `.claude/plans/2026-08-17-pr-remediation.md`

## Validation

```bash
cd /home/peterstorm/dev/agentic/fugue
bun run typecheck          # both tsconfigs, exit 0
bun run --filter framework test   # full framework suite (2808+ tests) exit 0
bun packages/framework/src/scripts/check-imports.ts   # FR-041 boundary gate
bun scripts/check-doc-links.ts
```

Stop without staging/committing if validation cannot pass.
