# PR #45 Remediation — F1 PR-A composite checkpoint addressing

**Branch:** `feat/f1-runtime-width-fanout`
**Review HEAD:** `bef5650`
**Review Run:** `.claude/reviews/review-and-fix-runs/standalone-review-20260906T144241Z-pr45`
**Result authority:** that run's `result.json`

**Adjudication:** 5 critical found, **0 refuted**, 5 surviving. 12 advisory.
The Refutation Panel upheld all five through three independent lenses
(reproduction, intent, blast-radius) with no dissent.

## Frozen review scope

```
docs/adr/0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md
docs/adr/0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md
docs/adr/README.md
docs/plans/2026-09-06-f1-runtime-width-fanout.md
packages/framework/src/__tests__/_checkpointer-suite.ts
packages/framework/src/__tests__/boundary-imports.test.ts
packages/framework/src/__tests__/composite-node-key.test.ts
packages/framework/src/__tests__/redis-checkpointer-composite-opts.test.ts
packages/framework/src/checkpoint/checkpointer.ts
packages/framework/src/checkpoint/redis-checkpointer.ts
```

**Support paths** (touched by remediation, outside the frozen scope):
- `.claude/plans/2026-09-06-pr45-remediation.md` — this plan
- `packages/framework/src/checkpoint/composite-node-key.ts` — two comments this
  PR falsified (see A10)
- `packages/framework/src/__tests__/redis-checkpointer.test.ts` — home of the
  hostile-value totality block the C1 regression test belongs beside

---

## Surviving criticals — all mandatory

The five collapse into **three distinct defects**; two pairs are the same defect
seen by different reviewers.

### C1 — `RedisCheckpointer.saveNode` raw-rejects instead of returning a typed `Result`
*(code-reviewer-1 + pr-test-analyzer-1, `redis-checkpointer.ts:257`)*

**This is a regression I introduced in the distill pass (`bef5650`), not a
pre-existing defect.** Extracting `encodeStoredNodeKey` hoisted
`const { nodeId, payload } = serializeNode(state);` out of the method's `try`;
it now runs before the try entirely (verified: the call is at line 257, the
`try` opens at line 268).

`serializeNode` evaluates `completedAt.toISOString()` and `JSON.stringify(output)`.
`output` is typed `unknown`, so a cyclic object or a `new Date(NaN)` is
type-legal, and both throw synchronously. On `main` that call was the first
statement *inside* the try, so the throw settled as
`err({kind:"cache-error", operation:"saveNode"})`. It now escapes as an
unhandled rejection, breaking the declared `Promise<Result<void, FrameworkError>>`
and the port's "never a raw rejection" discipline — the very contract the
`encodeStoredNodeKey` extraction was written to strengthen.

The blast-radius lens noted `run-node.ts:597-611` catches throws from the
*host's* `checkpointWriter.write`, which mitigates one call path but does not
restore the port's contract for consumers branching on `error.kind`. Redis is
the backend wired in production.

**Fix.** Guard `serializeNode(state)` so a throw settles typed, preserving the
pre-PR error kind (`cache-error`, `operation: "saveNode"`) so nothing observable
changes for the input class that already worked. Keep the address encoding
before the driver `try` — that separation is correct and is what C1 must not
undo.

**Regression pin.** Two cases through `RedisCheckpointer.saveNode`: a cyclic
`output`, and an invalid `completedAt`. Both must return `Err`, not throw. These
belong beside the existing in-memory hostile-value totality block in
`redis-checkpointer.test.ts`, whose header comment currently asserts a Redis
carve-out that this fix removes — that comment is corrected too.

### C2 — `RunState.nodes` docstring contradicts the code and the file
*(comment-analyzer-1 + architecture-tech-lead-1, `checkpointer.ts:408-410`)*

Reads: *"in backends that implement composite addressing (the file backend). The
in-memory and Redis backends collapse composite saves onto the bare `nodeId` key
instead (FR-023: they ignore `SaveNodeOpts` entirely)."*

False as of this PR, and contradicted by the `SaveNodeOpts` docstring ~28 lines
below. `RunState.nodes` is the read-side surface F1 PR-B's fan-out consumer will
read next; a consumer trusting this would assume `nodes[nodeId]` suffices on
Redis and silently miss composite-keyed entries.

**Fix.** State that every backend honors composite addressing (ADR-0085), and
keep the load-bearing consumer instruction: enumerate stored keys through
`parseCompositeNodeKey` rather than assuming each key equals `NodeState.nodeId`.

### C3 — `Checkpointer.saveNode` interface docstring says the opposite of the port's behavior
*(comment-analyzer-2, `checkpointer.ts:535-537`)*

Reads: *"The in-memory and Redis backends ignore `opts` exactly as today
(FR-023); composite addressing is a versioned opt-in implemented by the file
backend."* This sits on the port's own contract documentation — the most
authoritative location in the file — and is false.

**Fix.** Same correction as C2, phrased for the write side.

---

## Advisory dispositions

| ID | Disposition | Reason |
|----|-------------|--------|
| pr-test-analyzer-2 — NOSCRIPT fallback untested with opts | **accepted** | A branch this PR changed (`nodeKey.value`) with no coverage. Cheap to pin with the existing recording driver. |
| pr-test-analyzer-3 — ADR-0085's in-memory-suite claim is stale | **accepted** | **Verified: the advisory is right and my ADR is wrong.** `checkpointerSuite("InMemoryCheckpointer", …)` is invoked at `redis-checkpointer.test.ts:23`. ADR-0085's "Negative" bullet asserts the opposite. A false statement in an accepted ADR must not ship. |
| comment-analyzer-3 — stale `checkpointer.ts:505` pointers | **accepted** | Five pointers in ADR-0085 and the F1 plan; `bef5650` shifted the declaration. Replace with symbol references so they cannot rot again. |
| comment-analyzer-4 — Redis load loop variable `nodeId` | **accepted** | This PR widened that key's domain to include composite addresses; the name and comment now mislead. |
| comment-analyzer-5 — ADR-0075 line 49 present tense | **accepted** | My own amendment annotated the Negative bullet but missed this paragraph, leaving the ADR self-inconsistent. |
| architecture-tech-lead-2 — `encodeStoredNodeKey` docstring overclaims | **accepted** | It says "three hand-kept copies"; the file backend did not adopt it (deliberately — see the PR body). The docstring must not claim more than the code does. Also covers `composite-node-key.ts`'s two comments this PR falsified. |
| type-design-analyzer-1 — brand `RunState.nodes` key as `StoredNodeKey` | **deferred** | Sound, and the right long-term shape. It is an interface change touching every consumer of `RunState` — deepen territory, not a fix pass. Recorded as an F1 PR-B input, since PR-B is the consumer that will read this surface. |
| type-design-analyzer-2 — make `compositeNodeKey` Result-returning | **deferred** | Sound and directly targets the hazard ADR-0085 records. But it changes `composite-node-key.ts`'s primary API and every existing caller including the file backend — a deepening, and larger than this PR. Recorded with A3 for PR-B. |
| type-design-analyzer-3 — `Checkpointer` as `type` alias, not `interface` | **dismissed** | Would restructure a long-standing port with multiple implementers and every test fake, for a variance nuance with no demonstrated defect here. Unrelated to this PR's change; the cost/benefit does not survive the reviewed scope. |
| type-design-analyzer-4 — brand `dagFingerprint` | **deferred** | Pre-existing, untouched by this PR, no defect demonstrated. Legitimate, but widening the diff into unrelated domain surface. |
| code-simplifier-1 — duplicate `readClock` wrappers | **dismissed** | Pre-existing and untouched by this PR. The reviewer itself records it as a deliberate round-38 stopping point kept for symmetry with the file backend's non-identical `readClock`, and calls it "a judgment call for the team rather than a clear-cut win." |
| code-simplifier-2 — `parseRunMetaRecord` repeated guards | **deferred** | Pre-existing code this PR did not touch. Mechanical and safe, but it edits a hostile-input parse boundary with pinned message vocabulary for readability alone — not worth coupling to a correctness remediation. |

---

## Validation

```
cd packages/framework && bunx tsc --noEmit && bun run test
# then, with REDIS_URL exported, every CI package:
for pkg in framework document-source xlsx adapter-fs adapter-ms-graph \
           adapter-pg adapter-oracle http-auth host; do
  (cd packages/$pkg && bunx tsc --noEmit && bun run test)
done
bun run check:docs && bun test scripts/
```

Baseline before remediation: framework 3546 pass / 0 fail; all 9 packages green.
The C1 regression tests must **fail** against `bef5650` and pass after the fix.
