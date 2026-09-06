# PR Remediation Plan — Round 16

**Branch:** `feat/f3-budget-capability-surface`
**Review HEAD:** `880848e32a9260cd6ede1926e180343f276fdbe8` (working tree clean, byte-identical to frozen scope)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-06T12-00-00Z-standalone-review-r16`
**Canonical result:** `<run>/result.json` (digest `fe378d087cf3c72d0d592dd143a58aca06b0aa290282e77f10e132e97c100903`)
**Scope:** `kind: all`, 176 files across `packages/framework`, `packages/host`, `apps/customer-summary`, docs and plans.

## Adjudication summary

| Bucket | Count |
|---|---|
| Reviewers spawned | 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier) |
| Critical findings raised | 1 |
| Refuted by panel | 0 |
| **Surviving critical (mandatory)** | **1** |
| Advisory entries in `result.json` | 33 |
| Unique advisories (13 entries are machine-summary duplicates of the `findings` block) | 20 |
| Advisories accepted | 19 |
| Advisories dismissed | 1 |
| Advisories deferred | 0 |

Refutation panel: lenses `reproduction`, `intent`, `blast-radius`; threshold 2. The single
critical was **upheld by all three lenses**. Nothing was refuted, so there is no
refuted-finding audit to carry — see "Refuted-finding audit" below.

---

## Surviving critical findings (all mandatory)

### C1 — `comment-analyzer-1` · `packages/framework/src/dag-runtime/executor.ts:198`

**Claim.** The `retrying` phase doc comment on `buildDagExecutor` claims a retry
"re-invokes the WHOLE wave, not just the failed node — every node in it runs again,
which is why node `run` functions must be idempotent under retry." Only the failed
node and its co-failed siblings actually re-execute.

**Verified independently.** `retry-policy.ts:87-96` (`handleNodeFailed`) merges the
`node-failed` event's `partialOutputs` into `ctx.outputs` before entering `retrying`.
`wave-execution.ts:127` snapshots that map as `priorOutputs`, and `:136-156` short-circuits
any node where `priorOutputs.has(nodeId)` — emitting `node-skipped` with
`reason: "already-completed"` and returning the carried output instead of calling
`runNodeShared`. `wave-execution.ts`'s own `carriedOutputs` comment states the intent
("so a retry does not re-execute their side effects"), and
`wave-execution-errors.test.ts` asserts it.

**Fix.** Rewrite the `retrying` bullet to state what the code does: the wave is
re-entered, but nodes whose outputs were carried forward are skipped via the
`already-completed` path; only the failed node and any co-failed siblings re-execute,
so idempotency under retry is required of those nodes. Keep the `nextDelayMs * jitter`
sleep statement, which is accurate.

---

## Advisory dispositions

### Accepted (19)

| ID | File | Disposition & fix |
|---|---|---|
| `pr-test-analyzer-1` | `host/src/adapters/run-spend-authority.ts:469` | **Accepted.** Verified: the `try/catch` around `await call()` (execute) converts a thrown/rejected client into a typed `node-crash`; every existing case in `run-spend-authority.test.ts` returns malformed *values*, never throws. Add tests for a synchronous throw and for a rejected promise, asserting the typed `node-crash` message and that the call is still settled/metered. |
| `pr-test-analyzer-2` | `host/src/adapters/run-spend-authority.ts:432` | **Accepted.** Verified: `persist` reports at `warn` when `limits === undefined`, and `settle` returns the original successful result, discarding the write failure. Add a test pinning that unbudgeted ledger-write failure keeps the provider result and emits `llm.ledger-write-failed` at `warn`, contrasted with the budgeted `error`+`node-crash` path. |
| `pr-test-analyzer-3` | `framework/src/dag-runtime/executor.ts:281` | **Accepted.** Add a test firing a real `AbortSignal` during the `retrying` pre-sleep, asserting `{ type: "abort", reason: "signal" }` and that `executeWave` is never entered. |
| `pr-test-analyzer-4` | `framework/src/dag-runtime/executor.ts:298` | **Accepted, as behaviour documentation.** Verified `handleHumanGate` does not re-check `nodeCtx.signal.aborted` after the hook resolves; abort is observed by the node-level check on the next wave. This is intended (a decision that already arrived is honoured), so the fix is a test pinning that behaviour, not a semantics change. |
| `pr-test-analyzer-5` | `host/src/host.ts:1355` | **Accepted.** Add a booted-host test that holds a request in-flight over the UDS listener, shuts down with a short `DRAIN_TIMEOUT_MS`, and asserts both the drain wait and the `Drain timeout — N requests still in-flight` warning. |
| `pr-test-analyzer-6` | `framework/src/types/budget.ts:296` | **Accepted.** Add assertions for `formatBreach`'s two `unknown-usage` branches (tokens axis, usd axis) and `observedOf` against an unknown-usage breach. |
| `pr-test-analyzer-7` | `host/src/host.ts:738` | **Accepted.** Add a boot test with `TEAMS_WEBHOOK_URL` set and no `queueBackend` dep, asserting the `A HITL notifier is configured but no queue backend was wired — HITL is disabled` warning. |
| `pr-test-analyzer-8` | `framework/src/dag-runtime/wave-execution.ts:307` | **Accepted.** Add an `executeWave` test proving `routing.earlyFailure` carries `priorWitnesses` and `freshnessCompletedNodeIds` onto the emitted event. |
| `pr-test-analyzer-9` | `framework/src/types/errors.ts:144` | **Accepted.** Add a test proving a failed attempt's `node-crash.usage` and the successful retry's usage are BOTH metered (the ledger is a monotone append, so they accumulate rather than clobber). |
| `pr-test-analyzer-10` | `framework/src/dag-runtime/wave-execution.ts:133` | **Accepted.** Add a test dispatching two real sibling nodes concurrently in one wave against a single `RunSpendAuthority`, asserting aggregate spend is bounded by the shared ceiling. |
| `pr-test-analyzer-11` | `framework/src/types/spend.ts:450` | **Accepted.** Assert `maxSpend`'s unpriced+unpriced branch on the merged `models` union and `knownMicros`, matching `addSpend`'s equivalent coverage. |
| `pr-test-analyzer-12` | `framework/src/file/spend-store-codec.ts:55` | **Accepted.** Add the missing-field direction of the exact-key-set check. |
| `type-design-analyzer-1` | `host/src/domain/llm-meter.ts:268` | **Accepted — real defect.** Verified: `admitCandidate`'s unpriced-under-usd-ceiling early return never calls `admit()`/`firstBreach`, so it hardcodes `basis: "projected"` and masks a stronger settled breach (a reached `tokens`/`calls` ceiling, or already-`unknown`/`unpriced` settled usd). Fail-closed is preserved either way, so this is a diagnostics-accuracy violation of the settled-before-projected invariant documented at `llm-meter.ts:218-223`. Fix: run the settled `firstBreach` check first and return that breach when present; only then fall through to the unpriced projected refusal. Add tests for both masked cases. |
| `comment-analyzer-2` | `framework/src/shared/make-node-context.ts:106` | **Accepted.** Verified the base literal at `:67-83` carries `cache, checkpointWriter, llm, prompts, judgeLlm, http, clock, budget` — no `db`. Replace the `http`/`db`/`llm` example with real built-ins. |
| `comment-analyzer-3` | `host/src/domain/capability-manager.ts:178` | **Accepted.** Verified: the module imports `logWithoutThrowingTo` from `./diagnostic-logging.js`; `logWithoutThrowing` is a distinct function in `hitl/diagnostic-logging.ts`. Correct the name. |
| `code-simplifier-1` | `framework/src/dag-runtime/wave-execution.ts:233` | **Accepted.** Verified `nodeErrorEmitter` (`post-wave-context.ts:63-88`) centralizes exactly this event shape and its doc says it exists so callers stop hand-rolling copies. Replace the inline co-failed emission with the shared emitter. Diagnostic labels move from `executeWave`/`co-failed node-error emission` to the emitter's own — a label-only change, noted in the code comment. |
| `code-simplifier-3` | `host/src/adapters/node-context-factory.ts:127` | **Accepted.** Verified the `createNamespacedCache` JSDoc at `:127-133` is separated from its declaration at `:143` by `guardedReporter` and its own doc block. Move it adjacent. |
| `code-simplifier-4` | `host/src/__tests__/fixtures/redis-spend-fake.ts:16` | **Accepted.** Verified four byte-identical marker-field lines open both `applyRedisSpendAppend` and `applyRedisSpendAppendInterleaved`. Extract a shared `writeMarkerFields` helper; leave the numeric loop split (the interleaved one yields mid-loop, which is the point of the fixture). |
| `code-simplifier-5` | `CONTEXT.md:263` | **Accepted.** Verified on disk: `run-queue.ts`, `run-store.ts` and `run-executor.ts` all live in `packages/host/src/hitl/adapters/`. Rewrite the cell as `hitl/adapters/{run-queue,run-store,run-executor}.ts`. |

### Dismissed (1)

| ID | File | Reason |
|---|---|---|
| `code-simplifier-2` | `framework/src/dag-runtime/run-node.ts:461` | **Dismissed.** The reporting reviewer itself flagged this "for judgment rather than recommending outright". Adopting `nodeErrorEmitter` here requires constructing a one-entry `Map` purely to satisfy the helper's `nodeMap` parameter, and replaces a direct, always-defined `node.sideEffects` read with a lookup that is typed `undefined`-able. That is a net loss in both clarity and type strength, and `runNodeShared`'s own doc deliberately scopes this closure as THE single-node emission for a node whose definition is already in hand. No change. |

### Duplicate entries (13, no separate work)

`pr-test-analyzer-13` … `pr-test-analyzer-24` are the `ADVISORY:` machine-summary lines
for `pr-test-analyzer-1` … `-12`; `type-design-analyzer-2` is the machine-summary line for
`type-design-analyzer-1`. Each is resolved by the fix for its unique counterpart above.

---

## Refuted-finding audit

`result.json.refuted_critical_findings` is empty. The panel produced no refutations:
the sole critical (`standalone-review:comment-analyzer-1`) was upheld by
`reproduction`, `intent` and `blast-radius`, with `refuted_by: []` and
`uncertain_from: []`. Nothing is being skipped on refutation grounds.

---

## Files to change

**Source (all inside the frozen review scope):**

- `packages/framework/src/dag-runtime/executor.ts` — C1
- `packages/framework/src/dag-runtime/wave-execution.ts` — `code-simplifier-1`
- `packages/framework/src/shared/make-node-context.ts` — `comment-analyzer-2`
- `packages/host/src/domain/capability-manager.ts` — `comment-analyzer-3`
- `packages/host/src/domain/llm-meter.ts` — `type-design-analyzer-1`
- `packages/host/src/adapters/node-context-factory.ts` — `code-simplifier-3`
- `packages/host/src/__tests__/fixtures/redis-spend-fake.ts` — `code-simplifier-4`
- `CONTEXT.md` — `code-simplifier-5`

**Tests (all inside the frozen review scope):**

- `packages/framework/src/__tests__/executor.test.ts` — `pr-test-analyzer-3`, `-4`
- `packages/framework/src/__tests__/budget.test.ts` — `pr-test-analyzer-6`
- `packages/framework/src/__tests__/wave-execution-errors.test.ts` — `pr-test-analyzer-8`
- `packages/framework/src/__tests__/spend.test.ts` — `pr-test-analyzer-11`
- `packages/framework/src/__tests__/file-spend-store.test.ts` — `pr-test-analyzer-12`
- `packages/host/src/__tests__/run-spend-authority.test.ts` — `pr-test-analyzer-1`, `-2`, `-9`, `-10`
- `packages/host/src/__tests__/llm-meter.test.ts` — `type-design-analyzer-1` regression
- `packages/host/src/__tests__/entrypoint-wiring.test.ts` — `pr-test-analyzer-5`, `-7`

**Remediation-owned support path (outside the frozen review scope):**

- `.claude/plans/2026-09-06-pr-remediation.md` (this file)

---

## Validation commands

```bash
bun run --cwd packages/framework typecheck
bun run --cwd packages/host typecheck
bun run --cwd packages/framework test
bun run --cwd packages/host test
```

Validation must pass before any staging or commit. If it cannot pass, stop
without staging.

---

## Distill pass (apply mode, post-implementation)

Green baseline established before the first move; the covering tests were re-run
after each. Four moves applied, all behavior-preserving:

| Move | Catalog move | Location |
|---|---|---|
| A | Reuse before rewrite | `wave-execution.ts` — collapsed the two `post-wave-context.js` imports into one inline-`type` import, matching the project idiom. |
| B | Compress with types + flatten control flow | `llm-meter.ts::admitCandidate` — replaced the bare `find` plus a second `.kind === "usd"` re-test with a typed predicate (`(c): c is UsdCeiling`), and flattened the guard into early returns so the priced/no-budget path leaves at the top. Mirrors `admit`'s own local `refusal` helper. |
| C | Reuse before rewrite | `run-spend-authority.test.ts` — three hand-rolled `LogPort` capture fakes replaced with the existing `collectLogs` fixture (which already had three callers elsewhere), and three byte-identical failing-ledger literals replaced with one `alwaysFailingLedger()` helper. |
| D | Delete duplication | `executor.test.ts` — three near-identical one-node DAG builders collapsed into `dagRecordingDispatch(id)` (which also folds in the "did the node run" flag) plus a `soleWave(dag)` context helper. |

**Skipped, with reasons:**

- A shared `deferred<T>()` test helper. Two copies now exist (`run-spend-authority.test.ts`, `entrypoint-wiring.test.ts`) in two packages with no shared host-test utility module. Extracting one means creating a new seam — a deepening, not a distill move — and two copies do not yet earn it.
- The fourth `LogPort` fake in `run-spend-authority.test.ts` (`logs reservation underflow …`). It deliberately captures only `error` and no-ops `info`/`warn`, so it is a genuinely different fake, not another copy — and it is outside this remediation's diff.
- `run-node.ts::emitNodeError` — see the dismissed advisory `code-simplifier-2`.

**Wrongness discovered:** none beyond the findings already adjudicated above.
**Deepen warranted:** no. No shallow module or misplaced seam surfaced.

---

## Validation evidence

Run at the end of implementation, workspace-wide from the repo root:

```
$ bun run typecheck      → exit 0   (all 10 workspace packages, tsc --noEmit clean)
$ bun run test           → exit 0   (0 failures across every workspace package)
```

Per-package totals in the final run:

| Suite | Result |
|---|---|
| `@fuguejs/framework` | 3516 tests / 190 files — 3464 pass, 52 skip, **0 fail** |
| `@fuguejs/host` | 2617 tests / 124 files — 2600 pass, 17 skip, **0 fail** |
| remaining 8 workspace packages | 723 tests — **0 fail** |

Regression proofs for the two behavior changes:

- `type-design-analyzer-1` — `packages/host/src/domain/llm-meter.ts` was reverted to
  its pre-fix body (`git show HEAD:…`) and the two new tests
  (`reports an already-REACHED settled ceiling …`, `does not relabel ALREADY-settled
  unpriced spend …`) **failed** with `Expected "reached" / Received "unpriced"` and
  `Expected "settled" / Received "projected"`; they pass against the fix.
- `code-simplifier-1` — the pre-existing `a failed co-failure emission still returns
  the primary node-failed` test stays green through the emitter swap; the only
  observable change is the diagnostic label (`executeWave` → `nodeErrorEmitter`),
  which is a `bestEffort` log string, not an outcome.

**One flake, investigated and cleared.** The first full host-suite run showed a
single failure in `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
(`hard-bounds an abort-insensitive node …`, expected `aborted`, got `node-crash`).
It is a timing-sensitive test (5 ms slice budget, 40 ms node, 250 ms race) outside
the changed surface. It passed 3/3 in isolation and 3/3 in subsequent full-suite
runs, and the same suite on a clean `git stash`ed HEAD also passed — so it is a
pre-existing timing sensitivity under load, not a regression from this work.
