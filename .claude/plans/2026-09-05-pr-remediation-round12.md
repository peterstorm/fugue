# PR Remediation Plan — 2026-09-05 (round 12)

## Subject

- **Branch**: `feat/f3-budget-capability-surface`
- **Review HEAD**: `254a0f5` (working tree clean at review time)
- **Review Run Directory**: `.claude/reviews/review-and-fix-runs/2026-09-05T00-00-00Z-standalone-review-r12`
- **Canonical result**: that run's `result.json` (digest `ab9012fe80e389f502553a57b7a2af5daf6afba50d3876a67563b6e4b53cbe1a`)
- **Scope**: the frozen 165-file scope registered by the review run (`packages/framework/src`, `packages/host/src`, the customer-summary example, and prior plan files)

## Review outcome

| Bucket | Count |
|---|---|
| Reviewers spawned | 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier) |
| Critical findings raised | 4 |
| Refuted criticals | 0 |
| Surviving criticals (mandatory) | 4 |
| Advisories | 11 |

The Refutation Panel ran three lenses (reproduction, intent, security) over all four
criticals. Twelve verdicts: eleven `upheld`, one `refuted` (the *intent* lens on C2).
The engine's adjudication kept C2 in `surviving_critical_findings`, so it is mandatory —
but the intent lens's objection is sound and **shapes** the fix (see C2 below).

## Surviving criticals — mandatory

### C1 — `packages/framework/src/dag-runtime/human-emission.ts:118,124`

`emitHumanIntervention`'s **success path** evaluates `nowFn()` (line 118) and `stamp()`
(line 124) as *arguments* to an unguarded `emit(...)`. Both sibling error branches were
fenced with `bestEffort` in commit `254a0f5` for exactly this reason — a throwing clock
throws before `emit`/`dispatchEvent` is entered, so no observer-side guard can catch it.
The success path was left out. `handleHumanGate` (executor.ts:308) has no try/catch, so a
hostile clock escapes as a raw exception and breaks the module's documented fail-closed
`Result` contract.

**Fix**: wrap the success-path `emit(...)` in the same `bestEffort(...)` fence the two
sibling branches use, so the `ok(undefined)` outcome stays authoritative.

### C2 — `packages/framework/src/types/errors.ts:550`

`persistedUsageSchema` defaults `cacheWriteTokens`/`cacheReadTokens` to `0`, so a legacy
2-key `usage` record parses into a 4-key canonical object. `isSameOwnData`'s own-key-count
equality (line 550) then makes `isFrameworkError` return `false` for a record the schema
was explicitly built to accept. **Verified empirically** before planning: schema parses
`true`, `isFrameworkError(legacy)` returns `false`, modern 4-key returns `true`.

**Fix shape — why not the obvious one.** Making the predicate permissive would be
**unsound and a fail-open regression**. `usage?: PartialTokenUsage = TokenUsage` requires
all four fields; every production call site of `isFrameworkError` returns or rethrows the
*source* object (`run-executor.ts:91`, `run-dag-stateful.ts:519`, `file/job.ts:263`,
`file/atomic.ts:480`, `file/resume.ts:227`, `freshness-index.ts`). Narrowing a 2-key usage
to `FrameworkError` would push `undefined` cache-token fields into budget accounting —
exactly the fail-open this branch exists to prevent. The *intent* verifier's refutation
names this: the exact-match check deliberately "proves the parser output, not the source
object narrowed by this predicate."

**Fix**: add `asFrameworkError(value): FrameworkError | undefined` — parse-don't-validate,
returning the **canonical parsed** value (defaults applied, therefore a genuinely complete
`FrameworkError`) or `undefined`. Route the two genuine *unknown-exception-boundary*
recovery sites through it so a legacy record is recovered canonically instead of dropped:
`run-dag-stateful.ts:519` and `hitl/adapters/run-executor.ts:91`. Keep `isFrameworkError`
exact and document why the two differ. Export `asFrameworkError` from the framework index.

### C3 — `packages/framework/src/state-machine/runner.ts:149`

The `beforeExecute`-abort trace timestamp uses the unguarded `stamp()` helper, while every
other clock read in the file routes through the guarded `readTraceNow()`. `stamp()` runs as
an argument to `emitTrace(...)`, before `emitTrace`'s own try/catch. A throwing `opts.now`
escapes `runStateMachine` as a raw error instead of the intended `BeforeExecuteAbortError`,
so `run-dag-stateful.ts:530`'s `isBeforeExecuteAbortError(e)` check misses and a deliberate
abort is misclassified as a generic crash.

**Fix**: route the abort trace through `readTraceNow()`, matching the file's other
emission site — emit the trace only when the guarded clock yields a value, and always throw
`BeforeExecuteAbortError`.

### C4 — `packages/framework/src/dag-runtime/run-dag-stateful.ts:645`

`return handleTerminalState<O>(...)` returns the promise **without `await`** inside a `try`
whose `catch` routes to `handleKernelError`. A rejection therefore resolves after the try
has already returned and is never caught. The reachable source is the non-background
`succeeded` arm's unguarded `await finalize()` (line 461) — `finalizeRunWithJudges` calls
`runEvalJudges` and then `emitRunEnd("ok")`, which invokes the caller-supplied clock and
`dispatchEvent` unguarded. The sibling `onBackground` branch is explicitly fenced by
`runFinalizeInBackground` for this exact reason.

**Fix**: three halves — the third was found by the regression test, not by review.
(a) `return await handleTerminalState<O>(...)` so the existing catch observes the
rejection; (b) fence the non-background `finalize()` so a throwing judge or run-end routes
through `failClosed`; (c) **`failClosed` itself was not total.** With (a) and (b) applied,
the C4 test still rejected: `failClosed`'s own `emitRunEnd("error")` re-read the same
hostile clock and threw straight back out of the path whose entire job is to fail closed.
Both of its cleanup steps are now fenced independently with `bestEffort`, matching
`runFinalizeInBackground`'s own doctrine, so the typed `Err` is always returned and a span
that fails to close cannot suppress the run-end.

## Advisory dispositions

Dispositioned autonomously from evidence, correctness impact, and reviewed scope.

| # | Finding | Disposition | Reason |
|---|---|---|---|
| A1 | `define-dag.ts:90` duplicate node ids collapse silently; `defineLinearDag` can form an undetected cycle | **accepted, rescoped** | Real gap against the module's own "at boot, not on the first request" contract. The advisory's literal fix (reject any repeated id) was **wrong** and broke `defineRouter`, which legitimately names one shared target from several cases — caught by an existing test. Split into the two distinct hazards: `defineDagFromArray` rejects two *different* definitions under one id (the silent data loss), and `defineLinearDag` rejects any repeat (its chain is positional, so a repeat is a cycle regardless of identity). |
| A2 | `redis-connectivity.ts:315` `commitCheckpointAndRetainSpend` skips `watchGuarded`'s poison gate | **accepted** | It is the one transactional method outside the invariant the rest of the port just hardened. One-line routing change. |
| A3 | `error-handler.test.ts:289` `validVariants` omits the new `circuit-open` kind | **accepted** | The `parseHostError` `circuit-open` branch's validation (integer/non-negative `retryAfterSeconds`, exact-key, malformed `dagId`) has no negative-space test in scope. |
| A4 | `human-emission.ts:43` two branches duplicate build/log/emit of a `node-crash` | **accepted** | Same file as C1; extracting the helper removes the drift point the code currently guards with only a comment. |
| A5 | `run-node.ts:112` `parseBrokerResult` hand-rolls an own-data read | **accepted** | Reuse-before-rewrite, same file. Extracted as a message-free primitive so each caller keeps its own diagnostic wording (the existing messages are test-visible). |
| A6 | `ownDataValue`-style primitive reimplemented across `run-node.ts`, `types/spend.ts`, `run-dag-stateful.ts`, `run-spend-authority.ts` | **deferred** | The reviewer scoped this itself: consolidating across the `framework` ↔ `host` package boundary is an interface change (`deepen` territory), not a same-scope distill. A5 closes the in-file half. |
| A7 | `config.ts` `withLlmPostcondition` repeats a non-empty check six times | **accepted** | One named type predicate; trivially behavior-preserving. |
| A8 | `host-error.ts:308` three identical `isString`→parse→unwrap functions | **accepted** | One generic `parseBranded` helper over the three `try*Id` constructors. |
| A9 | `metered-llm.ts:343` `sendStructured`/`sendWithTools` duplicate snapshot-then-dispatch | **accepted** | One shared dispatch helper; both call sites keep their distinct operation name and `call` closure. |
| A10 | `host.ts` `teardownAfterServerStop` and `performShutdown` each define a step-failure recorder | **deferred** | The two differ in **both** the Error-message format (`"<msg>: <diagnostic>"` vs `"Shutdown step failed: <op>"`, no diagnostic suffix) **and** the attempt shape (awaiting vs sync — making the sync one async would change shutdown ordering). Tests pin the exact differing strings (`entrypoint-wiring.test.ts`, `full-lifecycle.test.ts`). A factory parameterized on both would be no simpler than the two 8-line locals it replaces. |
| A11 | `boundary-error.ts:125` comment wraps mid-sentence | **accepted** | Cosmetic, zero risk. |

## Refuted-finding audit

**None.** `refuted_critical_findings` is empty — the panel refuted no critical outright.
The single `refuted` verdict (intent lens on C2) did not survive adjudication into the
refuted bucket, but its reasoning is recorded above and constrains C2's fix so the
remediation does not introduce an unsound narrowing.

## Support paths

Paths this remediation touches that are **outside** the frozen review scope, to be
registered in the remediation start input's `supportPaths`:

- `.claude/plans/2026-09-05-pr-remediation.md` (this plan)

## Validation commands

```bash
bun run typecheck   # all 12 packages
bun run test        # all 12 packages
```

**Baseline before remediation** (captured on clean `254a0f5`): typecheck 12/12 exit 0;
tests 12/12 exit 0 — framework 3375 pass / 0 fail, host 2526 + 10 pass / 0 fail,
customer-summary 243 pass / 0 fail, all other packages 0 fail.

**After remediation**: typecheck 12/12 exit 0; tests 12/12 exit 0 —
framework **3382** pass / 0 fail (+7), host **2532** + 10 pass / 0 fail (+6),
customer-summary 243 pass / 0 fail, all other packages unchanged and 0 fail.
Net **+13 tests, 0 failures**.

### Mutation verification

Every fix ships a regression test that was confirmed to FAIL against the pre-fix source
(the fix reverted in place, the test re-run, the fix restored):

| Fix | Test | Failure observed against pre-fix source |
|---|---|---|
| C1 | `human-emission.test.ts` — "keeps the successful outcome authoritative under a hostile clock" | 1 fail |
| C2 | `errors.test.ts` — "recovers a pre-prompt-caching usage record through asFrameworkError" | 1 fail |
| C3 | `state-machine-runner.test.ts` — "still aborts with BeforeExecuteAbortError when the trace clock throws" | 1 fail (leaked `"clock failed"` instead of the abort) |
| C4 | `executor.test.ts` — "a failure inside non-background finalize fails closed instead of rejecting" + "a finalize failure still emits the matching run-end('error')" | 2 fail |
| A1 | `define-router.test.ts` — "rejects two different definitions sharing one node id"; `define-linear-dag.test.ts` — "rejects a node listed twice…" | 2 fail |
| A2 | `redis-connectivity.test.ts` — "refuses the atomic checkpoint once the shared connection's WATCH state is poisoned" | 1 fail |
| A3 | `error-handler.test.ts` — three `circuit-open.retryAfterSeconds` rejection cases | 3 fail |

The remaining accepted advisories (A5, A7, A8, A9, A11) are behavior-preserving
refactors with no new observable contract; they are covered by the existing suites,
which stayed green throughout.
