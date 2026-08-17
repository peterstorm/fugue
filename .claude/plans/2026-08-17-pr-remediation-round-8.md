# PR Remediation — Round 8 (standalone review `standalone-2026-08-17-140611-f6-file-durable-runtime`)

- **Branch:** `feat/f6-file-durable-runtime`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-140611-f6-file-durable-runtime`
- **Authoritative result:** `result.json` in that Run Directory (digest `dbbbb577…`, tally-published; the review run is immutable authority)
- **Adjudication:** 1 canonical critical → Refutation Panel (lenses: reproduction, intent, security; threshold 2) → **3/3 upheld → 1 surviving, 0 refuted**. 22 advisories, autonomously dispositioned below.

## Exact reviewed scope (frozen, 70 files)

Authoritative list is `result.json.scope` in the Run Directory above (byte-frozen at review
start; all seven reviewers digest-verified it against HEAD `1c22980`): the F6 spec +
plan-alignment, ADRs 0075–0080 + README, all 8 remediation plans, `packages/framework/package.json`,
and the framework sources/tests under `packages/framework/src/{file,checkpoint,state-machine,types,llm,scripts}`,
`packages/framework/src/file.ts`, and 22 test files.

## Surviving critical (mandatory)

### C1 — `llm/fake-client.ts` `isThenable` is not total; hostile values escape as raw rejections (finding `comment-analyzer-1`, upheld 3/3)

**Claim (verbatim from result.json):** The `isThenable` doc comment (fake-client.ts:88-91) asserts
the thenable check is total on hostile values because a throwing `then` getter "flows into the
existing JSON-serialization guard", but the `.then` read is observable: a throwing `then` getter or
Proxy `get` trap makes `isThenable` itself throw, and both call sites (fake-client.ts:153,
fake-client.ts:243) execute outside any try/catch, so such hostile values escape as raw untyped
promise rejections instead of a typed node-crash.

**Panel reasoning (all three lenses upheld):**
- *reproduction:* a value with a throwing `then` getter or Proxy `get` trap reaches `isThenable`
  at both call sites; the `.then` read is precisely the observable operation that throws; no
  try/catch encloses either call (provider try closes before, JSON-stringify try opens after);
  the throw escapes as a raw Promise rejection and the claimed guard is never reached.
- *intent:* the comment explicitly says "Total on hostile values" and both of its clauses fail
  against the code; the file's own documented intent (a throw must become a typed node-crash,
  never a raw rejection, FR-040) is directly contradicted.
- *security:* the self-declared total-on-hostile-values adversarial defense is not total; the
  breach lands on the LlmClient port's FR-040 Result boundary that every adjacent seam enforces.

**Concrete fix:**
1. Make `isThenable` total: keep the null/typeof checks, then read `.then` inside
   `try { … } catch { return false }` — a throwing `then` getter / Proxy `get` trap is NOT a
   thenable (probe swallows the trap), so the value flows into the JSON-serialization guard,
   where the re-read throws and is caught into the existing typed node-crash. This makes the
   code do exactly what the doc already claims, at both call sites.
2. Correct the doc comment to state the actual mechanism (probe catches the trap → not a
   thenable → JSON-serialization guard fails it with a typed crash), replacing the false
   "the read itself is not observable here" clause.
3. `sendWithTools`: after the (now-total) probe, the loop immediately reads
   `turnSpec.tokensIn / turnSpec.tokensOut / turnSpec.type / turnSpec.thinking` OUTSIDE any
   try/catch — a Proxy `get` trap (the same hostile class the panel's reproduction lens tested,
   passed as a script return) would escape raw there once the probe is fixed. Snapshot those
   four fields in their own guarded block (typed node-crash, message naming the unreadable
   turn) and use the snapshots downstream (`type` → `turnType`, `thinking` → `turnThinking`,
   tokens → `tokensIn`/`tokensOut`). The script-call try and the `!turnSpec` / thenable crash
   messages are unchanged (pins stay green). Remaining `turnSpec` observations
   (`responseId`/`responseModel`/`finishReason` in the span callback, `content` in the
   safeParse try, `calls` in the dispatch try) already sit inside guarded regions.
4. Hostile-value pins in `llm-fake-client.test.ts` (both seams):
   - provider function / Map value returning `{ get then() { throw } }` → typed node-crash
     `not JSON-serializable` (never a raw rejection);
   - Proxy with throwing `get` trap as a Map provider value → typed node-crash;
   - script returning a throwing-`then` value / throwing-`get`-trap Proxy → typed node-crash
     (Promise-message branch vs unreadable-fields branch respectively).

## Refuted-critical audit

**None.** `result.json.refuted_critical_findings` is empty — every canonical critical this
round survived the panel, so there is nothing refuted to audit and nothing off-limits.

## Advisory dispositions (22)

### ACCEPTED — 17 (fixes below)

| ID | Location | Disposition |
|---|---|---|
| silent-failure-hunter-1 | checkpoint/checkpointer.ts:283 | ACCEPT |
| silent-failure-hunter-2 | file/resume-proof.ts:344 | ACCEPT |
| pr-test-analyzer-2 | llm/fake-client.ts:290 | ACCEPT |
| pr-test-analyzer-3 | llm/fake-client.ts:143/191 | ACCEPT |
| pr-test-analyzer-4 | checkpoint/checkpointer.ts:317 | ACCEPT |
| type-design-analyzer-1 | llm/fake-client.ts:92 | ACCEPT (same root cause as C1 — resolved by the C1 fix) |
| type-design-analyzer-2 | file/atomic.ts:451 | ACCEPT |
| comment-analyzer-2 | file/journal.ts:232 | ACCEPT |
| comment-analyzer-3 | scripts/check-imports.ts:163 | ACCEPT |
| architecture-tech-lead-5 | checkpoint/checkpointer.ts:423 | ACCEPT |
| code-simplifier-1 | checkpoint/checkpointer.ts:208 | ACCEPT |
| code-simplifier-2 | file/job.ts:238 | ACCEPT |
| code-simplifier-3 | file/freshness-index.ts:274 | ACCEPT |
| code-simplifier-4 | checkpoint/composite-node-key.ts:71 | ACCEPT |
| code-simplifier-5 | file/atomic.ts:70 (+3 sites) | ACCEPT |
| code-simplifier-6 | file/checkpointer-codec.ts:365 | ACCEPT |
| code-simplifier-7 | file/checkpointer.ts:137 | ACCEPT |

### DEFERRED — 4 (concrete, evidence-based reasons)

| ID | Reason |
|---|---|
| architecture-tech-lead-1 (FR-009 walker consolidation into one canonical materializer) | Cross-module FC/IS deepening that touches all THREE durable write surfaces (event, checkpoint, node-output) and their pinned hostile-input corpora, and changes the event path's `toJSON`-gate semantics — a behavior-sensitive change to a durable format. The project's round-7 plan deliberately defers the same class of consolidation to dedicated deepening rounds (D1/D2); a remediation pass that also carries C1 is not the risk envelope for it. Carried as a NEW deferral for the next `file/` deepening round. |
| architecture-tech-lead-2 (honest-branding `checkpoint-write-failed` policy unification) | Already tracked as round-7 plan **D1**; the Redis adapter carries a third encoding surface that must enter scope before a single encoding is complete. Interim state (manually mirrored, pinned on both sides) is the documented D1 interim. |
| architecture-tech-lead-3 (freshness pure-decision core extraction) | Already tracked as round-7 plan **D2**, explicitly scheduled "for the next `file/` deepening round". Behavior-preserving module reorganization; not remediation work. |
| architecture-tech-lead-4 (`{now?}` options-grammar unification) | Tracked since round-6 plan D2 ("the next `file/` design pass"); unification changes the pinned hostile-options message text / Proxy observation strategy that the pinned suites assert, so it belongs in a design pass, not a fix round. |

### DISMISSED — 1 (evidence-based)

| ID | Reason |
|---|---|
| pr-test-analyzer-1 (replayEventsUntil/replayEventSlice "zero tests reference either function") | The claim is factually wrong. `src/__tests__/state-machine-replay.test.ts` (in frozen scope) contains dedicated `describe("replayEventsUntil")` and `describe("replayEventSlice")` blocks with named pins for every surface the finding lists: half-open predicates ("untilMs at exact event timestamp excludes that event (half-open)"; "[fromMs, toMs) is inclusive at fromMs, exclusive at toMs"), the RangeError guards (non-finite untilMs; non-finite fromMs/toMs; inverted `toMs < fromMs`), the empty-filter edges ("untilMs strictly before any event returns initial state"; "empty window (toMs === fromMs) returns initial state untouched"; "window outside event range"), and envelope unwrap through `foldStep` (every fixture entry is a `RecordedEvent` envelope, plus the raw-vs-envelope equivalence test). Nothing to fix. |

No other advisories were dismissed: every remaining claim is either sound with a practical in-scope fix (accepted) or explicitly tracked in the project's own deferral schedule (deferred with the tracking reference).

## Accepted advisory fixes (concrete)

**A1 — silent-failure-hunter-1** (`checkpoint/checkpointer.ts` `InMemoryCheckpointer.load`):
`opts?.expectedDagFingerprint` is read up to three times with no guard. Snapshot it ONCE at the
top of `load` under `try { … } catch { return err(cacheError("checkpoint:load", "load could not
inspect options: " + safeErrorMessage(error))) }` (message style mirrored from the file
backend's `parseLoadOpts` seam, `file/checkpointer.ts:472`), then use the snapshot for the
gate, the comparison, and the `expected` field. Pin: throwing `expectedDagFingerprint` getter
→ typed `cache-error(checkpoint:load)`, never a raw rejection; and a stateful getter returning
different values per read is observed exactly once (pin the single-read semantics).

**A2 — silent-failure-hunter-2** (`file/resume-proof.ts` `proveResumeAgreement`): in the
guarded `parseCheckpoint` decoder seam, validate the returned bag before the `ok` branch:
`decoded === null || typeof decoded !== "object" || !("ok" in decoded)` → rejected with
`parseCheckpoint returned a non-Result value <rendered>; it must return ok(data) or
err(message)` instead of the current `<checkpoint path>: undefined`. The lambda already runs
inside `guardCheckpointCorrupt`, so a throwing `ok` getter stays handled as `checkpoint-corrupt`.
Pin: a decoder returning the bare `{ state, context }` payload → `checkpoint-corrupt` naming
the off-contract return (file-resume-proof.test.ts).

**A3 — pr-test-analyzer-1** (`state-machine/replay.ts`): DISMISSED — see the Dismissed table
above; the claimed gap does not exist. No change, no new test file.

**A4 — pr-test-analyzer-2** (`llm-fake-client.test.ts`): final-turn schema-validation
FAILURE branch (non-throwing mismatch) → typed node-crash `Schema validation failed: …`.
Currently only the throwing-getter twin is pinned.

**A5 — pr-test-analyzer-3** (`llm-fake-client.test.ts`): pin the two unconfigured-seam
diagnostics — `no withToolsScript configured` (sendWithTools with no script) and the
`no response configured for model="…"` MESSAGE (the Map-miss case currently asserts only the
kind).

**A6 — pr-test-analyzer-4** (`redis-checkpointer.test.ts`, InMemory section): in-memory TTL
boundary pin mirroring the file backend's `atBoundary` tests — exactly
`TTL_SECONDS * 1000` accepted (via injected `now` + `__testRawMetas` createdAt), one ms past
rejected `checkpoint-expired`. Closes the `>` → `>=` regression hole at
`checkpointer.ts:317`.

**A7 — type-design-analyzer-1**: identical root cause to C1; no separate change — the C1 fix
(total `isThenable` + hostile pins) resolves it.

**A8 — type-design-analyzer-2** (`file/atomic.ts` `acquireFileLock`): the outer catch
re-wraps the loop body's own already-typed timeout throw, doubling the
`acquireFileLock failed at <path>:` prefix. In the outer catch, propagate an already-typed
`FrameworkError` verbatim (`if (isFrameworkError(error)) throw error;` before the wrap).
Terminal timeout then reads once; inner typed failures (e.g. fenced-reap) keep their precise
operation instead of being relabeled. The existing pin (`file-atomic.test.ts:886`,
`toContain("Could not acquire lock after 50 attempts")`) stays green. Verify the
`withFileLock`/release catches don't rely on the re-wrap (reviewer-verified: they wrap
distinct throws).

**A9 — comment-analyzer-2** (`file/journal.ts` `listEventFiles` doc): a DELETED record cannot
appear in the durable listing — deletion produces a contiguity gap caught by the strict reader,
not a `sequence = count` inflation. Rephrase: foreign `*.json` entry, a renamed (externally
moved) record, or a non-regular-file squat inflate the count; a deletion, by contrast, produces
a contiguity gap the strict reader catches.

**A10 — comment-analyzer-3** (`scripts/check-imports.ts` `shared` rule): delete the empty
`scopeExcludes: []` whose only content is a prose comment (reads like a live/pending
exemption); move the historical rationale to a plain comment above the rule object. The rule
works identically without the key (`isExcluded` treats absent excludes as none).

**A11 — architecture-tech-lead-5** (`checkpoint/checkpointer.ts` `Checkpointer.setMeta` port
doc + pin): make the write-failure kind mapping an explicit port decision instead of an
accident of sequencing. Document on the `setMeta` port JSDoc: file backend →
`checkpoint-write-failed` (ADR-0080 table), in-memory → `cache-error(checkpoint:setMeta)`,
Redis → `cache-error(setMeta)` (pre-existing, FR-001/FR-042-frozen) — same invalid-metadata
input class, kind diverges by backend by decision. Pin the in-memory kind in the
hostile-totality suite (throwing meta getter → `cache-error`, operation
`checkpoint:setMeta`); the file twin is already pinned in `file-checkpointer.test.ts`.

**A12 — code-simplifier-1** (`checkpoint/checkpointer.ts`): delete the module-private
`cacheError` helper — `frameworkError.cacheError` (already imported) produces the
byte-identical object in both arms. Replace the four call sites, delete the helper + its doc.

**A13 — code-simplifier-2** (`file/job.ts` `createFileJob.appendEvent`): the catch re-wraps
the journal's already-typed `cache-error(appendEvent)` with the identical operation and
location, double-nesting the message. Let an already-typed `FrameworkError` ride through
unchanged (`if (isFrameworkError(error)) throw error;`); keep the `|`-dedupKey branch (it adds
the computeDedupKey hint + explicit `"permanent"`) and keep the wrap as the belt-and-suspenders
totality floor for unexpected raw throws (AD-6 port contract). The `|`-branch pin
(`/computeDedupKey/`) stays green; no test pins the double-nested text.

**A14 — code-simplifier-3** (`file/freshness-index.ts` `parseStoredFreshnessEntry`): delete
the `rawEntry`/`rawWitness` field-mirror objects — after `JSON.parse` + `isPlainRecord` +
`hasExactKeys`, JSON output has no getters/traps, so the mirrors add no invariant over
reading `raw.*` directly (the exact-key gate is the single shape fact).

**A15 — code-simplifier-4** (non-negative-safe-integer, 4 encodings): export ONE
`unknown`-accepting `isNonNegativeSafeInteger` from `checkpoint/composite-node-key.ts`
(`typeof value === "number" && Number.isSafeInteger(value) && value >= 0` — typeof-first, so
no ToNumber coercion trap on hostile values); delete the codec's private copy
(`checkpointer-codec.ts:780`) and replace the inline checks at `:264` (`serializeMeta`) and
`:328` (`parseStoredMeta`) with the shared guard. Strictly more total at `:264` (the old
inline ran `Number.isSafeInteger` before the typeof check).

**A16 — code-simplifier-5** (NUL-free non-empty path-string gate ×4): one shared predicate
(e.g. `isNulFreeNonEmptyString` in `file/boundary-error.ts`, which every file-backend module
already imports for its error constructors); per-site messages stay at each call site
(`atomic.ts:70`, `journal.ts:206`, `file/checkpointer.ts:290`, `freshness-index.ts:420`).

**A17 — code-simplifier-6** (`file/checkpointer-codec.ts:365-367`): delete the
`OUTPUT_RESERVED_TAG_KEYS` / `OUTPUT_POLLUTION_KEYS` alias pair — use the imported
`RESERVED_TAG_KEYS` / `POLLUTION_KEYS` directly at the two use sites (lines ~521/524); one
name per concept.

**A18 — code-simplifier-7** (`file/checkpointer.ts:137`): the "source-compatibility"
`META_RECORD_NODE_ID` re-export has no real consumers — the package `exports` map exposes only
`./file`, so no external consumer can import `file/checkpointer.js` directly. Re-point the
barrel (`src/file.ts:57`) to `./file/checkpointer-codec.js`, delete the re-export + its
rationale comment, and update `file-checkpointer.test.ts:42` to import from the codec (the
barrel-parity assertion at :273 keeps meaning — barrel vs codec).

## Support paths (not in reviewed scope — registered with the remediation run)

- `.claude/plans/2026-08-17-pr-remediation-round-8.md` (this plan)

## Changed files (expected)

- `packages/framework/src/llm/fake-client.ts` (C1, A7)
- `packages/framework/src/checkpoint/checkpointer.ts` (A1, A11, A12)
- `packages/framework/src/file/resume-proof.ts` (A2)
- `packages/framework/src/file/atomic.ts` (A8, A16)
- `packages/framework/src/file/journal.ts` (A9, A16)
- `packages/framework/src/file/job.ts` (A13)
- `packages/framework/src/file/freshness-index.ts` (A14, A16)
- `packages/framework/src/file/checkpointer.ts` (A16, A18)
- `packages/framework/src/file/checkpointer-codec.ts` (A15, A17)
- `packages/framework/src/checkpoint/composite-node-key.ts` (A15)
- `packages/framework/src/file.ts` (A18)
- `packages/framework/src/scripts/check-imports.ts` (A10)
- `packages/framework/src/file/boundary-error.ts` (A16 shared predicate home)
- `packages/framework/src/__tests__/llm-fake-client.test.ts` (C1 pins, A4, A5)
- `packages/framework/src/__tests__/redis-checkpointer.test.ts` (A1, A6, A11 pins)
- `packages/framework/src/__tests__/file-resume-proof.test.ts` (A2 pin)
- `packages/framework/src/__tests__/file-checkpointer.test.ts` (A18 import re-point)
- `packages/framework/src/__tests__/file-atomic.test.ts` (A8 pin refresh, if the terminal
  message shape changes)

## Validation

Run from `packages/framework` (full suite — every change above is behavior- or
message-sensitive and pinned):

1. `bun test` — full suite (2677+ tests; Redis-gated skips stay skipped without REDIS_URL)
2. `bun run typecheck`
3. `bun scripts/check-imports.ts` — FR-041 boundary gate (exit 0, zero violations)

Iteration policy: any failure → fix root cause → re-run all three. No staging or commit until
all three are green.
