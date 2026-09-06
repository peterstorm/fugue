# PR #45 remediation — round 5

**Branch:** `feat/f1-runtime-width-fanout`
**Review HEAD (frozen):** `f012b4b`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-07T10-00-00Z-standalone-review-r20`
**Canonical result:** that run's `result.json` (digest `167e5716601ad1033b3bfee2029630b14c86d2ae30c293dabc56dd32c950d8bd`)

## Adjudication summary

| | Count |
|---|---|
| Criticals found | 1 |
| Refuted by the panel | 0 |
| Surviving criticals | 1 |
| Advisories | 2 |
| Accepted | 2 · Deferred 0 · Dismissed 0 |

Six of seven reviewers returned zero criticals. The one critical was upheld on
all three lenses (`reproduction`, `intent`, `blast-radius`).

## Surviving critical — mandatory

### C1 — the same citation rotted for the third time

`docs/plans/2026-09-06-f1-runtime-width-fanout.md:157` cites
`` `redis-checkpointer.ts:261` `` for `saveNode`'s `opts?: SaveNodeOpts`
parameter. At `f012b4b`, line 261 is a comment inside `load()`'s `__proto__`
handling; `async saveNode(` is at **296**.

**Verified independently:** confirmed — 261 is `// LEGAL nodeId and therefore a
legal canonical key — plain bracket`, and 296 is `async saveNode(`.

**Round 4 caused this.** Adding `RedisCheckpointerDriver` and
`SaveNodeScriptInvocation` (~35 lines) above the class pushed `saveNode` down
35 lines. Round 3 had just repointed this same citation `250 → 261`, and its
plan wrote: *"a fix that closes only that one invites a round 4."* It did. This
is the third recurrence of one defect class (round 1: `checkpointer.ts:505`;
round 3: `redis-checkpointer.ts:250`; now `:261`).

**Fix — end the class, not the instance.** Repointing `261 → 296` resets the
same trap: the next edit anywhere above `saveNode` in that file rots it again,
and this document's whole purpose is to be read *later*, by PR-B's implementer,
against code that will have moved.

So: **drop the line numbers from every code citation in this document** and cite
the symbol instead. A symbol reference survives any edit that does not rename
the symbol — and if it *is* renamed, a reader greps and finds it, which a stale
integer can never do.

This costs nothing. Every citation in the file except two already names its
symbol immediately beside the line number, so the number was redundant:

| Line | Citation | Action |
|---|---|---|
| 20 | `DagDefInput.nodes` (`types/dag.ts:154`) | drop `:154` |
| 21 | `DAG_SHAPES` (`types/dag.ts:184`) | drop `:184` |
| 44 | `DagTopology.waves` … `dag-runtime/types.ts:249` | drop `:249` |
| 46 | `DagMachineContextPersisted.outputs` (`dag-runtime/types.ts:314`) | drop `:314` |
| 48 | `activeNodeIds` (`dag-runtime/types.ts:292`) | drop `:292` |
| 71 | `file/checkpointer.ts:392` takes and applies `opts` | **name `saveNode`**, drop `:392` |
| 77 | `createNamespacedCheckpointWriter` (`…node-context-factory.ts:254`) | drop `:254` |
| 78 | `buildCheckpointKey` (`…cache-keys.ts:73`) | drop `:73` |
| 105 | `{ field, equals }` (`cli/authored.ts:323`) | drop `:323` |
| 124 | `dag-runtime/types.ts:249` | drop `:249` |
| 157 | `redis-checkpointer.ts:261` | **name `saveNode`**, drop `:261` — **C1** |
| 164 | `buildCheckpointKey` (`…cache-keys.ts:73`) | drop `:73` |
| 166 | `createNamespacedCheckpointWriter` (`…node-context-factory.ts:254`) | drop `:254` |
| 195 | `when: { field, equals }` at `:323` | replace the bare `:323` with the schema's name |
| 195 | `DAG_SHAPES` (`types/dag.ts:184`) | drop `:184` |
| 201 | `humanReview` (`types/node.ts:467`) | drop `:467` |
| 206 | `HumanGatePayload` (`dag-runtime/types.ts:56`) | drop `:56` |
| 285 | `createNamespacedCheckpointWriter` (`…node-context-factory.ts:254`) | drop `:254` |

Every one of those line numbers was verified accurate in round 3 and is still
accurate today *except* `:261` — which is the point: they are accurate right up
until an unrelated edit moves them, silently, with nothing failing.

A short convention note goes in the document so a future editor does not
reintroduce them.

**Deliberately not changed:** the `.claude/plans/*-remediation*.md` files also
carry `file:line` citations, but each states a frozen review HEAD in its header,
so those are snapshots of a specific commit — legitimately fixed in time, and
the distinction round 3's review itself drew about §2 of the F1 plan. The F1
plan's D3 has no such qualifier and is written in present tense.

## Advisory dispositions — both accepted

### A1 — `code-simplifier-1` · `redis-checkpointer.test.ts:31` and `:814`

`setStaleVersion` is byte-identical in the in-memory suite's raw object and the
Redis suite's. **Verified:** both bodies call the public `cp.setMeta` with
`frameworkVersion: "1"`.

Every *other* bypass in these objects is genuinely backend-specific — one writes
the in-memory test store, the other issues a raw `redis.set`/`hset` — because
the suite exists to let each backend reach durable state its own way.
`setStaleVersion` is the exception: it needs no bypass at all.

*Accepted.* The duplication reads as coincidence and hides the asymmetry.

**Fix.** Extract one `setStaleVersionViaSetMeta` helper used by both, with a
comment naming why this one is shared and the others cannot be.

### A2 — `code-simplifier-2` · `redis-checkpointer.ts:79`

`serializeNode` extracts `state.nodeId`, `state.output`, `state.completedAt`
into three sequential `const`s where one destructure says the same thing.

**Verified no hidden reason:** the three-const form carries no comment
justifying it, and both forms read the same three properties exactly once in
the same left-to-right order — so a hostile getter sees an identical sequence.
Behaviour is unchanged.

*Accepted* — plain noise removal.

**Fix.** `const { nodeId, output, completedAt } = state;`

## Validation

```bash
bunx tsc --noEmit
REDIS_URL=redis://localhost:6379 bun run test
```

Expected: typecheck clean; framework 3549 pass, 0 fail — unchanged, since this
round adds no tests and changes no behaviour.

## Distill pass (apply mode, post-implementation)

Both accepted advisories *were* distill moves, applied as planned. One further
move on top, on a green baseline and re-validated after: `setStaleVersionViaSetMeta`
initially restated the hook's parameter list, which is the same copy-that-can-drift
problem in miniature. Typed it `CheckpointerSuiteRaw["setStaleVersion"]` instead,
so the signature is derived from the suite contract and follows it automatically.

Skipped: nothing else. The document edits are prose, and the reviewer's own
"out of scope" list (`boundary-imports.test.ts`'s per-test provenance comments,
the deliberately-retained `readClock` wrappers) is correctly reasoned — collapsing
either would cost more than it saves.

## Files changed

| File | Finding | In frozen scope |
|---|---|---|
| `docs/plans/2026-09-06-f1-runtime-width-fanout.md` | C1 | yes |
| `packages/framework/src/__tests__/redis-checkpointer.test.ts` | A1 | yes |
| `packages/framework/src/checkpoint/redis-checkpointer.ts` | A2 | yes |
| `.claude/plans/2026-09-06-pr45-remediation-round5.md` | this plan | no — `supportPaths` |
