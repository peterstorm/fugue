# PR-45 remediation — round 6 (F1 PR-A, composite checkpoint addressing)

**Branch:** `feat/f1-runtime-width-fanout`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-09-07T14-00-00Z-standalone-review-r21`
**Result authority:** that run's `result.json` (digest `d9982a87288577d2c35b089016141e76fff26c4b2ac13c2797b0d560c2fac53d`)
**Panel:** 1 critical routed through the registered Refutation Panel — 3 lenses
(`reproduction`, `intent`, `blast-radius`), all three `upheld`, 0 refuted.

## Frozen review scope

```
.claude/plans/2026-09-06-pr45-remediation.md
.claude/plans/2026-09-06-pr45-remediation-round2.md
.claude/plans/2026-09-06-pr45-remediation-round3.md
.claude/plans/2026-09-06-pr45-remediation-round4.md
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

- `.claude/plans/2026-09-07-pr45-remediation-round6.md` (this plan)

## Counts

| | count |
|---|---|
| Reviewers | 7 (one retry: `comment-analyzer` attempt 1 rejected for a missing Machine Summary block) |
| Critical found | 1 |
| Refuted | 0 |
| **Surviving critical (mandatory)** | **1** |
| Advisory | 9 (2 pairs are the same claim emitted twice by `pr-test-analyzer` — prose + structured) |

---

## Surviving critical — mandatory

### C1 — `type-design-analyzer-1`: `namespace: null` bypasses the codec's fail-closed re-validation

**File:** `packages/framework/src/checkpoint/composite-node-key.ts` (`compositeNodeKey`)

**Claim (upheld 3/3):** with `index` or `attempt` present, a forged `namespace: null`
is silently folded to `DEFAULT_NODE_NAMESPACE` instead of being rejected.

**Trace:**

1. `assertNoNamespaceAlone` does not fire — `opts.index !== undefined`, so the
   ambiguity guard is skipped.
2. `opts.namespace ?? DEFAULT_NODE_NAMESPACE` — `??` treats `null` as nullish,
   substituting `"dag"`.
3. `assertIdComponent("namespace", "dag")` trivially passes.
4. Result: `dag@<nodeId>@<index>@<attempt>` — byte-identical to the call that
   omitted `namespace` entirely. The caller's out-of-contract value is discarded.

The sibling fields in the same options bag behave the opposite way: `index` and
`attempt` are gated on `!== undefined`, so `null` reaches `assertIndexOrAttempt`
and throws (pinned by the `hostileNumbers` table, which includes `null`). The
module header claims *"out-of-contract keys are rejected outright (parse, don't
validate)"* and *"runtime boundaries still reject forged JavaScript values"* —
`namespace` is the one component that does not honor it.

**Panel evidence:** `reproduction` traced the exact fold; `intent` found no ADR
or comment sanctioning null-as-absent for `namespace`, unlike `index`/`attempt`;
`blast-radius` confirmed `InMemoryCheckpointer.saveNode` and
`RedisCheckpointer.saveNode` both pass caller `opts` straight into
`encodeStoredNodeKey`/`compositeNodeKey` with no prior boundary re-validation —
unlike the file backend's `parseSaveNodeBoundary`, which rejects a non-string
`namespace` regardless of `index`/`attempt`. 2 of 3 backends are exposed.

**Fix:** gate `namespace` on presence exactly the way `index`/`attempt` are
gated, routing every non-`undefined` value through the existing
`assertIdComponent` machinery instead of past it:

```ts
const rawNamespace = opts.namespace;
const namespace = rawNamespace === undefined ? DEFAULT_NODE_NAMESPACE : rawNamespace;
assertIdComponent("namespace", namespace);
```

This differs from today's behavior only when `rawNamespace === null`, where
`assertIdComponent`'s existing `typeof value === "string"` guard now throws. No
new logic, no interface change, no behavior change for any honest caller.

**Regression pin:** add `null` (and `undefined`-adjacent forged values) to the
namespace hostile table in `composite-node-key.test.ts`, asserting the throw with
both `index` and `attempt` present.

### C1b — hardening carried by the same fix: `assertIdComponent`'s message is not total

Found while implementing C1, in the same function, same fail-closed contract
class. `assertIdComponent` builds its diagnostic with raw template
interpolation:

```ts
`Invalid composite node key ${kind} "${value}": …`
```

`${value}` invokes the value's `toString`. A forged
`{ namespace: { toString() { throw } }, index: 1 }` therefore escapes with the
*hostile's* error text, from inside the codec's own rejection — exactly the trap
`assertIndexOrAttempt` already defends against with `safeDiagnosticRender`, and
exactly what the codec's error-channel contract says must never happen ("the
diagnostic names the codec's rule, never the hostile value's own error text").
`safeDiagnosticRender` is already imported. Fixing C1 without this leaves the
identical defect one forged value to the left, so it is closed together.

---

## Advisory dispositions

| ID | Agent | Disposition | Reason |
|---|---|---|---|
| `pr-test-analyzer-1` | pr-test-analyzer | **accepted** | Redis hostile-clock / hostile-fingerprint-getter contracts are pinned only inside the `REDIS_URL`-gated block, while the same "never a raw rejection" class got fast fake-driver coverage in this PR chain. `redisDriverFake` makes the fast version a few lines. Complete in-scope fix. |
| `pr-test-analyzer-3` | pr-test-analyzer | **accepted** | Duplicate of `pr-test-analyzer-1` (prose emission of the same claim, `file: null`). Closed by the same fix; recorded separately so the result's advisory ledger is fully dispositioned. |
| `pr-test-analyzer-2` | pr-test-analyzer | **accepted** | The "malformed address issues NO write" test uses the permissive `recordingRedis` fake, so it proves only "zero `evalsha`", not "zero driver calls". The strict default-throw `redisDriverFake()` upgrades it to the wire-level guarantee the file's own docstring claims. One-line change. |
| `pr-test-analyzer-4` | pr-test-analyzer | **accepted** | Duplicate of `pr-test-analyzer-2`. Closed by the same fix. |
| `type-design-analyzer-2` | type-design-analyzer | **accepted** | `this.saveNodeSha = await this.redis.script(...) as string` is an unchecked assertion on a `Promise<unknown>` port method. A driver returning a `Buffer` would thread a non-string into `evalsha` as a validated SHA. A `typeof` guard returning `cache-error("saveNode")` fails closed with no port change (the port must stay `Promise<unknown>` so `ioredis.Redis` satisfies it structurally with no cast). |
| `code-simplifier-1` | code-simplifier | **accepted** | The EVALSHA call and its NOSCRIPT/EVAL fallback repeat five identical trailing arguments. A dedicated regression test exists solely to catch drift between them; hoisting one `as const` tuple removes the hazard structurally. No signature, control-flow, or error-handling change. |
| `type-design-analyzer-3` | type-design-analyzer | **deferred** | Branding `RunState.nodes`' keys as `StoredNodeKey` is an interface change touching every consumer of `RunState`, all of which are outside the frozen scope (PR-A's stated boundary is checkpoint backends, no consumers). Already recorded as an F1 PR-B input in `.claude/plans/2026-09-06-pr45-remediation.md`; the deferral conditions still hold verbatim. Re-deferred, not re-litigated. |
| `architecture-tech-lead-2` | architecture-tech-lead | **deferred** | Same claim as `type-design-analyzer-3`, reached through the deepen lens; the reviewer itself confirms it is already tracked and recommends it stay slated for PR-B. Same reason. |
| `architecture-tech-lead-1` | architecture-tech-lead | **deferred** | Making `compositeNodeKey` return `Result` instead of throwing changes the codec's primary API and every call site including `file/checkpointer.ts`, which is outside the frozen scope and whose observable message text would change. The reviewer independently reached the same deferral conclusion. Already recorded as an F1 PR-B input. |

No advisory is dismissed. The three deferrals are the two PR-B interface changes
already tracked in-repo, both re-verified as still live in the current code
(`compositeNodeKey` still throws; `RunState.nodes` is still
`Record<string, NodeState>`).

## Refuted findings audit

None. The Refutation Panel returned `upheld` on all three lenses for the single
critical, so nothing was excluded from remediation on panel grounds.

---

## Fix list

1. **C1** — `composite-node-key.ts`: gate `namespace` on `=== undefined` instead
   of `??`, so a forged `null` reaches `assertIdComponent` and throws.
2. **C1b** — `composite-node-key.ts`: render `assertIdComponent`'s diagnostic via
   `safeDiagnosticRender` so a throwing `toString` cannot trap inside the codec's
   own rejection.
3. **C1/C1b tests** — `composite-node-key.test.ts`: hostile-namespace table gains
   the forged non-string values (`null`, and the throwing-`valueOf` /
   throwing-`toString` twins already used for `index`/`attempt`), asserted with
   `index` and with `attempt`, and asserted to carry the codec's own message
   rather than the hostile's text.
4. **`type-design-analyzer-2`** — `redis-checkpointer.ts`: replace
   `as string` on the SCRIPT LOAD result with a `typeof` guard returning
   `cache-error("saveNode")`.
5. **`code-simplifier-1`** — `redis-checkpointer.ts`: hoist the shared five-argument
   script tuple so EVALSHA and the EVAL fallback cannot drift.
6. **`pr-test-analyzer-1`/`-3`** — `redis-checkpointer.test.ts`: add fast
   fake-driver coverage of the Redis hostile-clock (throwing, NaN) and hostile
   `expectedDagFingerprint` getter contracts to the driver-failure block, so they
   run without `REDIS_URL`.
7. **`pr-test-analyzer-2`/`-4`** — `redis-checkpointer-composite-opts.test.ts`:
   the malformed-address test uses the strict default-throw `redisDriverFake()`,
   proving zero driver calls of any kind.
8. New tests for item 4 (non-string SCRIPT LOAD result fails typed) and item 5
   (the hoisted tuple keeps the NOSCRIPT path's address).

## Validation commands

```bash
bun run typecheck
bun test packages/framework/src/__tests__/composite-node-key.test.ts
bun test packages/framework/src/__tests__/redis-checkpointer.test.ts
bun test packages/framework/src/__tests__/redis-checkpointer-composite-opts.test.ts
bun test packages/framework
```
