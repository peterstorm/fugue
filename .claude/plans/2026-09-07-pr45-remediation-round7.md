# PR-45 remediation — round 7 (F1 PR-A, composite checkpoint addressing)

**Branch:** `feat/f1-runtime-width-fanout`
**Reviewed HEAD:** `7824db0`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-09-07T20-00-00Z-standalone-review-r22`
**Result authority:** that run's `result.json`
**Panel:** 1 critical routed through the registered Refutation Panel — 3 lenses
(`reproduction`, `intent`, `security`), all three `upheld`, 0 refuted.

## Frozen review scope

```
.claude/plans/2026-09-06-pr45-remediation.md
.claude/plans/2026-09-06-pr45-remediation-round2.md
.claude/plans/2026-09-06-pr45-remediation-round3.md
.claude/plans/2026-09-06-pr45-remediation-round4.md
.claude/plans/2026-09-07-pr45-remediation-round6.md
docs/adr/0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md
docs/adr/0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md
docs/adr/README.md
docs/plans/2026-09-06-f1-runtime-width-fanout.md
packages/framework/src/__tests__/_checkpointer-suite.ts
packages/framework/src/__tests__/_redis-driver-fake.ts
packages/framework/src/__tests__/boundary-imports.test.ts
packages/framework/src/__tests__/composite-node-key.test.ts
packages/framework/src/__tests__/redis-checkpointer-composite-opts.test.ts
packages/framework/src/__tests__/redis-checkpointer.test.ts
packages/framework/src/checkpoint/checkpointer.ts
packages/framework/src/checkpoint/composite-node-key.ts
packages/framework/src/checkpoint/redis-checkpointer.ts
```

Support paths (remediation-owned, outside the frozen scope):

- `.claude/plans/2026-09-07-pr45-remediation-round7.md` (this plan)

## Counts

| | count |
|---|---|
| Reviewers | 7 (no retries) |
| Critical found | 1 |
| Refuted | 0 |
| **Surviving critical (mandatory)** | **1** |
| Advisory | 2 (both accepted) |

---

## Surviving critical — mandatory

### C1 — `code-reviewer-1`: `assertNoNamespaceAlone`'s diagnostic is not total

**File:** `packages/framework/src/checkpoint/composite-node-key.ts` (`assertNoNamespaceAlone`)

**Claim (upheld 3/3):** the ambiguity error is built with raw template
interpolation of `opts.namespace`, so a forged `{ toString() { throw } }`
escapes the codec carrying the hostile's own text.

**This is round 6's own C1b, one function to the left.** Round 6 closed exactly
this defect in `assertIdComponent` and added regression pins for it — but the
pins all supply `index` alongside the hostile namespace, which routes through
`assertIdComponent`. The namespace-**alone** path routes through
`assertNoNamespaceAlone` instead, which round 6 never touched and no test ever
reached. The fix was applied to the instance the reviewer named rather than to
the class; this round closes the class.

**Trace:** `compositeNodeKey(nodeId, { namespace: hostile })` with no
`index`/`attempt` → `opts.namespace !== undefined` is true and both addressing
components are absent → the ambiguity branch fires → `${opts.namespace}`
invokes the hostile `toString` → it throws *before* `new Error(...)` is
constructed, so the hostile's text propagates. `encodeStoredNodeKey` wraps it
with `safeErrorMessage`, which preserves whatever message the inner throw
carried, so a caller sees
`checkpoint-write-failed: composite node address is invalid: <hostile text>`
instead of the codec's rule.

**Reachability** is the same argument the panel accepted in round 6: the
in-memory and Redis backends hand caller `opts` straight to the codec with no
boundary re-validation; only the file backend pre-rejects a non-string
namespace.

**Fix:** render through `safeDiagnosticRender(opts.namespace)`, matching its two
sibling asserts.

**Class sweep (this round's addition, not requested by the finding):** every
`${…}` interpolation in the module was audited rather than just the one cited.
After this fix the remaining interpolations are the two doc-comment examples and
the encode path's own output, whose four components are all validated before
they are interpolated. The codec's message surface is then total by inspection,
not by whack-a-mole — which is the actual reason this finding recurred.

---

## Advisory dispositions

| ID | Agent | Disposition | Reason |
|---|---|---|---|
| `pr-test-analyzer-1` | pr-test-analyzer | **accepted** | The 8-case corrupt-meta grammar-gate table lives only inside the `REDIS_URL`-gated block, so a local `bun test` gives zero signal on the gate that stops corrupt bytes becoming a "valid" checkpoint. This is the same gap class round 6 closed for the clock/opts guards — the fix went to the contracts the reviewer named, not to the class again. A `redisDriverFake({ get })` twin of the table closes it in the block round 6 already created. |
| `pr-test-analyzer-2` | pr-test-analyzer | **accepted** | `SAVE_NODE_SCRIPT`'s comment justifies the Lua script by "a crash between the HSET and either EXPIRE would leak checkpoint data forever", but nothing asserts both keys actually carry a TTL after a save. The fake-driver tests observe the argument list, never the server-side effect, so deleting an `EXPIRE` line from the script passes the whole suite. Two `ttl()` assertions in the existing live-Redis block close it. The reviewer rated it lower urgency (the script predates PR-A); it is still a real, cheap, in-scope gap with an unbounded-memory failure mode. |

No advisory is deferred or dismissed this round.

**Standing deferrals carried forward unchanged** (not re-raised by any reviewer
this round; `type-design-analyzer` and `architecture-tech-lead` both explicitly
re-verified the conditions still hold and declined to re-litigate): branding
`RunState.nodes`' keys as `StoredNodeKey`, and making `compositeNodeKey` return
`Result`. Both remain F1 PR-B inputs.

## Refuted findings audit

None. The panel returned `upheld` on all three lenses, so nothing was excluded
from remediation on panel grounds.

---

## Fix list

1. **C1** — `composite-node-key.ts`: `assertNoNamespaceAlone` renders
   `opts.namespace` through `safeDiagnosticRender`.
2. **C1 tests** — `composite-node-key.test.ts`: the throwing-hook and forged
   non-string namespace tables gain the namespace-**alone** case (no `index`,
   no `attempt`), asserting the codec's ambiguity message and the absence of the
   hostile's text. The existing pins keep the with-`index` case, so both branches
   are covered rather than one standing in for the other.
3. **`pr-test-analyzer-1`** — `redis-checkpointer.test.ts`: the corrupt-meta
   grammar table also runs against `redisDriverFake({ get })` in the
   "hostile seams without a live server" block.
4. **`pr-test-analyzer-2`** — `redis-checkpointer.test.ts`: after a real
   `saveNode`, assert both `chkpt:<runId>` and `chkpt:<runId>:meta` carry a
   positive TTL, in the `REDIS_URL`-gated block where a real server exists.

## Validation commands

```bash
cd packages/framework && bunx tsc --noEmit -p tsconfig.json
REDIS_URL=redis://localhost:6379 bun test packages/framework
```

Both the fast (no `REDIS_URL`) and live-Redis legs must pass, and every new pin
must be checked to fail against pre-fix code.
