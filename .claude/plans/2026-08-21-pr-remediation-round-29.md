# PR Remediation — Round 29 (F6 file durable runtime)

- **Branch:** `feat/f6-file-durable-runtime` (PR #37)
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-21-181423-f6-file-durable-runtime`
  (canonical `result.json`, digest `d39186ed36a15652a2c007924585a58f24e924bf3069094abf7f66daf760283e`)
- **Review cohort (7, all attempt 1, all captured):** code-reviewer (0/0), silent-failure-hunter (0/1),
  pr-test-analyzer (0/2), type-design-analyzer (0/2), comment-analyzer (0/3), architecture-tech-lead (0/1),
  code-simplifier (0/0)
- **Adjudication:** 0 criticals surfaced → 0 surviving, 0 refuted (Refutation Panel not routed — `panel: null`),
  9 advisories. **8 accepted, 1 deferred, 0 dismissed** (autonomous parent triage).

## Exact scope

Frozen review scope (417 files) from the run's `result.json`. In-scope edits below need no
`supportPaths`; the four NEW paths are registered at remediation start:

| Path | Kind |
|---|---|
| `.claude/plans/2026-08-21-pr-remediation-round-29.md` | new — this plan |
| `packages/host/src/__tests__/hitl-boot-wiring.test.ts` | new — boot-level pin (pta-2) + boot-log pin (sfh-1) |
| `packages/host/src/__tests__/fixtures/host-boot-fakes.ts` | new — shared `createHost` boot fakes (extracted verbatim from `host-uds-bind.test.ts`, which is edited to import them) |
| `packages/framework/src/file/freshness-codec.ts` | new — pure ADR-0079 decision core (atl-1) |
| `packages/framework/src/__tests__/file-freshness-codec.test.ts` | new — direct pure-surface tests + property tests (atl-1) |

In-scope files touched:

- `packages/host/src/host.ts` (sfh-1)
- `packages/host/src/__tests__/host-uds-bind.test.ts` (fixture extraction, behavior-identical)
- `packages/framework/src/__tests__/openai-client.test.ts` (pta-1)
- `packages/framework/src/types/errors.ts` (tda-1)
- `packages/framework/src/__tests__/errors.test.ts` (tda-1 runtime pin)
- `packages/framework/src/file/freshness-index.ts` (atl-1 — shell slimmed to I/O)
- `packages/framework/src/__tests__/file-freshness-index.test.ts` (atl-1 — member-serializer import moves to the codec)
- `packages/framework/src/file/checkpointer-codec.ts` (ca-2 comment)
- `packages/framework/src/dag-runtime/freshness-check.ts` (ca-3 header)
- `.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md` (ca-1)
- `.claude/specs/2026-08-12-f6-file-durable-runtime/plan-alignment.md` (ca-1)
- `.claude/specs/2026-08-12-f6-file-durable-runtime/brainstorm.md` (ca-1 — same name drift, 2 occurrences)

## Surviving critical findings

None. (`result.json.surviving_critical_findings` is empty; `refuted_critical_findings` is empty —
nothing to audit or fix at critical severity.)

## Advisory dispositions (all 9)

### ACCEPTED (8)

1. **`silent-failure-hunter-1`** — `packages/host/src/host.ts:737` (default at :456).
   Claim verified: with `TEAMS_WEBHOOK_URL` set and `HITL_APPROVAL_BASE_URL` unset, the webhook boot
   log never names the derived `http://localhost:<PORT>` approval base — the one resolved HITL config
   value with no in-process breadcrumb, and the dead-Review-deep-link misconfiguration the reviewer
   described. Fix: the else-branch (webhook) boot log names the resolved base and flags the derived
   default. Restructure `if (botConfigured && …) { … } else { … }` to
   `if (botConfigured && …) { … } else if (notifierSelection.kind === "webhook") { <new log> }` — the
   bare `else` was unreachable (a `disabled` selection never defines `notifier`, so the outer
   `notifier !== undefined` guard is false for it) and dropping it removes a dead branch while
   giving the log site a type-narrowed `notifierSelection`. **No behavior change.** Pinned by the new
   boot-wiring test (derived + explicit cases).

2. **`pr-test-analyzer-1`** — `packages/framework/src/llm/openai-types.ts:139`.
   Claim verified: `parseToolCalls`' unparseable-`arguments` raw-string passthrough (the
   `silent-failure-hunter-4` remediation) is never executed — `openai-client.test.ts` feeds only valid
   JSON `arguments` to `makeFunctionCallOutput`. Fix: one `sendWithTools` case in the in-scope
   `openai-client.test.ts`: turn 1 emits `makeFunctionCallOutput("c1", "lookup", "{not json")`, turn 2
   the final message; assert the loop CONTINUES (tool ran once with the raw string → the tool's Zod
   schema rejects it `invalid_input` → model recovers), result ok, final output parsed, token totals
   across both turns. A regression that threw or skipped the call on malformed JSON would fail this pin.

3. **`pr-test-analyzer-2`** — `packages/host/src/host.ts:622-653`.
   Claim verified: `selectHitlNotifierTransport` is fully pinned as a pure seam
   (`hitl-transport-selection.test.ts`) but `createHost`'s *consumption* of the selection
   (bot/webhook/disabled branches) has no boot-level pin — a regression that ignores the selection
   would silently disable human-review notification. Fix: new `hitl-boot-wiring.test.ts` booting the
   real `createHost` with the lightweight fake-port pattern already established in
   `host-uds-bind.test.ts` (fakes extracted verbatim into new `fixtures/host-boot-fakes.ts`):
   - webhook + fake `queueBackend` + UDS bind → `GET /runs/<valid-runId>` with the admin Bearer token
     returns 404 `run-not-found` (reached the wired HITL service + fake run store) — **not** 501;
   - no transport configured → same request returns 501 `hitl-not-configured`;
   - webhook configured but `queueBackend` omitted → boot warn
     "A HITL notifier is configured but no queue backend was wired — HITL is disabled" is logged and
     the same request returns 501;
   - bot pair + `queueBackend` → "Bot Framework in-Teams transport" boot line and non-501;
   - (sfh-1) the webhook boot line names the approval base — derived default flagged when
     `HITL_APPROVAL_BASE_URL` is unset, explicit base unflagged when set.

4. **`type-design-analyzer-1`** — `packages/framework/src/types/errors.ts:362`.
   Claim verified: `FRAMEWORK_ERROR_KINDS` is a `new Set<FrameworkError["kind"]>([…])` — membership is
   compile-checked, COVERAGE is not (a kind added to the union and omitted from the literal list
   compiles; `isFrameworkError` then fails closed on it and the boundary fences re-tag the new kind,
   silently losing its identity — the one manual-registration gate in an otherwise
   compiler-enforced taxonomy). Fix (reviewer-verified against the project TS): declare
   `const FRAMEWORK_ERROR_KINDS: Record<FrameworkErrorKind, true> = { … }` (TS2741 on a kind added to
   the union and omitted here, or present here and removed from the union) and derive the runtime set
   from `Object.keys`. The existing 27-count table pins (`errors.test.ts`) keep guarding the test
   side. Add one runtime pin in `errors.test.ts`: every table-constructed instance (27 kinds) satisfies
   `isFrameworkError` — the identity-preservation contract made test-visible.

5. **`comment-analyzer-1`** — spec.md:41,93,133 + plan-alignment.md:60,82 (+ brainstorm.md:14,29).
   Claim verified: the pre-round-25 field name `corruptNodeIds` survives in the living docs while the
   shipped port exposes `corruptNodeAddresses: readonly CorruptCheckpointAddress[]`
   (`checkpoint/checkpointer.ts:396`, ADR-0075) — and code comments anchor to the spec
   (`file/checkpointer-codec.ts` `parseNodeFile` cites "(FR-028)" next to the `corruptNodeAddresses`
   machinery). Fix: rename all 5 named occurrences to `corruptNodeAddresses`, noting at FR-028 the
   `node-key`/`digest-filename` discriminated union; add a spec change-log row
   (2026-08-21, round-29 remediation). Extend the same rename to the 2 `brainstorm.md` occurrences —
   the same round-25 doc sweep missed them; `brainstorm.md` is a design doc in the same spec directory,
   not a dated log, so the name is corrected in place (noted here as an extension of the advisory's
   named set).

6. **`comment-analyzer-2`** — `packages/framework/src/file/checkpointer-codec.ts:837`.
   Claim verified: the `parseLoadOpts` comment claims the single direct read "yields `undefined`
   exactly when the key is absent" — the biconditional is false; an own `expectedDagFingerprint` key
   holding an explicit `undefined` also reads `undefined` and is folded into the no-fingerprint path
   (`expectedDagFingerprint === undefined ? {} : …`). Behavior is deliberate; only the comment's
   precision is off, in a module whose other comments are byte-exact and pinned. Fix: reword to state
   "absent OR explicit `undefined` — both fold to the no-fingerprint path" while keeping the
   one-observation property reference.

7. **`comment-analyzer-3`** — `packages/framework/src/dag-runtime/freshness-check.ts:10`.
   Claim verified: the header describes cross-process detection as layered on top "with Redis-backed
   indexes" only — since F6 the file-backed `FreshnessIndex` (`file/freshness-index.ts`, FR-030
   durable across restarts) is a second cross-process implementation, and the sibling port file
   `types/freshness.ts` already enumerates all three adapters. Fix: one-sentence header update naming
   both adapters.

8. **`architecture-tech-lead-1`** — `packages/framework/src/file/freshness-index.ts:384`.
   Claim verified: the ADR-0079 parity decision core (score-monotonic singleton selection, Redis
   reverse-binary equal-score tie order, inclusive `sinceMs`, lazy 24h TTL, digest/content resource
   agreement) is module-private inside the shell that owns `withFileLock`/`mkdirSync`/`readFileSync`/
   `atomicWriteFile` — unlike the sibling checkpointer's extracted pure `checkpointer-codec.ts` — so
   the feature's most rule-dense logic has no test surface at its own depth, and the ad-hoc
   `__testSerializeRedisFreshnessMember` export exists only because the pure surface has no module.
   Fix: extract a PURE `file/freshness-codec.ts` (no Node built-ins, mirroring `checkpointer-codec.ts`'
   header contract) containing the exact type/function set below; `freshness-index.ts` becomes the
   thin lock/read/write shell that imports it (exactly as `checkpointer.ts` does its codec):
   - types: `PreparedFreshnessWrite`, `StoredFreshnessEntry`, `ConditionedOnSnapshot`,
     `RawWriteSnapshot`, `RawWitnessSnapshot`
   - constants: `TTL_MS` (moves with its one consumer)
   - pure functions: `isExpired` (keeps its ONE-home doc), `isFiniteNumber`, `isNonEmptyString`,
     `parseWitnessFields`, `hasExactKeys`, `snapshotWriteEvent`, `snapshotWitness`,
     `prepareFreshnessWrite`, `parseConditionedOn`, `serializeRedisFreshnessMember`,
     `serializeStoredFreshnessEntry`, `parseStoredFreshnessEntry`, `selectLatestWrite`,
     `decideConflict`
   - the `__testSerializeRedisFreshnessMember` alias disappears; `serializeRedisFreshnessMember` is a
     regular codec export (the in-scope `file-freshness-index.test.ts` import moves to the codec)
   - the codec is NOT added to the `file.ts` barrel — public surface unchanged (FR-042)
   - `check-imports.ts` covers the new file automatically (`FILE_BACKEND_SCOPE = ["file", "file.ts"]`);
     the module-graph-acyclic test bounds the new edge
   - new direct pure-surface test file `file-freshness-codec.test.ts` (new path, support-registered):
     `isExpired` live-at-exactly-24h / absent-1ms-later; `selectLatestWrite` greater-score win,
     lower-score-never-replaces, equal-score reverse-byte tie in BOTH arrival orders (fast-check
     property: arrival-order invariance), expired-singleton replacement, writtenAtMs refresh on every
     success; `decideConflict` truth table (4 cases); `parseStoredFreshnessEntry` round-trip +
     rejection classes (bad JSON, key-set mismatch, digest/content disagreement, non-finite, bad ids);
     `prepareFreshnessWrite`/`parseConditionedOn` rejection grammar; member-byte exactness via
     `serializeRedisFreshnessMember`. The existing adapter-level suite (temp dirs, locks) survives as
     the I/O-boundary integration layer — transport/locking/atomicity, not decision rules.

### DEFERRED (1)

9. **`type-design-analyzer-2`** — `packages/framework/src/checkpoint/checkpointer.ts:535`.
   Claim verified but the complete fix is out of scope for THIS PR: it requires removing the
   `testStore` seam from the production `InMemoryCheckpointer` constructor and unexporting
   `InMemoryStoredMeta` from the public `checkpoint/index.ts` barrel — a public-surface change to the
   pre-existing in-memory backend, which **FR-042** ("existing surface unchanged", framework frozen at
   0.4.0) and **FR-023** (in-memory/Redis backends byte-identical in this pass) prohibit here, and
   which would churn the shared `checkpointerSuite` infrastructure
   (`__tests__/redis-checkpointer.test.ts`) that F6 deliberately left untouched. The seam is already
   documented at its declaration ("TEST-SURFACE type (seam redesign)") and in the port docs as a
   sanctioned test pattern — the reviewer's lighter alternative (port-level documentation) is largely
   in place. **Deferred to a post-PR encapsulation pass** with room to move the frozen surface; the
   divergence (constructor-adopted store vs non-barrel test factory) is real and should be resolved
   then by unifying on the stronger discipline.

### DISMISSED (0)

None — no advisory's claim failed verification.

## Refuted-finding audit

Empty — no critical surfaced, the Refutation Panel was not routed (`panel: null`), and
`result.json.refuted_critical_findings` contains no entries.

## Validation (must pass before remediation staging)

1. `bun run typecheck` — all packages (framework first; SC-004)
2. `bun test packages/framework` — full framework suite: file-backend suite, shared checkpointerSuite,
   `boundary-imports.test.ts` (SC-006/FR-043, covers the new codec file), `module-graph-acyclic.test.ts`,
   `errors.test.ts` incl. the new kind-recognition pin, `openai-client.test.ts` incl. the new
   malformed-arguments case (SC-005)
3. `bun test packages/host` — full host suite incl. the refactored `host-uds-bind.test.ts` (fakes now
   from the shared fixture module — behavior must be identical) and the new `hitl-boot-wiring.test.ts`
4. No new dependencies (`git diff --stat` shows none; `bun.lock` untouched)
