# PR Remediation Plan — Round 9 (F6 file durable runtime)

**Branch:** `feat/f6-file-durable-runtime`
**HEAD at review:** `9167dec`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-2026-08-17-161552-f6-file-durable-runtime`
**Authoritative result:** `result.json` (digest `12b61798…`, published by the registered
Standalone Review Program after the engine-owned Refutation Panel)

## Round-9 review summary

7 reviewers (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier)
over the 71-file frozen scope. Canonical counts: **1 critical (panel-upheld 3/3),
0 refuted, 16 advisories** (12 accepted, 3 deferred, 1 dismissed).

## Surviving critical (mandatory)

**C1 — comment-analyzer-1** — `packages/framework/src/checkpoint/composite-node-key.ts:75`
(Refutation Panel: **upheld 3/3** — reproduction, intent, and blast-radius lenses all
failed to refute; see the panel evidence in the Run Directory for the full reasoning.)

The `isNonNegativeSafeInteger` doc comment states: "`typeof` first:
`Number.isSafeInteger` coerces non-strings, so a bypassed brand smuggling an object would
mint junk instead of failing closed". This is factually false: `Number.isSafeInteger`
performs **no type coercion** — per ECMA-262 it returns `false` for any non-`Number`
input (verified empirically on Node and Bun: `Number.isSafeInteger('42') === false`,
`Number.isSafeInteger({}) === false`). The guard is not a coercion gate *for
`isSafeInteger`*; the real coercion hazard in the conjunction is the relational
`value >= 0`, which applies ToNumber — a smuggled `valueOf`-bearing object would throw a
raw trap there. The `typeof` guard is load-bearing because it keeps `value >= 0`
unevaluated on non-numbers (and supplies the type-predicate narrowing); the adjacent
`isIdComponent` analogy is only half-right (`RegExp.prototype.test` genuinely coerces,
`Number.isSafeInteger` does not).

**Fix:** rewrite the rationale to state the truth — the coercion trap is the `value >= 0`
comparison (ToNumber), not `Number.isSafeInteger`; the `typeof` guard is what keeps the
comparison off hostile values, and is the same discipline as `isIdComponent` / `ids.ts`
`validate()` (correcting the analogy to name which predicate actually coerces). The
guard itself is unchanged (panel blast-radius lens: no consumer path's behavior changes).

**Implementation-time discovery (same function, same hostile-input class — folded into
this fix):** probing the guard's seams showed the codec's own rejection message in
`assertIndexOrAttempt` was NOT total — it rendered the hostile value with `String(value)`,
which calls the value's `toString`; a `toString`-bearing hostile object therefore trapped
**inside the codec's own diagnostic** (empirical probe: `compositeNodeKey(N(…), { index:
{ toString() { throw } } })` → raw `"toString exploded"`, not the codec's typed rejection),
violating the codec's typed-throws contract. `String(value)` uses ToPrimitive-free
`ToString` (it never consults `valueOf`), so `valueOf`-bearing hostiles rendered safely —
only `toString` hostiles trapped. *Fix:* render the rejected value with the shared total
`safeDiagnosticRender` (`types/safe-error.ts`, object-tag-first, `"<unprintable>"`
fallback — the same one-encoding discipline round 6 established for the error factories).
No test pins the old message wording (verified by search); numeric rejections render
identically.

## Advisory dispositions (16)

### ACCEPTED — 12

**A1 — silent-failure-hunter-1** (`packages/framework/src/llm/fake-client.ts:147`):
the Map-provider resolution `responses.get(req.model) ?? responses.get(req.system)`
treats a configured **`null`** under the model key as "absent" — with a system-key
fixture present, a scripted `null` silently receives the system-key fixture (a silently
substituted test oracle); with only the model key set, the failure is loud but
misattributed. The function form *can* express a null response
(`(req) => null` round-trips to `ok({ output: null, … })`), so the Map form has an
expressiveness hole versus its own sibling, and the doc gloss ("the model key wins when
present") overstates `??` semantics.
*Fix:* key-presence resolution — `responses.has(req.model) ? responses.get(req.model) :
responses.get(req.system)`; correct the doc to "the model key wins when **owned** by the
Map (a configured `null` is a legal response, not a miss)"; pin
`new Map([["m1", null], ["sys", { result: 1 }]])` ⇒ `ok` with `output: null`, not the
system fixture, next to the existing Map-order pin.
*Rationale:* sound claim, real silent-substitution hazard in test tooling, complete
in-scope fix is small.

**A2 — pr-test-analyzer-1** (`packages/framework/src/checkpoint/composite-node-key.ts`,
`packages/framework/src/__tests__/file-checkpointer.test.ts`): `isNonNegativeSafeInteger`'s
typeof-first ordering is unpinned by any hostile corpus with a **throwing `valueOf`**
value (existing corpora stop at plain objects, which fail the predicate without
trapping). A regression re-ordering the conjunction (e.g. `value >= 0` before `typeof`)
would let the ToNumber comparison trap on a hostile object and reject **raw** across the
`saveNode` port — where `parseSaveNodeBoundary` runs *outside* the snapshot
try/catch (`file/checkpointer.ts:401`) — with every suite green (FR-040).
*Fix:* pin the ordering at three levels:
1. `composite-node-key.test.ts` — pin the ordering AND the message totality with
   `{ valueOf() { throw new Error("valueOf exploded") } }` and
   `{ toString() { throw new Error("toString exploded") } }` for `index` and `attempt`;
   assert the codec's own typed rejection message ("expected a non-negative safe
   integer"), never the hostile's own error text (a `value >= 0`-first regression traps
   via ToNumber → valueOf; the pre-round-9 message template trapped via toString).
2. `file-checkpointer.test.ts` — `saveNode(run, "n1", state, { index: { valueOf() { throw } } })`
   ⇒ `err(checkpoint-write-failed)`, never a raw rejection (the guard is the floor
   outside the try).
3. `file-checkpointer.test.ts` — `setMeta(run, { …, nodeCount: { valueOf() { throw } } })`
   ⇒ `err(checkpoint-write-failed)`, never a raw rejection (`serializeMeta`'s shared
   guard catches it inside the typed boundary).
*Rationale:* directly hardens the invariant the round-9 critical corrects the
documentation for; small pins in in-scope suites.

**A3 — pr-test-analyzer-2** (`packages/framework/src/__tests__/file-atomic.test.ts:886`):
the terminal lock-timeout pins assert `toContain("Could not acquire lock after 50
attempts")`, which passes identically under the pre-round-8 double-wrapped shape
(`acquireFileLock failed at <path>: cache acquireFileLock failed at <path>: …`). The
round-8 A8 property — the operation prefix appears **exactly once** (the terminal
timeout's typed error rides through `atomic.ts`'s catch, which now only wraps
non-typed throws) — is unasserted.
*Fix:* in the terminal-timeout pin, add an exact-once assertion: the message contains
`"acquireFileLock failed at"` exactly once (count-based, path-independent).
*Rationale:* the stated property of the previously-remediated fix deserves the pin;
one-line addition to an in-scope suite.

**A4 — pr-test-analyzer-3** (`packages/framework/src/__tests__/file-job.test.ts:568`):
the round-8 A13 ride-through (`file/job.ts` `appendEvent` lets an already-typed
`FrameworkError` through unchanged) is pinned for content and `permanent` class via the
`|`-dedupKey branch, but not for **nesting depth** — the round-8 plan itself concedes
"no test pins the double-nested text". A regression to re-wrapping in `job.ts` would
stay green.
*Fix:* add a pin that exercises the plain ride-through branch (NOT the `|` hint
branch): `job.appendEvent(event, "bad key")` (non-`|` invalid charset ⇒ the journal's
own typed `cache-error(appendEvent)`, permanent) ⇒ assert `failureClass === "permanent"`,
the journal's FR-015 diagnostic text, and that `"appendEvent failed at"` appears
**exactly once** in the message (a re-wrap would read twice).
*Rationale:* same class as A3 — pin the nesting property the fix exists for.

**A5 — pr-test-analyzer-4** (round-8 plan citation): the round-8 A3 dismissal cites
`src/__tests__/state-machine-replay.test.ts` as "in frozen scope"; the file is a
pre-existing repo test **outside** the frozen packet (this round's 71-file scope contains
`state-machine/replay.ts` but not its test file). The dismissal's substance is correct
(the dedicated `describe` blocks exist and pass at HEAD) — only the citation is wrong.
*Fix:* correct the citation clause in
`.claude/plans/2026-08-17-pr-remediation-round-8.md` (DISMISSED table) to: "(a
pre-existing repo test outside the frozen scope; verified present and green at HEAD)".
*Rationale:* the plan is in reviewed scope; a false scope citation misdescribes the
evidence's location for future reviewers; one-clause correction.

**A6 — type-design-analyzer-2** (`packages/framework/src/types/errors.ts:69-75`): the
`checkpoint-write-failed` variant admits fabricated internal placeholder ids
(`checkpoint_invalid_run` / `checkpoint_invalid_node`) in its required branded
`runId`/`nodeId` fields; a consumer that reads the branded fields without first checking
`invalidRunId`/`invalidNodeId` attributes the failure to a nonexistent run/node.
*Fix:* add the consumer read-order contract to BOTH fields' JSDoc: when the
corresponding `invalid*` attribute is present, the branded field is a fabricated
internal placeholder, not the address of a real run/node — inspect `invalid*` first.
Doc-only; no behavior change.
*Rationale:* cheap, complete, in-scope documentation of a real consumer trap the
type-level state already admits.

**A7 — code-simplifier-1** (`packages/framework/src/checkpoint/checkpointer.ts:225-235`):
the module-private `cacheError` helper forwards all three arguments unchanged to
`frameworkError.cacheError` (already imported) — a pure pass-through with no narrowing.
Round-8 A12 specified exactly this deletion ("Replace the four call sites, delete the
helper + its doc"); the landed fix stopped at delegation, leaving the pass-through in
place.
*Fix:* call `frameworkError.cacheError` directly at the five call sites (302, 342, 346,
450, 459); delete the helper and its doc. Completes round-8 A12.
*Rationale:* the project's own one-encoding discipline; the deletion was already
adjudicated in round 8.

**A8 — comment-analyzer-2** (`packages/framework/src/checkpoint/checkpointer.ts:227`):
the `cacheError` helper doc claims "The file backend cannot use that factory (its
boundary stays off the public string-typed shape)" — false: `fileCacheError`
(`file/boundary-error.ts:66`) delegates in one call to that same public
`frameworkError.cacheError` factory (its only job is narrowing `operation` to the closed
`FileOperation` vocabulary, per its own doc). Independently flagged as the same stale
comment by code-reviewer.
*Fix:* resolved by A7's deletion — the wrapper and its contradictory doc are removed
together; no separate doc edit survives.
*Rationale:* sound claim; the deletion is the complete fix (leaving a corrected doc on
a to-be-deleted helper would be churn).

**A9 — comment-analyzer-3** (`.claude/specs/…/spec.md:179`): the Dependencies line says
the shared `checkpointerSuite` is "currently defined in
`__tests__/redis-checkpointer.test.ts`; becomes parametrized over backends" — stale:
the suite now lives in `__tests__/_checkpointer-suite.ts` and is already parametrized
over in-memory, Redis, and file.
*Fix:* update the line to state the suite is defined in `__tests__/_checkpointer-suite.ts`,
parametrized over backends (in-memory, Redis, file).
*Rationale:* doc rot in an in-scope spec; docs updated where they live.

**A10 — comment-analyzer-4** (`.claude/specs/…/plan-alignment.md:50`): the FR-015 coverage
row cites `isBoundaryId` as the FR-015 dedupKey-boundary validator — but `isBoundaryId`
enforces the FR-016 ID charset `^[A-Za-z0-9_:-]{1,128}$`. The FR-015 dedupKey charset
`^[A-Za-z0-9:_-]{1,256}$` with the AD-2 pipe exclusion is owned by
`DEDUP_KEY_PATTERN` / `dedupKeyError` in `file/event-record.ts`.
*Fix:* correct the row's validator citation to `DEDUP_KEY_PATTERN` / `dedupKeyError`
(`file/event-record.ts`), record parse, charset validated at append.
*Rationale:* wrong cross-reference in an in-scope alignment doc; one-cell correction.

**A11 — code-simplifier-3** (`packages/framework/src/checkpoint/checkpointer.ts:319-328`):
`InMemoryCheckpointer.load`'s `expectedDagFingerprint` gate is a nested two-level `if`
while the file backend's twin gate for the identical port contract
(`file/checkpointer.ts:517-521`) is a single `&&` guard.
*Fix:* flatten to `if (expectedDagFingerprint !== undefined &&
meta.dagFingerprint !== expectedDagFingerprint)` — pure boolean restructuring, zero
behavior change (both operands are already-snapshotted pure reads), one gate shape for
one port rule across backends.
*Rationale:* sound; trivially safe; backend-parity shape the project already uses.

**A12 — code-simplifier-4** (`packages/framework/src/file/checkpointer-codec.ts:894-897`):
`parseLoadOpts`'s `hasFingerprint` presence check re-proves what the exact-key gate
already established: after the unsupported-key rejection, `ownKeys` can only be `[]` or
`["expectedDagFingerprint"]`, so `loadOpts.expectedDagFingerprint` is `undefined` exactly
when the key is absent.
*Fix:* replace `hasFingerprint` + conditional with the single direct read. Verified
observation-parity: both forms make exactly `Reflect.ownKeys` (snapshotted once, kept
for the unsupported-key gate) + one property read when present; on a plain object (no
prototype chain, no Proxy — `isPlainObject`-proven) an absent-key read triggers no
traps, so the single-read semantics the round-8 A1 pins assert are preserved.
*Rationale:* sound; one fewer branch and pass over caller-owned keys in a
hostile-boundary module; identical observable behavior.

### DEFERRED — 3 (tracked for the next `file/` deepening round)

**D1 — type-design-analyzer-1** (checkpoint-write-failed truthful-branding policy):
two independent encodings — `checkpointWriteFailed` (in-memory) and `writeFailed`
(file codec) — manually mirrored, kept in sync by docs and per-backend corpora.
*Deferral reason:* already tracked as round-7 plan **D1** and re-listed in the round-8
plan's deferral table; the Redis adapter carries a **third** encoding surface that must
enter scope before a single encoding is complete. Interim state (mirrored + pinned on
both sides) is the documented D1 interim. Cross-module sharing is a `deepen` call, not a
remediation fix.

**D3 — architecture-tech-lead-1** (`state-machine/replay.ts` foldStep duck-typing):
`foldStep` discriminates envelope vs raw event by structural shape
(`isRecordedEvent` matches `{recordedAtMs: number, event, synthetic?: boolean}`); a
machine event `E` that structurally matches the envelope shape is silently unwrapped —
including through `replayEvents`' typed raw-events overload — a silent misfold the type
system does not prevent (confidence 80).
*Deferral reason:* the reviewer frames the fix as a first-class public-kernel refactor
per CONTEXT.md invariant 8 (brand `RecordedEvent` + `recordEvent` smart constructor +
drop the raw-events overload — an API change to the main `@fuguejs/framework` barrel).
That is a deepening-round design pass (public seam, durable-resume proof depends on the
fold), not a remediation-pass change. NEW deferral for the next deepening round.

**D4 — architecture-tech-lead-2** (`file/journal.ts` append-transaction core): the
pure append decision (keyed dedup by digest-suffix scan of the committed listing,
sequence = listing length under the 6-digit ceiling) is embedded inline in
`appendEvent`'s `withFileLock` closure — the last durable write surface without a pure
core (checkpointer core split 2026-08-14; freshness core tracked as D2).
*Deferral reason:* behavior-preserving module reorganization mirroring the
`checkpointer-codec.ts` idiom (extract `planAppend` into a Node-free module) — a
deepening-round item, consistent with the round-7 D1/D2 schedule. NEW deferral for the
next deepening round.

### DISMISSED — 1 (evidence-based)

**code-simplifier-2** (injected-clock validity checks, second disjunct "dead"):
the claim is that once `Number.isFinite(x)` holds, `new Date(x)` is "by specification
always a valid `Date`", making `!isValidDate(new Date(x))` /
`Number.isNaN(new Date(x).getTime())` unreachable. **Empirically false.** Time Values
are finite Numbers in the range ±8.64 × 10^15 (±100,000 years); finite inputs OUTSIDE
that range produce an Invalid Date. Verified on Node v24:

| input | `Number.isFinite` | `new Date(x).getTime()` |
|---|---|---|
| `8640000000000000` (8.64e15) | true | `8640000000000000` |
| `8640000000000001` (8.64e15 + 1) | true | **`NaN`** |
| `1e16`, `1e20`, `-1e16`, `-1e20` | true | **`NaN`** |

The second disjunct is a LIVE gate: a hostile injected clock returning a finite
out-of-range timestamp is caught there and rejected as a permanent `cache-error` —
delete it and the value would be stored, voiding every later FR-027 TTL comparison
(exactly the silent-void class FR-027 pins against). No code change.
**Companion correction (same adjudication, evidence-proven false rationale):** the
in-memory `setMeta` comment at `checkpoint/checkpointer.ts:436-442` motivates the
disjunct with "`new Date(NaN)` is an invalid `Date` that would be stored silently" —
impossible, because `Number.isFinite` catches `NaN` first. It is corrected to name the
actual hazard (finite out-of-range beyond ±8.64e15 ⇒ Invalid Date), the same
false-language-semantics-rationale class as the panel-upheld critical C1. The file
backend's twin comments (setMeta/load) name the rule correctly in general terms and are
left untouched.

## Refuted-finding audit

None. The round-9 canonical result contains `refuted_critical_findings: []` — the single
canonical critical was upheld 3/3 by the Refutation Panel (reproduction, intent, and
blast-radius lenses all failed to refute; per-lens reasoning preserved in the Run
Directory's panel evidence).

## Changed files (expected)

- `packages/framework/src/checkpoint/composite-node-key.ts` (C1 doc correction)
- `packages/framework/src/checkpoint/checkpointer.ts` (A7, A8, A11)
- `packages/framework/src/file/checkpointer-codec.ts` (A12)
- `packages/framework/src/file/checkpointer.ts` (no change — file-twin comments already accurate)
- `packages/framework/src/llm/fake-client.ts` (A1)
- `packages/framework/src/types/errors.ts` (A6)
- `packages/framework/src/__tests__/composite-node-key.test.ts` (A2.1)
- `packages/framework/src/__tests__/file-checkpointer.test.ts` (A2.2, A2.3)
- `packages/framework/src/__tests__/file-atomic.test.ts` (A3)
- `packages/framework/src/__tests__/file-job.test.ts` (A4)
- `packages/framework/src/__tests__/llm-fake-client.test.ts` (A1 pin)
- `.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md` (A9)
- `.claude/specs/2026-08-12-f6-file-durable-runtime/plan-alignment.md` (A10)
- `.claude/plans/2026-08-17-pr-remediation-round-8.md` (A5 citation)

## Support paths (not in reviewed scope — registered with the remediation run)

- `.claude/plans/2026-08-17-pr-remediation-round-9.md` (this plan)

## Validation commands

```bash
cd /home/peterstorm/dev/agentic/fugue
bun run typecheck            # tsc --noEmit over tsconfig.json + tsconfig.bin.json
bun test                     # full workspace suite (2800+ tests; 38 Redis-gated skips without REDIS_URL)
bun test packages/framework/src/__tests__/composite-node-key.test.ts
bun test packages/framework/src/__tests__/file-checkpointer.test.ts
bun test packages/framework/src/__tests__/file-atomic.test.ts
bun test packages/framework/src/__tests__/file-job.test.ts
bun test packages/framework/src/__tests__/llm-fake-client.test.ts
```
