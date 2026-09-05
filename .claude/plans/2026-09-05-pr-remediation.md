# PR Remediation — 2026-09-05 (round 11)

**Branch:** `feat/f3-budget-capability-surface`
**Review HEAD:** `2ffbd3f` (`fix: close advisory gaps and fence run-authority requires snapshot`)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-05T00-00-00Z-standalone-review-r11`
**Canonical result:** `<run>/result.json` (digest `c8d8bb93a1c6a8c62637092a14bc832002a65bbf0a23080373886d8ab1fc3498`)

## Review outcome

| Bucket | Count |
| --- | --- |
| Reviewers spawned | 7 |
| Critical findings raised | 3 |
| Critical findings refuted | 1 |
| **Surviving critical findings** | **2** |
| Advisory findings | 28 |

The refutation panel ran three lenses (reproduction, intent, blast-radius) over
the three criticals. Adjudicated result below.

## Surviving critical findings — mandatory

### C1 — `packages/framework/src/dag-runtime/human-emission.ts:48`

The missing-`nodeDef` branch calls `fwLogger().error(...)` and `emit(nodeCtx, …)`
unprotected, while the sibling `confidence.extract`-throw branch wraps the
identical node-error emission in `bestEffortLog` / `bestEffort`.

Panel: **upheld** on reproduction and intent; refuted only on blast-radius.
The decisive evidence is the intent lens: `human-emission.test.ts` ("keeps the
typed confidence failure authoritative under hostile diagnostics") shows the
sibling's `bestEffort` exists to guard the **inline `stamp()` / `nowFn()` call
evaluated as an argument** — which happens *before* `dispatchEvent` is entered,
so `dispatchEvent`'s own try/catch (the blast-radius lens's basis for refuting)
cannot cover it. The unprotected branch calls `stamp()` identically at line 53.
A throwing clock therefore escapes `emitHumanIntervention` as an exception,
breaking the file header's own "Fail-closed … must surface — return `Err`"
contract.

**Fix:** mirror the sibling exactly — `bestEffortLog` for the log, `bestEffort`
for the emit — so both failure paths return `Err` under a hostile clock or
observer. Pin with a test using a throwing `nowFn` on the missing-`nodeDef`
path, asserting `Err` is returned rather than thrown.

### C2 — `packages/host/src/http/handlers/run-dag.ts:250`

The circuit-breaker-open branch calls
`errorResponse(c, 503, "dag-disabled", …, { headers: { "Retry-After": "30" } })`
— a **raw string literal** for the error kind and a **hardcoded** Retry-After.

Panel: **upheld** on intent and blast-radius; refuted on reproduction only
because the finding's stated mechanism was imprecise (neither `dag-disabled`
path actually consults `retryAfterSecondsFor`, since neither throws to reach
the error-handler middleware). The upheld substance is:

1. `host-error.ts`'s `RETRY_AFTER_POLICY` doc states Retry-After must live in
   "ONE authoritative place … no divergent hardcoded sources". A raw `"30"` is
   exactly a divergent hardcoded source.
2. `circuitConfig.cooldownMs` — per-DAG overridable via `resetTimeoutMs` and
   env-configurable via `CIRCUIT_BREAKER_COOLDOWN_MS` — is already computed in
   scope at line 217-221 and is **ignored**; the header always says 30s
   regardless of configuration, which is simply wrong when it is configured
   otherwise.
3. The kind literal collides with the genuine `dag-disabled` variant: two
   semantically different 503s report the same `error` code, one with
   `Retry-After: 30` and one (line 141) with no Retry-After at all. A client
   cannot tell "administratively disabled" from "circuit open, retry shortly".

**Fix (the real one, not a patched literal):** add a typed `circuit-open`
`HostError` variant carrying `dagId` and its own `retryAfterSeconds`, modelled
exactly on the existing `tenant-over-quota` precedent (a variant that carries
its own backoff, read back through a `RETRY_AFTER_POLICY` function). Touches:
the union, `HOST_ERROR_KINDS`, `parseHostError`, `httpStatusFor` (→ 503),
`formatHostError`, `RETRY_AFTER_POLICY`, a `circuitOpen(...)` producer, and the
`run-dag.ts` call site, which derives the value from `circuitConfig.cooldownMs`.
`retryAfterSeconds` is a non-negative safe integer, so the ms→s conversion
rounds **up** (a cooldown must never be under-advertised) with a 1s floor.

## Refuted critical — audited, never fixed

### `code-simplifier-2` — `packages/host/src/adapters/redis-connectivity.ts:189`

Claim: `compareAndRun` returns `ok(false)` on a null EXEC while the sibling
`setIfGuardsHold` / `setNxIfPresent` CAS loops retry, i.e. divergent retry
semantics in a duplicated concurrency pattern.

Panel reasoning:
- **intent — refuted:** `redis-connectivity.test.ts:376-386` has a dedicated
  test literally titled "returns a WATCH conflict as Ok(false)" locking this in
  as the intended contract. `compareAndDelete` / `compareAndExpire` compare
  against unique per-acquisition lock tokens (`run-queue.ts` callers), so a
  WATCH abort means the token already changed — retrying would re-observe a
  mismatch essentially always.
- **blast-radius — refuted:** `compareAndRun` watches and mutates the **same**
  key it compares, unlike the guard loops which watch a guard key and write a
  different target. Callers already treat `false` as a legitimate signal:
  `run-queue.ts:259-269` documents it as "lock lease was lost to a successor",
  and `run-store.ts`'s `compensateAmbiguousPublication` re-verifies with a
  follow-up GET rather than trusting the boolean.
- reproduction — upheld (the code difference is real), but a real code
  difference with intended semantics and no consequence is not a defect.

**Not fixed.** Collapsing these two loops would be an actual regression.

## Advisory dispositions

**Final: 23 accepted, 2 deferred, 3 dismissed.** (Planned as 24/2/2; one
acceptance was withdrawn during implementation when the code refuted it —
recorded below.)

Disposition rule used, and why: this round produced two criticals (C1, C2) that
were both *"two near-identical paths that silently diverged"*. That is direct
evidence from this very review that duplicated **guard / error / fail-closed**
shapes are a correctness risk even at only two sites. So: accept a dedup when
the shape is a guard or error path (any site count), or when there are ≥3 sites
of any shape, or when it deletes dead or misleading code. Dismiss purely
cosmetic two-site tails with no correctness coupling. Defer work that changes a
seam (deepen scope) or that sprays mechanical churn across files this
remediation otherwise does not touch.

### Accepted (23)

| ID | Location | Fix |
| --- | --- | --- |
| `pr-test-analyzer-1` | `metered-llm.ts:309` | Test `snapshotPricingModel`'s malformed-input throws AND the `meterMintedLlm` catch that converts them to a typed `validation` FrameworkError — the fail-closed path for a broker-delivered LLM capability. |
| `pr-test-analyzer-2` | `__tests__/redis-connectivity.test.ts:877` | The `commitCheckpointAndRetainSpend`-vs-`appendSpend` serialization regression only runs with a live Redis (`describe.skipIf`). `serializeTransaction` is pure promise-chaining; add a fake-client ordering test that runs unconditionally. |
| `comment-analyzer-1` | `config.ts:1011` | The "MUST mirror … (int + positive)" comment is false: only `maxConcurrent` is `.int()` in `DagRegistrationSchema.config`; `timeoutMs`/`cacheTtlMs`/`checkpointTtlMs` are `.positive()` only. Correct the comment to state the invariant that actually holds (comment-only; tightening the other schema would reject previously-valid registrations). |
| `code-simplifier-4` | `run-dag-stateful.ts:449` | 6 sites of "close span, emit run-end error, return err" → one `failClosed` helper. Error path. |
| `code-simplifier-5` | `validate-dag.ts:361` | **3 of the 4 cited sites.** The bucketing sites (400, 464, 494) now share one `bucketEdgesBy`. Site 358 is left alone: it COUNTS incoming edges rather than bucketing them, and it counts every edge (including `$input` and edges to unknown nodes) where the bucket form skips them — converting it would change behaviour, not just shape. |
| `code-simplifier-6` | `run-node.ts:374` | Extract the ~120-line inline minting block from `runNodeShared` into a private helper. Altitude, within-interface. |
| `code-simplifier-7` | `runner.ts:138` | 2 sites of identical `onTrace` try/catch → one `emitTrace`. Guard path. |
| `code-simplifier-8` | `spend-store.ts:93` | 2 sites of runId-parse-and-wrap → one helper. Error path. |
| `code-simplifier-9` | `define-dag.ts:58` | 2 sites of validate-then-throw-or-unwrap → one helper. Throw path. |
| `code-simplifier-10` | `capability-handle.ts:66` | Share the one conditional-type predicate with `capability-broker.ts:48`. |
| `code-simplifier-11` | `budget-capability.ts:88` | 6 sites of `Object.freeze({ ...x })` → one `frozenCopy`. |
| `code-simplifier-12` | `spend-ledger-redis.ts:153` | `add`'s catch hand-rolls the object `internalInvariantViolated` already builds for `read`'s catch. Reuse it. |
| `code-simplifier-13` | `run-executor.ts:229` | 7 sites of `{ runId, dagId }` log attribution → one constant. |
| `code-simplifier-14` | `node-context-factory.ts:141` | 2 identical `report` logging closures → one. |
| `code-simplifier-15` | `keycloak-broker.ts:428` | 2 sites of now-then-store-token → one `storeToken`. |
| `code-simplifier-16` | `keycloak-broker.ts:409` | 2 sites of the same via-from-origin-kind ternary → one helper. |
| `code-simplifier-17` | `run-dag.ts:132` | Status / Retry-After literals hand-copied at 5 sites. Folded into the C2 fix so both land coherently. |
| `code-simplifier-18` | `host.ts:1129` | 4 inline try/catch-and-record blocks → the `attempt` helper `performShutdown` already extracts. Error path. |
| `code-simplifier-19` | `host-error.ts:179` | `snapshotUnknown`'s per-key `Object.defineProperty` is redundant: the object has a null prototype (no setter can intercept assignment) and the trailing `Object.freeze` already establishes non-writable/non-configurable. Plain assignment is equivalent. |
| `code-simplifier-20` | `config.ts:430` | 2 identical boolean-env-flag zod schemas → one `booleanEnvFlag`. |
| `code-simplifier-22` | `node-side-effects-propagation.test.ts:162` | Delete a commented-out code block that can never run. Dead code. |
| `code-simplifier-23` | `pass-3-remediation.test.ts:664` | Delete an orphaned "Wave 2.4" section header with no code under it. Dead comment. |
| `code-simplifier-26` | `hitl-reconciliation-lifecycle.test.ts:61` | The same failing-`sMembers` fixture verbatim in two tests → one named helper. |
| `code-simplifier-25` | `dag-isolation.test.ts:86` | **Partial.** `createMockSharedInfra` was byte-equivalent to the shared `fakeInfra` and is now deleted in favour of it (2 call sites). `createMockRedis` is KEPT: it returns its backing `store` for assertions and implements a `keys()` the shared fake does not, so it is not the duplicate the finding described. |
| `code-simplifier-27` | `runtime-capabilities.test.ts:10` | Hand-rolled 9-method no-op `RedisPort` stub → `fakeRedis().redis` from the shared fixtures. |

### Deferred (2)

| ID | Reason |
| --- | --- |
| `type-design-analyzer-1` (`run-context.ts:111`) | The claim is sound — `origin: InvocationOrigin \| undefined`'s legality rule lives only in a comment. But encoding it needs an ADT that pairs `origin` with the minting authority, which is an **interface change** (deepen scope, explicitly out of distill's remit), rippling through `node-context-factory`, `run-dag.ts`, the hitl `run-executor`, host wiring and their tests. Landing a seam change inside a remediation whose surviving criticals are unrelated would make the diff unreviewable. Warrants its own `deepen` session. |
| `code-simplifier-21` (`llm-fake-client.test.ts:37` + 13 more) | Mechanical churn across 14+ test files this remediation otherwise never touches. Round 10 dismissed the same class of swap after finding the shared factory returns a *different type* with *different fixture ids* that sibling assertions depend on — the same trap applies at 14× the surface. Wants its own dedicated pass with per-file verification. |

### Dismissed (3)

| ID | Reason |
| --- | --- |
| `code-simplifier-24` (`full-lifecycle.test.ts:117`) | **Refuted by the code.** The three "duplicated" fixtures are not duplicates — each carries a capability the shared fixture lacks, so swapping would lose behaviour: `createTestLogger` records a `data` field per entry (shared `testLogger` records only `level`/`msg`); `createFakeSharedInfra` takes a `capabilities` argument, passed at three call sites (lines 681, 713, 743), where `fakeInfra` hardcodes `[]`; `createFakeRedis` accepts `{ failPing }`, which the shared `fakeRedis` cannot express. Left as-is. |

## Validation commands

```bash
bun run typecheck   # all 12 packages, must exit 0
bun run test        # all 12 packages, must exit 0
```

Green baseline at `2ffbd3f`: typecheck 12/12 clean; tests 12/12 clean
(framework 3374, host 2514 + 10).

## Self-inflicted bug caught during implementation

Extracting `failClosed` in `run-dag-stateful.ts`, I inserted the helper first and
then ran the call-site replacements — so one replacement pattern matched the
helper's own freshly-written body and rewrote it into `return failClosed(...)`,
an infinite recursion. It **type-checked cleanly** (infinite recursion is
type-correct) and surfaced only as a hung test run. Fixed by restoring the body,
routing the one call site the bad replacement had consumed, and thereafter
inserting extracted helpers only AFTER performing the replacements. Recorded
here because "typecheck passed" was not evidence of correctness.

## Distill pass (apply mode, post-implementation)

Run on the green baseline, one move at a time:

1. **Restore altitude** — `hostErrorResponse` had been inserted between
   `createRunDagHandler`'s doc comment and its declaration, orphaning that doc
   onto the wrong symbol. Moved above the doc block.
2. **Delete a type assertion** — the new `attempt` helper in
   `teardownAfterServerStop` called `deps.onShutdown!()`, since a closure does
   not keep the narrowing of a property access. Captured the narrowed value to a
   const instead; no assertion, per `typescript-patterns.md`.

**Skipped deliberately:** the `snapshotMintingAuthority` error-literal
duplication noted in round 10 remains — same reasoning, and this round did not
add to it.

## Validation evidence

Final run, after implementation and the distill pass:

```
bun run typecheck   → 12/12 packages, no errors
bun run test        → 12/12 packages "Exited with code 0", 0 fail everywhere
```

| Package | Baseline (`2ffbd3f`) | Final |
| --- | --- | --- |
| `@fuguejs/framework` | 3374 pass | **3375 pass** (+1) |
| `@fuguejs/host` | 2514 + 10 pass | **2526 + 10 pass** (+12) |
| the other 10 packages | unchanged | unchanged, 0 fail |

+13 tests, 0 failures, no assertion weakened. Four existing assertions in
`run-dag.test.ts` were UPDATED (not weakened) from `dag-disabled` to
`circuit-open`: they encoded the defect C2 fixed.

**Mutation checks.** Each of the three new fail-closed regressions was verified
to actually fail against the un-fixed source, then the source restored:

| Test | Mutation | Result |
| --- | --- | --- |
| "keeps the typed missing-nodeDef failure authoritative under hostile diagnostics" | drop the `bestEffort`/`bestEffortLog` fences (C1's pre-fix state) | 9 pass / **1 fail** |
| "holds a checkpoint commit behind an in-flight spend append" | drop `serializeTransaction` from `commitCheckpointAndRetainSpend` | 34 pass / **1 fail** |
| C2's Retry-After derivation | covered directly: the test asserts `90` for a DAG configuring `resetTimeoutMs: 90_000`, which the old hardcoded `"30"` could not produce | n/a |
