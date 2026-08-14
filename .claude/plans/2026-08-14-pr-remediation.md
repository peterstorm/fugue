# Plan: PR remediation (round 2) — F6 file-backed durable runtime

**Branch:** `feat/f6-file-durable-runtime`
**Head:** `e060891` (clean tree at plan time)
**Review Run:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-14-212630-f6-file-durable-runtime`
**Result:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-14-212630-f6-file-durable-runtime/result.json` (digest `1bc29259ea25149a17951ff983175b763b9b5937e3a15e3ba323793cf55b43f5`, tally-published, panel threshold 2, lenses reproduction/intent/test-coverage)
**Scope (frozen, 59 paths):** plan, spec, ADRs 0075–0080, all `packages/framework/src/file/*`, checkpoint codecs, state-machine serialize/replay, types, boundary-imports, tests.

## Surviving critical findings (mandatory)

### C1 — `comment-analyzer-1` — AD-3 step citations mutually contradictory
**Claim:** the `"AD-3 step N"` citations for the resume-proof steps are mutually contradictory across `resume-proof.ts:378` (step 3), `file-resume-proof.test.ts:201` (step 3), `resume.ts:119-120`/`file-resume.test.ts:636`/`file-resume-proof.test.ts:19` (step 5), and `resume.ts:23`/`resume-proof.ts:349`/`file-resume-proof.test.ts:145` (step 2); none resolves to ADR-0077's own shipped-implementation enumeration (agreement = step 6, strict-prefix/genesis lag = step 7). **Upheld by all three lenses.**

**Fix — one referent, ADR-0077's Decision enumeration (steps 1–8):**
re-point every `AD-3 step N` citation:
- `resume.ts:23` + `resume.ts:170` (event-log read fails closed) → **step 1**
- `resume.ts:119-120` + `resume-proof.ts:171-172` (genesis = empty-prefix benign lag) → **step 7**
- `resume-proof.ts:349` (full-agreement state-key compare) → **step 6**
- `resume-proof.ts:378` + `file-resume-proof.test.ts:198,201` (strict-prefix scan) → **step 7**
- `file-resume-proof.test.ts:19` + `file-resume.test.ts:636` (strict-prefix/genesis lag) → **step 7**
- `file-resume-proof.test.ts:142,145` (full agreement) → **step 6**

Add a load-bearing scheme note to the `resume-proof.ts` module header: "`AD-3 step N` citations in this module and its tests follow ADR-0077's shipped-implementation enumeration (1 read events → 8 checkpoint-corrupt)". No test asserts these strings; the resume suites must stay green.

## Advisory findings (autonomous disposition)

| # | ID | Claim (summary) | Disposition | Reason |
|---|---|---|---|---|
| A1 | silent-failure-hunter-1 | `journal.ts:356` stamps `recordedAtMs` via bare `now()`; throwing/non-finite clock misattributed to lock machinery | **accepted** | Sound diagnostic gap; fix mirrors checkpointer/freshness patterns: guard the clock call with finite check + named "clock failed while stamping the append" wrap; harden hostile-clock test to assert clock attribution |
| A2 | silent-failure-hunter-2 | `freshness-index.ts:514-517` `findConflict` drops corrupt singleton to `ok(null)`, masking conflict as clean | **accepted** (docs only) | Port parity with Redis is deliberate (ADR-0079); gap is caller observability → document corrupt-observed-as-absent on the public `createFileFreshnessIndex` surface + ADR-0079 operational note |
| A3 | pr-test-analyzer-1 | `resume.ts:192-197` non-`FrameworkError` re-tag branch untested | **deferred** | Unreachable with the shipped typed journal; a direct test requires a new injection seam (design change); FR-040 guard totality already proven via hostile-callback tests |
| A4 | pr-test-analyzer-2 | `journal.ts:277` per-entry `statSync` race untested | **deferred** | Environment race; direct test needs concurrent deletion process and is inherently flaky; typed mapping covered via tested readdir-EACCES sibling |
| A5 | pr-test-analyzer-3 | `job.ts:154` `data` getter `structuredClone` branch untested | **dismissed** | Unreachable by structural invariant — snapshot is detached canonical JSON-safe data minted by the factory; no public seam can produce non-cloneable data without subverting the factory |
| A6 | pr-test-analyzer-4 | `checkpointer.ts:570-576` non-ENOENT `nodes/` listing failure untested | **accepted** | Directly testable via chmod-000 on the nodes directory (same pattern as the tested journal EACCES case); skip when running as root |
| A7 | type-design-analyzer-1 | `InMemoryCheckpointer.load` returns live internal `nodes` Map + `meta` | **accepted** | Real encapsulation gap (mutation bypasses `saveNode`); fix = defensive copy of nodes record + meta at load; verify shared `checkpointerSuite` + framework suite stay green |
| A8 | type-design-analyzer-2 | `Checkpointer.saveNode` `nodeId` unbranded while `runId` branded | **deferred** | Shared port signature across in-memory/Redis/file + DAG consumers; branding ripples through every boundary; file backend already re-validates at the fs boundary; park with port-hardening work |
| A9 | type-design-analyzer-3 | `recordWrite` fails forever on corrupt singleton; could heal | **deferred** | Deliberate fail-closed parity (ADR-0079); healing silently replaces torn writes; requires ADR amendment + new semantics, out of scope |
| A10 | type-design-analyzer-4 | `releaseFileLock` silent no-op on token mismatch | **dismissed** | Documented deliberate behavior (`atomic.ts:501-503`); on mismatch the lock belongs to the fencing winner — removing it would delete the current owner's lock; no-op is the only safe behavior, no lock is "leaked" |
| A11 | type-design-analyzer-5 | `RunState.corruptNodeIds` optional → required | **deferred** | Shared port contract across backends + consumers; low correctness impact (documented); park with port-hardening |
| A12 | type-design-analyzer-6 | FR-009 losslessness verdict duplicated (`deepJsonEqual` vs `deepEqual`) | **accepted** | Extract one shared canonical deep-equality if implementations are identical (verify first); alias both call sites; suite already covers both |
| A13 | comment-analyzer-2 | `layout.ts:14-15` example key `dag@<128>@<16>@<16>` claimed 291 bytes (actual 166) | **accepted** | Comment fix: make example/arithmetic self-consistent (291 requires 128-char namespace), sync `checkpointer.ts:14` |
| A14 | comment-analyzer-3 | `layout.ts:166-180` eventFileName JSDoc orphaned | **accepted** | Move block directly above `eventFileNameUnchecked`; attach doc |
| A15 | comment-analyzer-4 | `errors.ts:496` `messageOf` JSDoc: "other fields are just `nodeId`" — wrong (`node-crash` carries retriability/httpStatus/usage/stack) | **accepted** | Reword rationale |
| A16 | comment-analyzer-5 | `event-record.ts` FR-009 rejection inventory duplicated ~5× | **accepted** | Consolidate: canonical list once (module header), cross-reference at other sites; keep any site-unique content |
| A17 | architecture-tech-lead-1 | Deterministic permanent failures (capacity, FR-015, progress, losslessness) collapsed into `cache-error` → misclassified retriable | **accepted** | Additive `failureClass?: "transient" | "permanent"` on the `cache-error` variant; populate at deterministic construction sites (journal capacity, writeProgress percent, writeCheckpoint commit-type, eventFileName/keyDigest validation, codec wraps); `retriabilityOf` prefers explicit field; tests assert classification + `retriabilityOf` |

**Refuted critical findings:** none (panel refuted 0, upheld 1 via reproduction/intent/test-coverage).

## Validation commands

```bash
cd /home/peterstorm/dev/agentic/fugue/packages/framework
bun run typecheck                      # tsc --noEmit + tsconfig.bin.json
bun test                               # full framework suite (Redis-gated skips expected)
cd /home/peterstorm/dev/agentic/fugue && git status   # only planned paths dirty
```

Remediation then proceeds through the registered remediation run (source review run remains immutable authority).
