# PR #45 remediation — round 3

**Branch:** `feat/f1-runtime-width-fanout`
**Review HEAD (frozen):** `b26060b`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-07T02-00-00Z-standalone-review-r18`
**Canonical result:** that run's `result.json` (digest `3c483fee346c480e6ea75a1d382e4d6ad1f610ff14fd371dc9c65ceb69c7d774`)

## Frozen review scope

```
.claude/plans/2026-09-06-pr45-remediation-round2.md
.claude/plans/2026-09-06-pr45-remediation.md
docs/adr/0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md
docs/adr/0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md
docs/adr/README.md
docs/plans/2026-09-06-f1-runtime-width-fanout.md
packages/framework/src/__tests__/_checkpointer-suite.ts
packages/framework/src/__tests__/boundary-imports.test.ts
packages/framework/src/__tests__/composite-node-key.test.ts
packages/framework/src/__tests__/redis-checkpointer-composite-opts.test.ts
packages/framework/src/__tests__/redis-checkpointer.test.ts
packages/framework/src/checkpoint/checkpointer.ts
packages/framework/src/checkpoint/composite-node-key.ts
packages/framework/src/checkpoint/redis-checkpointer.ts
```

## Adjudication summary

| | Count |
|---|---|
| Criticals found | 2 (one defect, extracted twice: `comment-analyzer-1` + `comment-analyzer-3`) |
| Refuted by the panel | 0 |
| Surviving criticals | 2 (= 1 distinct defect) |
| Advisories | 9 (= 4 distinct issues; each raised once in the findings block and once in the Machine Summary line) |

Six of the seven reviewers returned zero criticals. The panel ran three lenses
(`reproduction`, `intent`, `blast-radius`) against the one critical and **upheld
it on all three** — no refutations to audit.

## Surviving criticals — mandatory

### C1 — `docs/plans/2026-09-06-f1-runtime-width-fanout.md:157` cites a stale line

*(`comment-analyzer-1` and `comment-analyzer-3` are the same defect.)*

D3 reads ``​`redis-checkpointer.ts:250` gains the `opts?: SaveNodeOpts` parameter``.
At `b26060b`, `packages/framework/src/checkpoint/redis-checkpointer.ts:250` is a
blank line inside `load()`'s corrupt-entry handling; `async saveNode(` is at 261
and `opts?: SaveNodeOpts,` at 264. The citation was accurate against the
pre-PR-A code; round 2's fix reworded the paragraph to shipped tense without
re-checking the number, which had moved when `encodeStoredNodeKey` landed.

Unlike §2 — which carries an explicit "Read on `3845ad9`" frozen-snapshot
qualifier — D3 is framed as present-tense fact, so PR-B's implementer following
it lands in the wrong method.

**Verified independently:** yes — line 250 is blank, 261/264 as stated.

**Fix.** Re-point the citation at `redis-checkpointer.ts:261` (the `async
saveNode(` declaration), matching the convention every other citation in this
document already uses: point at the named construct's declaration line, not at
a line inside its body.

**Completing the defect class.** The reviewer found one stale citation; a fix
that closes only that one invites a round 4. Every `*.ts:<line>` citation in
this plan document was therefore re-verified against the working tree:

| Citation | Line at HEAD | Verdict |
|---|---|---|
| `types/dag.ts:154` | `readonly nodes: Nodes & ConsistentNodes<Nodes>;` | accurate |
| `types/dag.ts:184` | `export const DAG_SHAPES = [...]` | accurate |
| `dag-runtime/types.ts:249` | `DagTopology` doc line | accurate |
| `dag-runtime/types.ts:314` | `readonly outputs: ReadonlyMap<NodeId, unknown>;` | accurate |
| `dag-runtime/types.ts:292` | `readonly activeNodeIds: ReadonlySet<NodeId>;` | accurate |
| `dag-runtime/types.ts:56` | `export interface HumanGatePayload {` | accurate |
| `file/checkpointer.ts:392` | `async saveNode(` | accurate |
| `node-context-factory.ts:254` | `export const createNamespacedCheckpointWriter = (` | accurate |
| `cache-keys.ts:73` | `export const buildCheckpointKey = (` | accurate |
| `cli/authored.ts:323` | `when: z.object({ field: ..., equals: ... })` | accurate |
| `types/node.ts:467` | `readonly humanReview?: NodeHumanReviewConfig;` | accurate |
| `redis-checkpointer.ts:250` | blank line inside `load()` | **STALE — C1** |

C1 is the only one. No other citation needs touching.

## Advisory dispositions

### Accepted

**A1 — `pr-test-analyzer-1`** · `packages/framework/src/checkpoint/redis-checkpointer.ts:159`
Four `catch` blocks convert a raw ioredis rejection into a typed `cache-error`
— `load:get-meta` (`redis.get`, tagged at :161), `load:hgetall-nodes`
(`redis.hgetall`, :207), `saveNode` (the non-NOSCRIPT re-throw branch, :336),
and `setMeta` (`redis.set`, :357) — and no test makes the underlying driver
call throw.
Verified: `grep -rn "load:get-meta\|load:hgetall-nodes"` over `__tests__/`
returns nothing. Every *other* hostile seam in this adapter (clock, load-opts
getter, JSON serialization, throwing logger) is pinned; a dropped connection —
the likeliest real Redis failure — is not. ADR-0080's "never a raw rejection"
invariant would survive a refactor that let one of these escape, or a typo'd
`operation` tag, with a green suite.

*Accepted* — the claim is sound, the fix is in-scope (`redis-checkpointer.test.ts`
is a reviewed file that already hosts two stub-driven Redis describe blocks),
and the pattern is the one already used there.

**Fix.** Add a `RedisCheckpointer — driver-failure totality` describe block to
`packages/framework/src/__tests__/redis-checkpointer.test.ts`, alongside the
existing `hostile-value totality` and `required corruption observability`
blocks. Each test hands the adapter a plain object-literal stub whose one
relevant method rejects, then asserts the settled value is `err` with
`kind: "cache-error"` and the exact `operation` tag. The stubs are plain
literals — no mocking framework — matching `typescript-patterns.md`'s port-fake
rule. The `saveNode` case must reject from `evalsha` with a **non-**NOSCRIPT
error, so it also pins that the NOSCRIPT string-match does not swallow an
unrelated driver fault.

**A2 — `comment-analyzer-2` / `comment-analyzer-4`** ·
`packages/framework/src/__tests__/_checkpointer-suite.ts:133`
The banner says "These four are the durable precondition for F1's runtime-width
fan-out" and five tests follow (`composite opts store…`, `canonical folding…`,
`distinct indices…`, `a canonical save and an indexed save…coexist`, `a
malformed composite address fails typed…`). Verified by counting `test(` between
the banner and the next section.

*Accepted* — same doc-accuracy defect class as C1, in scope, trivially fixable.

**Fix.** Rewrite the banner. Bumping "four" to "five" would leave it still
wrong in substance: the stated consequence ("indices collide and a partial fan
silently restarts") describes only the first four, which pin *address
distinctness*. The fifth pins the *fail-closed* half — a malformed address must
issue no write rather than fall back to the canonical key. The new banner names
both halves.

### Deferred

**D1 — `type-design-analyzer-1` / `-4`** · `checkpointer.ts:418` — `RunState.nodes`
keys are unbranded `string`, so "this key is an address, not an identity" is
enforced by comment only.

*Deferred to F1 PR-B.* This is round 1's `type-design-analyzer-1` verbatim,
already adjudicated as a deferral with recorded rationale, and the code is
unchanged since. A `StoredNodeKey` brand changes the key domain of a type read
by every checkpoint consumer across `framework` and `host` — far outside this
PR's frozen scope — and PR-B is the change that introduces the fan-out reader
the brand exists to protect. Deferring keeps the brand and its first real
consumer in one reviewable change. Compensating controls today: the explicit
decode contract at `checkpointer.ts:402-417` and the `_checkpointer-suite.ts`
cases that pin decode discipline on every backend.

**D2 — `type-design-analyzer-2` / `-5`** · `composite-node-key.ts:203` —
`compositeNodeKey` throws rather than returning `Result`.

*Deferred to F1 PR-B.* Round 1's `type-design-analyzer-2`, also already
adjudicated as a deferral. The reviewer states plainly that there is no live
defect: every in-tree caller either routes through `encodeStoredNodeKey` (Redis,
in-memory) or catches directly (file backend). The current shape is also the
one `architecture.md` sanctions — "Constructor invariants → may throw (guards
type's validity)" in the functional core, converted to `Either`/`Result` at the
boundary — so this is a hardening against a *future* direct caller, not a rule
violation. It belongs with D1: both are "deepen the composite-address boundary",
and splitting them across PRs would touch the same call sites twice.

### Dismissed

**X1 — `type-design-analyzer-3` / `-6`** · `checkpointer.ts:376` —
`RunMeta.dagFingerprint` / `CheckpointerLoadOpts.expectedDagFingerprint` are
unbranded strings, so a `NodeId`/`DagId` would type-check there.

*Dismissed.* The advisory names a type-level possibility with no reachable path
behind it. Grepped every `dagFingerprint` site in `packages/`: every value
originates from the single producer `dagFingerprint(dag)` (`fingerprint.ts:40`,
a sha256 hex string), is only ever compared against another fingerprint
(`checkpointer.ts:84`, `persistence.ts:435-478`), and the persisted path already
gates the *format* (`persistence.ts:349` rejects anything that is not a
lowercase sha256 hex string) — which a brand would not do. No call site accepts
a `NodeId` or `DagId` in that position, and the fields are pre-existing and
untouched by this PR. Adding a brand here buys nothing this PR can point at.

## Validation

```bash
bunx tsc --noEmit
REDIS_URL=redis://localhost:6379 bun run test
```

Expected: typecheck clean; suite green with 4 new tests
(3544 → 3548 pass, 0 fail).

## Files changed

| File | Finding | In frozen scope |
|---|---|---|
| `docs/plans/2026-09-06-f1-runtime-width-fanout.md` | C1 | yes |
| `packages/framework/src/__tests__/redis-checkpointer.test.ts` | A1 | yes |
| `packages/framework/src/__tests__/_checkpointer-suite.ts` | A2 | yes |
| `.claude/plans/2026-09-06-pr45-remediation-round3.md` | this plan | no — `supportPaths` |
