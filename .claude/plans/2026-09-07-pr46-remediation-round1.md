# PR-46 remediation — round 1 (F1 PR-B, the map node)

**Branch:** `feat/f1-map-node`
**Reviewed HEAD:** `c8c9255`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-09-07T23-30-00Z-standalone-review-r23`
**Result authority:** that run's `result.json`
**Panel:** 6 criticals through the registered Refutation Panel — 3 lenses
(`reproduction`, `intent`, `security`). 0 refuted.

Support paths (remediation-owned, outside the frozen scope):

- `.claude/plans/2026-09-07-pr46-remediation-round1.md` (this plan)

## Counts

| | count |
|---|---|
| Reviewers | 7 (no retries) |
| Critical found | 6 (2 pairs are the same claim emitted twice) |
| Refuted | 0 |
| **Surviving critical (mandatory)** | **6** |
| Advisory | 12 (5 are duplicate emissions) |

This is the first round on this PR and it found real defects, including one I
introduced that defeats the feature's central safety property. Both of the
severe ones were **reproduced locally before planning any fix**, not taken on
the reviewer's word.

---

## Surviving criticals — mandatory

### C1 — `type-design-analyzer-1`: the `maxWidth` bound can be bypassed

**File:** `packages/framework/src/types/map-width.ts` (`resolveMappedItems`)

`resolveMappedItems` reads `field.length` once into `width`, checks
`width > max`, then builds the result with `[...field]`. The array iterator
re-reads `length` (`LengthOfArrayLike`) on **every** step, so a value whose
`length` grows after the check produces a `MappedItems` whose `items.length`
exceeds the bound that was just enforced. `Array.isArray` unwraps proxies, so a
`Proxy` around a real array passes the type guard.

**Reproduced locally against `c8c9255`:**

```
Array.isArray(proxy) = true
ok, width = 3   but items.length = 50   max = 3
```

This is not a documentation mismatch. `map.ts` fans over `items.entries()`, so
a declared `maxWidth: 3` would run 50 children. That is exactly the guarantee
D2/FR-F1-003 exists to provide — "worst-case spend statically knowable before
the run starts" — and it is the one property the whole feature is justified by.

**Fix:** snapshot the width once, then copy by bounded index rather than by
spread, so the returned length is the checked length by construction and cannot
depend on how many times a hostile `length` is consulted.

### C2 — `type-design-analyzer-2`: a per-index throwing getter escapes as a raw throw

**File:** same function, same line.

The `[...field]` spread is not wrapped, unlike the field read three lines above
it. A throwing getter on any index escapes `resolveMappedItems`, whose contract
is `Result<MappedItems, FrameworkError>`, and then escapes `map.ts`'s `run`,
whose contract is `Promise<Result<O, FrameworkError>>`.

**Reproduced locally:** `CLAIM 2 REPRODUCED: raw throw escaped -> index getter exploded`.

The module's own header promises the opposite in as many words: "every access
below is written to survive a hostile value ... with a typed refusal rather
than a raw throw". The guard was applied to the access the author was thinking
about and not to the one below it — the same "fixed the instance, not the class"
shape the previous two rounds on PR #45 kept surfacing.

**Fix:** the bounded copy from C1 goes inside the same `try`/`catch` the field
read already uses, so every access in the function converts rather than throws.

### C3 — `comment-analyzer-1`: the map node declares `reads` while it writes

**File:** `packages/framework/src/nodes/map.ts`

`sideEffects: { kind: "reads", … }`, justified by a comment that itself says the
node "writes checkpoints". `types/node.ts` defines `"reads"` as "reads external
state ... **without mutation**" and `"writes"` as "mutates external state". The
node calls `saveNode` and `setMeta`; both mutate durable state.

The panel established this is not cosmetic. `side-effects.ts`'s discriminated
union only admits `idempotencyKey` and the write-freshness extractors on the
`writes`/`external-call` arms, and `node-span.ts` gates its idempotency-key
handling on those kinds — so the mislabel structurally excludes a
state-mutating node from idempotency handling and misreports it to every
consumer of the profile (freshness contracts, operator dashboards, routing
safety analysis).

**Fix:** `kind: "writes"`, and correct the comment that argued for `reads`.

### C4 — `comment-analyzer-2`: the variant count is stale — and so is the enum behind it

**File:** `packages/framework/src/types/errors.ts`

The reported defect is a comment claiming "all 27 variants" where the union now
has 29 (28 inline `kind:` literals in `errors.ts` plus `checkpoint-write-failed`
from `checkpoint-address.ts`). Verified by direct count.

**The intent lens found the real problem underneath it.** The sibling
`persistedFrameworkErrorKinds` enum still lists exactly those 27 names and was
never extended when this PR added two kinds. That enum is not decoration:

```
validation         -> true
map-width-invalid  -> false
map-width-exceeded -> false
```

`isFrameworkErrorKind` is a public runtime guard built on it, and
`retry-exhausted`'s `rootErrorKind` is `persistedFrameworkErrorKinds.exclude([…])`.
So both kinds this PR introduced are unrecognised by the framework's own
kind guard — a functional defect, not a stale number. The discriminated-union
schema *was* extended (I did that), which is precisely why nothing failed: the
two lists are maintained by hand and only one of them was updated.

**Fix:** add both kinds to the enum, correct the count, and — because a
hand-maintained duplicate list is what failed here — add a test that asserts the
enum and the union agree, so the next kind cannot be added to only one.

### C5 / C6 — `pr-test-analyzer-1` and `-6`: the host's indexed write is untested

**File:** `packages/host/src/adapters/node-context-factory.ts`

Two emissions of one claim. `createNamespacedCheckpointWriter.write` threads
`index` into `buildCheckpointKey`, but no test calls `write` with an index, so
nothing proves the adapter forwards it. The pure key builder is exhaustively
tested; the adapter body that holds the parameter is not. Dropping the fourth
argument at the call site inside `write` passes every existing test.

The `reproduction` lens rated these `uncertain` rather than `upheld`, correctly:
nothing calls `write` with an index today, so the gap is latent. It is still
mandatory — the plan's own risk table names this exact class ("the index
dimension is dropped somewhere along the production path and nobody notices ...
this already happened once"), and a latent path with no test is how it happens
again.

**Fix:** a test that calls `write` with an index and asserts the Redis key
carries `$<index>`, plus its canonical-key twin.

---

## Advisory dispositions

| ID | Agent | Disposition | Reason |
|---|---|---|---|
| `silent-failure-hunter-1` | silent-failure-hunter | **accepted** | The same defect as C1/C2 reached through the silent-failure lens. Closed by that fix; recorded so the ledger is complete. |
| `pr-test-analyzer-2` / `-7` | pr-test-analyzer | **accepted** | `errors.test.ts` keeps per-kind tables whose stated purpose is that a new kind forces a new row, and this PR's two kinds have none — so their deliberate `non-retriable` classification is unpinned. Closing this is what turns C4's "two hand-maintained lists" lesson into a test. |
| `pr-test-analyzer-3` / `-8` | pr-test-analyzer | **accepted** | §12 documents the fail-closed capability gate as the reason a map node without a `Checkpointer` is safe. Nothing asserts it. Cheap to pin and it is a load-bearing claim about production behavior. |
| `pr-test-analyzer-4` / `-9` | pr-test-analyzer | **accepted** | The meta-seeding guard's "an outer run that already established the record keeps its own" is only exercised incidentally. A direct assertion costs three lines. |
| `pr-test-analyzer-5` / `-10` | pr-test-analyzer | **accepted** | `asMapIndex`/`mapIndex` have no rejection table while their two sibling brands in the same feature do. The doc comment claims a severe failure mode ("an index that silently re-executes forever"); an untested guard is not evidence for it. |
| `comment-analyzer-3` | comment-analyzer | **accepted** | `MappedItems.width`'s doc claims the fan driver reads `width` rather than re-deriving it, and `map.ts` never reads it. Closed by making the claim true (the fan uses `width`) rather than by softening it, since C1's fix makes the snapshotted width the load-bearing number. |
| `code-simplifier-1` | code-simplifier | **accepted** | Two tests re-type the whole `fanNode` literal to vary one field. Widening the existing override is the pattern the file already establishes. |
| `architecture-tech-lead-1` | architecture-tech-lead | **deferred** | The claim is that `CheckpointWriter.write`'s index has no live consumer, which is true and is already recorded in plan §12 as a known, tracked gap. The reviewer explicitly says "not a call to revert" and asks for an end-to-end test when the read side lands. C5/C6 closes the testable half now; the rest is the follow-up PR that adds the reader. Re-deferred, not re-litigated. |

No advisory is dismissed.

---

## Fix list

1. **C1/C2** — `map-width.ts`: snapshot `width`, copy by bounded index inside a
   `try`/`catch`, so the returned length is the checked length by construction
   and no access can throw past the `Result`.
2. **C1/C2 tests** — a growing-`length` Proxy and a per-index throwing getter,
   both asserting a typed refusal; plus a property that `items.length <= max`
   holds for every success.
3. **C3** — `map.ts`: `sideEffects.kind` becomes `"writes"`; the comment that
   argued for `reads` is corrected to say why.
4. **C4** — `errors.ts`: add both kinds to `persistedFrameworkErrorKinds`, fix
   the count, and add a test asserting the enum matches the union so the two
   lists cannot drift again.
5. **C5/C6** — `node-context-factory.test.ts`: `write` with and without an
   index, asserting the key the adapter actually hands Redis.
6. **Advisories** — the six accepted items above.

## Validation commands

```bash
for p in framework host examples adapter-fs adapter-pg adapter-oracle \
         adapter-ms-graph document-source http-auth xlsx; do
  (cd packages/$p && bunx tsc --noEmit && bun test)
done
```

Run per workspace, the way CI does — a root-level `-p` invocation resolves a
different file set and is what let 14 type errors reach CI on this branch.
