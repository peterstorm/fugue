# PR #45 remediation — round 4

**Branch:** `feat/f1-runtime-width-fanout`
**Review HEAD (frozen):** `209c0a8`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-07T06-00-00Z-standalone-review-r19`
**Canonical result:** that run's `result.json` (digest `2bce30dc2b30e50b00ee89c83217925a54e9d33876627c0f918aa7febdc192d1`)

## Adjudication summary

| | Count |
|---|---|
| Criticals found | 1 |
| Refuted by the panel | 0 |
| Surviving criticals | 1 |
| Advisories | 4 (all distinct) |
| Accepted | 4 · Deferred 0 · Dismissed 0 |

Five of seven reviewers returned zero criticals. The one critical went through
three lenses (`reproduction`, `intent`, `test-coverage`) and was **upheld on all
three**. Notably, the critical and two advisories are defects *introduced or
widened by round 3's own remediation* — the driver-failure banner overclaims,
the suite banner misattributes, and the new test block deepened the untyped
driver-fake pattern.

## Surviving critical — mandatory

### C1 — the driver-failure banner claims a distinctness that does not hold

`packages/framework/src/__tests__/redis-checkpointer.test.ts:615-617` (written in
round 3) says the four catches "each carr[y] a DIFFERENT `operation` tag, so a
reader of a production error can tell which call failed."

**Verified independently:** false for `saveNode`. Two disjoint catch blocks emit
`operation: "saveNode"`:

- `redis-checkpointer.ts:283-289` — guards `serializeNode(state)`; fires on a
  caller-supplied cyclic `output` or invalid `completedAt`. No driver call made.
- `redis-checkpointer.ts:333-339` — guards the `evalsha`/`eval` driver calls.

The shared tag is *deliberate* — the implementation comment at :272-278 says it
preserves what the adapter returned for the same inputs before composite
addressing. So the code is right and my comment was wrong: on-call reading
`cache-error(saveNode)` cannot tell a client bug from a dropped connection.

The `test-coverage` lens added a point worth acting on: the existing
serialization tests (`redis-checkpointer.test.ts:83-111`) assert only `.kind`,
so nothing in the suite records that the two paths *share* the tag on purpose.

**Fix (both halves).**
1. Rewrite the banner to state the truth: these four pin the **driver-call**
   catches; three of the tags are unique to their call, and `saveNode`'s is
   deliberately shared with the pre-driver serialization guard, so `message` —
   not `operation` — is what separates those two.
2. Strengthen the two hostile-value serialization tests to assert
   `operation: "saveNode"` alongside the kind, turning the shared tag from an
   unrecorded coincidence into a pinned decision. A future split of the tag
   then has to change a test that says why it was shared.

## Advisory dispositions — all four accepted

### A1 — `pr-test-analyzer-1` · `redis-checkpointer.ts:302`

The lazy `this.redis.script("LOAD", SAVE_NODE_SCRIPT)` that primes `saveNodeSha`
is inside `saveNode`'s outer try but no test makes *that* call reject — every
stub supplies `script: async () => "sha-1"` and drives failure through `evalsha`.

**Verified:** confirmed at :302; no stub in either Redis test file rejects from
`script`.

*Accepted* — it is the same class round 3 accepted as A1, one statement short of
complete, and it costs one test.

**Fix.** Add a `script`-rejection case to the driver-failure block, leaving
`evalsha`/`eval` at their named-throw defaults so the test also proves neither
was reached.

### A2 — `type-design-analyzer-1` · `redis-checkpointer.ts:130`

`RedisCheckpointer`'s constructor takes the concrete `ioredis.Redis` class
(~200 methods) rather than a port naming the six methods it calls, so **every**
fake is coerced past the compiler — 13 `as never` / `as unknown as Redis` casts
across the two in-scope Redis test files. The compiler therefore never checks a
fake against how the adapter actually calls the driver, and round 3's new test
block widened the pattern rather than closing it.

This is the one advisory that names a rule violation rather than a hardening
opportunity: `typescript-patterns.md` says "Prefer a `type` alias of an object
with method signatures … fakes become object literals", and `architecture.md`
lists cache/driver seams as exactly where a narrow, consumer-owned port belongs.

*Accepted* — and verified practical before accepting, not assumed. A throwaway
probe confirmed with `tsc` that (a) a real `ioredis.Redis` is structurally
assignable to an **exact-arity** port with no cast, so the single production
call site (`apps/customer-summary/src/bootstrap.ts:264`) keeps compiling
untouched, and (b) a plain object-literal fake satisfies the same port. The
change is a widening of an accepted parameter type — no caller can break.

**Fix.**
- Declare `RedisCheckpointerDriver` in `redis-checkpointer.ts` with the exact
  arity of each call the adapter makes, and type the constructor with it. The
  `ioredis` import becomes unused and is dropped: the adapter no longer has a
  type-level dependency on the driver SDK at all. Assignability stays proven —
  by the production call site, which type-checks a real `Redis` against the port.
- Add `packages/framework/src/__tests__/_redis-driver-fake.ts`: `redisDriverFake`
  builds a full driver from a partial override, defaulting every unlisted method
  to a throw that **names the method**. This preserves round 3's
  "what a stub omits is part of its assertion" property and improves it — an
  unexpected call now fails with `RedisCheckpointer called eval, which this test
  does not expect` instead of `undefined is not a function`.
- Replace all 13 casts with `redisDriverFake({ … })`.

The one remaining `as never` in scope (`_checkpointer-suite.ts:249`) is
unrelated — it forges a malformed `SaveNodeOpts` on purpose — and stays.

### A3 — `comment-analyzer-2` · `_checkpointer-suite.ts:136`

The round-3 banner puts all four non-fail-closed tests under one consequence
("indices collide and a partial fan silently restarts"). That fits tests 1, 3
and 4, but test 2 is "canonical folding: a no-opts save is keyed by exactly the
bare nodeId" — a no-migration guarantee. Its failure mode is every existing
*non-fan-out* run's checkpoints silently moving to a new key on resume, which is
a different hazard.

**Verified:** test 2's name and body confirm it pins canonical-key stability.

*Accepted* — round 3 rewrote this banner and got it half right; leaving a
comment that mislabels why a test exists is the defect class this PR keeps
paying for.

**Fix.** Split the banner into three claims — distinctness (tests 1, 3, 4),
canonical-key stability (test 2), fail-closed (test 5) — each with its own
consequence.

### A4 — `code-simplifier-1` · `redis-checkpointer.ts:160, 206, 285, 335, 356`

Five sites hand-build `{ kind: "cache-error" as const, operation, message }`
while the file already imports `frameworkError` and uses
`frameworkError.cacheError` one line away (:244).

**Verified byte-identical:** `error-factories.ts:155-162` returns exactly
`{ kind: "cache-error", operation, message }` when `failureClass` is omitted,
matching the `cache-error` arm in `types/errors.ts`. The five sites are pinned
by tests using `toMatchObject`/`.kind`, none of which assert key order or object
identity, so the substitution cannot break a pin.

*Accepted* — a pure reuse-before-rewrite move: one constructor instead of five
copies a reader has to eyeball for agreement.

**Not touched** (the reviewer flagged and correctly declined this itself):
`checkpointer.ts`'s `evaluateCheckpointLoadGates` literals look like the same
pattern, but `frameworkError.checkpointVersionMismatch`/`checkpointExpired` route
`runId` through the *throwing* `runId()` constructor. Substituting them would
turn a forged `RunId` from a clean `Err` into a raw rejection escaping a
`Promise<Result<…>>` port method — a behavior change, and precisely the
ADR-0080 invariant this suite exists to defend.

## Validation

```bash
bunx tsc --noEmit
REDIS_URL=redis://localhost:6379 bun run test
```

Expected: typecheck clean (and it is now load-bearing — it is what proves the
fakes match the driver port); framework 3548 → 3549 pass, 0 fail.

## Distill pass (apply mode, post-implementation)

One move, applied on a green baseline and re-validated after: `RedisCheckpointerDriver`'s
`evalsha` and `eval` declared the same seven-parameter list twice, so the two
were free to drift. Extracted `SaveNodeScriptInvocation` to name the shape once
— the NOSCRIPT fallback must replay exactly what the primary path sent, which
is the reason they match, and the named type now says so.

Skipped: nothing else in the diff carries incidental complexity. The remaining
near-duplication (per-test `RunMeta` fixtures, the stored-meta JSON blob shared
with a pre-existing test in another describe block) is per-test setup clarity,
and collapsing it would trade readability for no leverage.

## Files changed

| File | Finding | In frozen scope |
|---|---|---|
| `packages/framework/src/__tests__/redis-checkpointer.test.ts` | C1, A1, A2 | yes |
| `packages/framework/src/checkpoint/redis-checkpointer.ts` | A2, A4 | yes |
| `packages/framework/src/__tests__/redis-checkpointer-composite-opts.test.ts` | A2 | yes |
| `packages/framework/src/__tests__/_checkpointer-suite.ts` | A3 | yes |
| `packages/framework/src/__tests__/_redis-driver-fake.ts` (new) | A2 | no — `supportPaths` |
| `.claude/plans/2026-09-06-pr45-remediation-round4.md` | this plan | no — `supportPaths` |
