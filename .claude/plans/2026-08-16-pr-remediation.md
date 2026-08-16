# PR Remediation Plan — 2026-08-16 (f6 file durable runtime, round 3)

- **Branch:** `feat/f6-file-durable-runtime`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-16-032449-f6-file-durable-runtime`
- **Authoritative result:** `result.json` (digest `9668d42529a23715ee4226663b296ffb6e53d7c7da652227497bbacb0f15ff33`, published by the registered standalone review program after Refutation Panel adjudication)
- **Reviewed scope:** the 61 frozen files (changed-path union vs `origin/main` merge-base `6c316cb`; working tree clean at review start, HEAD `b77efcf`)

## Adjudication summary

- Surviving critical findings: **0**
- Refuted critical findings: **1** (reported below, never fixed)
- Advisory findings: **25 aggregated entries → 19 distinct claims** (the aggregate contains both the structured findings and the machine-summary lines for pr-test-analyzer/type-design-analyzer; duplicates A04–A08 ≡ A09–A13 and A14 ≡ A19 are dispositioned with their canonical entry)
  - **Accepted: 16** · **Deferred: 1** · **Dismissed: 2**

## Surviving critical findings

None. Every mandatory fix set is empty; all remediation below is advisory-driven.

## Refuted-finding audit (retained, never fixed)

**`comment-analyzer-1` — "ADR-0017 citation does not resolve to the version-mismatch contract"** (raised as critical: 8 code/test sites + spec.md:42,90,133,176 + plan cite `ADR-0017` as the framework-version-mismatch contract, but `docs/adr/README.md:37` indexes 0017 as "Derive deps from edges").

Panel: lenses `[reproduction, intent, test-coverage]`, threshold 2 → **REFUTED 2–1** (`refuted_by: [reproduction, test-coverage]`):

- **reproduction (refuted):** reproduced every cited occurrence; `docs/adr/0017-derive-deps-from-edges.md`'s own Decision section states "FRAMEWORK_VERSION bumps to 2 so old checkpoints … are rejected on resume" (Consequences: "Existing checkpoints become un-resumable") — the exact contract the comments describe. The citation resolves via the ADR body, not just the index headline. Project history corroborates: `docs/plans/2026-05-11-pr-review-remediation.md:65` ("ADR-0017 bumped FRAMEWORK_VERSION to 2 so v1 checkpoints would be rejected") and `docs/plans/2026-05-12-framework-review-remediation-pass-4.md:534` ("the four ADR-0017 cases").
- **test-coverage (refuted):** verified the test-side citations against the frozen tree (`_checkpointer-suite.ts:28,227`; `file-checkpointer-codec.test.ts:25,333` cite ADR-0017 for the version-mismatch cases; no test cites ADR-0015 for that contract — ADR-0015 appears only in conditional-edges tests, where it is the correct topic).
- **intent (upheld):** the index title is the topology record and the pass-4 plan called the attribution "imprecise" — noted as the dissenting lens; below the refutation threshold, so the finding does not survive.

No change is made to the ADR-0017 citations as a result of this finding.

## Advisory dispositions (all 19 distinct claims)

### Accepted — 16

| # | Advisory (result.json) | Fix |
|---|---|---|
| A01 | `file/journal.ts` `listEventFiles` naming-contract rejections (foreign `*.json` entry, non-regular-file squat, sites :270–277 / :285–292) throw unclassified `cache-error(appendEvent)` → `retriabilityOf` mislabels a deterministic failure `retriable` | Extend `fsFailure` with an optional `failureClass` param; pass `"permanent"` at the two deterministic rejection sites (the `readdirSync`/`statSync` I/O catches stay unclassified = transient). Pin `failureClass === "permanent"` + `retriabilityOf(...) === "non-retriable"` in `file-journal.test.ts`'s classification block. |
| A02 | `serializeFileCheckpoint` (`file/checkpoint-record.ts:105`) wraps every deterministic non-lossless rejection without `"permanent"` (and the inner `assertLosslessEvent` permanent class is stripped by the plain-Error re-wrap at :57–61) → `updateData` surfaces `retriable` | Tag the `serializeFileCheckpoint` shell `fileOperationError(..., "permanent")` (every inner rejection reproduces identically for the same payload — all deterministic). Pin in `file-job.test.ts`: non-cloneable/non-lossless `updateData` ⇒ `failureClass === "permanent"` + `retriabilityOf` non-retriable. |
| A03 | `FakeLlmClient.sendWithTools` final turn: unguarded `JSON.stringify(turnSpec.content)` (fake-client.ts:259) throws a raw `TypeError` on cyclic/BigInt content accepted by `unknown`-typed schemas — an untyped rejection across the `LlmClient` port, violating the module's FR-040 contract | Guard the final-turn serialization (and the `safeParse` call, the same branch's second unguarded seam) exactly as the `sendStructured`-path guard at :119–131 does: typed `node-crash` (`retriability: "retriable"`), never a raw rejection. Pinned by the A05 test file. |
| A04 | `fencedReap`'s post-rename liveness re-probe (atomic.ts:347–360, "never delete a tomb that now proves live") has no deterministic test — the single untested safety branch in the lock suite | Add a deterministic test in `file-atomic.test.ts` using the existing `FileLockTestHooks`: stateful `readOwnerPid`/`probeOwnerProcess` (ESRCH on the first probe, alive after `afterVictimRename`) → assert the tomb is restored to `lockPath` and acquisition stays fenced (returns `false`). |
| A05 | The round-2 FR-040 total guards in `llm/fake-client.ts` (provider/script/tracer/dispatch/`JSON.stringify` throws → typed `node-crash`; `ensureToolNames` throw → `validation`) are not pinned by any test | NEW test file `packages/framework/src/__tests__/llm-fake-client.test.ts` (support path): I/O-free cases — throwing provider, throwing script, hostile tracer, throwing tool dispatch, non-JSON-serializable response (sendStructured path) AND final turn (A03), cyclic/BigInt final content (A03), `ensureToolNames` throw → `validation`. |
| A14 | `event-record.ts` `render` (:183–200) runs `JSON.stringify` on hostile non-primitive values in error paths, executing `toJSON`/getter traps — inconsistent with the hostile-boundary discipline `dedupKeyError` enforces in the same module | Route the non-primitive branch through the already-imported total `safeDiagnosticRender` instead of attempting `JSON.stringify` (drop the throw-sensitive stringify attempt; keep truncation). Pin with a hostile-`toJSON`/throwing-getter test on the `parseJournalSequence`/`parseFileEventRecord` rejection paths (no trap execution, typed error still surfaces). |
| A15 | `ScanVerdict` export doc (event-record.ts:394–398) is stale: describes a deleted "pollution" scan and a `resume.ts` consumer that no longer references it | Stop exporting `ScanVerdict` (module-private now — only `findReservedTagKey` uses it; verified no other reference repo-wide) and rewrite the doc to describe the reserved-tag scan only. |
| A16 | `readFileEventRecords`/`readFileEvents` (event-log.ts:149/164) collapse record corruption and fs read failure into one unclassified `cache-error` | Classify at the CONSTRUCTION SITE inside `readStrict` (its Err channel mixes both classes, so a single tag on `failure()` would misclassify): the strict-failure type is now `StrictReadFailure = { message, permanent?: true }` — corruption sites (grammar, record parse, filename prefix, contiguity, digest) set `permanent: true`; the two fs I/O sites (readdir, readFileSync) leave it absent. `failure()` maps `permanent → fileCacheError(..., "permanent")`. Pinned: corrupt record ⇒ permanent/non-retriable; EISDIR (directory squat) ⇒ unclassified/retriable. |
| A17 | `deepJsonEqual` (state-machine/serialize.ts:306) is an exported unbounded recursive walk; stack safety depends on every caller pre-bounding at the 512 gate | Rewrote it ITERATIVE (explicit pair queue) — total over arbitrary input at ANY depth with zero cap to drift, matching the iterative posture of the read-side pre-scans; semantics identical (structural equality, NaN-equals-NaN, `-0`-equals-`0`). Pinned with ~20k-deep hostile pairs (no throw; correct verdicts) plus the canonical-form semantics. Verified: only two in-scope callers, both pre-bounded — no behavior change for them. |
| A08 | `atomicWriteFile`'s empty/NUL path guard (atomic.ts:71) is untested | Add the direct internal-surface test in `file-atomic.test.ts`: `atomicWriteFile("\u0000…", …)` and `""` throw (the guard's exact contract), defense-in-depth pin. |
| A20 | `types/errors.ts:94` lists "non-lossless event/checkpoint values" as a `permanent` example, but the checkpoint path was unclassified | Made true by A02's fix (the doc example then matches both sides). No independent edit; verified at validation time. |
| A21 | `checkpointer-codec.ts:73–74` `stringOf` doc claims it stops a hostile 10 KB `runId` from "flood[ing] the log line", but it returns string inputs unmodified | Reword the doc: `stringOf` preserves the rejected bytes for the additive `invalidRunId`/`invalidNodeId` diagnostic fields; log-line bounding is `safeDiagnosticRender`'s job — never log the field raw. |
| A22 | `job.ts:97` and `:167` reference `serializeCheckpoint`, a symbol that does not exist | Replace both with `serializeFileCheckpoint`. |
| A23 | `__tests__/boundary-imports.test.ts:2` and `:101` cite "(FR-082)", a requirement ID that does not exist (spec FRs run FR-001…FR-044) | Correct both to FR-043 (the file-backend boundary-import rule the header already describes). |
| A24 | `resume.ts:70–73` claims the reader's message is preserved "verbatim" in the re-tagged `checkpoint-corrupt`, but `messageOf()` serializes the whole `cache-error` value | Fix the header: the reader's message is preserved as the `message` field inside the JSON-serialized `cache-error` value (kind/operation/message), not as the bare message. Doc-only — the error payload is unchanged. |
| A25 | `event-record.ts:26–28` claims the FR-009 inventory is "documented once" with every doc site pointing there, yet the module header, `FileEventRecord.event` doc, and `serializeFileEventRecord` doc each re-enumerate it (the field-doc copy omits the depth-ceiling item — visible drift) | Honor the policy: replace the three re-enumerations with pointers to the canonical `assertLosslessEvent` pre-scan contract (the header's inline inventory becomes a pointer; the `event` field doc drops its parenthetical copy; keep the single canonical enumeration on `assertLosslessEvent`). |

### Deferred — 1

- **A06** (`file/resume.ts:196` — the non-`FrameworkError` re-tag branch after `readCheckpoint()` is untested): carried over from the round-2 remediation deferral with the same evidence. The shipped typed journal's `readCheckpoint` only throws typed `cache-error`s, so the branch is unreachable through the public surface; a direct test requires a new journal injection seam (a port-surface change) whose cost exceeds the value of pinning a defensive re-tag that is already FR-040-motivated. Revisit if a journal seam is introduced.

### Dismissed — 2

- **A07** (`state-machine/replay.ts` — `replayEventsUntil`/`replayEventSlice` "have no tests in the frozen scope"): the claim's substance is disproven by repo evidence — `__tests__/state-machine-replay.test.ts` (out of the frozen scope, pre-existing) contains full `describe` blocks for both helpers (time-bound replay, half-open windows, RangeError pins, equivalence with `replayEvents`), and `queue-bullmq-adapter.test.ts:1484–1505` exercises them end-to-end. "Not in the frozen scope" is true but not a coverage gap.
- **A18** (`checkpoint/checkpointer.ts:345` — `__testRawMetas()` returns the live internal `Map`): intentional, documented test-only seam on the in-memory test double, mirroring the Redis counterpart's `redis.set` escape hatch. The shared `checkpointerSuite` tests depend on the live map's mutability (e.g. `redis-checkpointer.test.ts:137` mutates it to construct the expired-meta case); a defensive copy would silently break that test semantics. The production invariant ("MUST go through `setMeta`") is documented at the seam, and a boundary rule gating a test-only seam used exclusively from `__tests__/` is disproportionate.

## Changed files (planned)

In-scope production:
- `packages/framework/src/file/journal.ts` (A01)
- `packages/framework/src/file/checkpoint-record.ts` (A02)
- `packages/framework/src/llm/fake-client.ts` (A03)
- `packages/framework/src/file/event-record.ts` (A14, A15, A25)
- `packages/framework/src/file/event-log.ts` (A16)
- `packages/framework/src/state-machine/serialize.ts` (A17)
- `packages/framework/src/file/atomic.ts` (A08 test-only change is in the test file; production untouched)
- `packages/framework/src/file/checkpointer-codec.ts` (A21 doc)
- `packages/framework/src/file/job.ts` (A22 doc)
- `packages/framework/src/file/resume.ts` (A24 doc)
- `packages/framework/src/types/errors.ts` (A20 — no edit expected; verified)

In-scope tests:
- `packages/framework/src/__tests__/file-journal.test.ts` (A01, A16)
- `packages/framework/src/__tests__/file-job.test.ts` (A02)
- `packages/framework/src/__tests__/file-atomic.test.ts` (A04, A08)
- `packages/framework/src/__tests__/file-event-record.test.ts` (A14, A17, A25 doc-contract pin)
- `packages/framework/src/__tests__/boundary-imports.test.ts` (A23)

Support paths (NOT in reviewed scope — registered in the remediation start input):
- `.claude/plans/2026-08-16-pr-remediation.md` (this plan)
- `packages/framework/src/__tests__/llm-fake-client.test.ts` (A05, new file)

## Validation commands

```bash
cd /home/peterstorm/dev/agentic/fugue/packages/framework
bun run typecheck                 # SC-004 — must be green
bun test src/__tests__/file-journal.test.ts src/__tests__/file-job.test.ts src/__tests__/file-atomic.test.ts src/__tests__/file-event-record.test.ts src/__tests__/boundary-imports.test.ts src/__tests__/llm-fake-client.test.ts
bun test                          # full framework suite — must be green (SC-005)
cd .. && bun run lint:boundary    # SC-006 boundary gate (if script present; otherwise covered by boundary-imports.test.ts)
```

Stop without staging or committing if any command fails.
