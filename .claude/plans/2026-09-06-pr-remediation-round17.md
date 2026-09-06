# PR Remediation Plan — Round 17

**Branch:** `feat/f3-budget-capability-surface`
**Review HEAD:** `d96f37286c5dd6624b6cfba030c8d3aeb295b86d` (working tree clean, byte-identical to frozen scope)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-06T20-00-00Z-standalone-review-r17`
**Canonical result:** `<run>/result.json` (digest `2a32278fe29d6964829472c73e20197eb62a344acc9ee5cf1b70fd68b30efcb3`)
**Scope:** `kind: all`, 177 files.

## Adjudication summary

| Bucket | Count |
|---|---|
| Reviewers spawned | 7 |
| **Critical findings raised** | **0** |
| Refuted by panel | 0 (no panel ran — the engine routes a panel only for a non-empty critical set; `result.json.panel` is `null`) |
| **Surviving critical (mandatory)** | **0** |
| Advisory entries in `result.json` | 16 |
| Unique advisories (`type-design-analyzer-2` duplicates `-1`) | 15 |
| **Accepted** | **15** |
| Deferred / dismissed | 0 |

This is the first round since round 10 with a clean critical set, and the first
ever where all seven reviewers independently returned `CRITICAL_COUNT: 0`.

### Refuted-finding audit

`result.json.refuted_critical_findings` is empty and `result.json.panel` is
`null`. No critical was raised, so the Refutation Panel was never issued — there
is no refuted finding to retain, and nothing is being skipped on refutation
grounds.

---

## The one defect family worth naming: the `node-error` emission contract

Advisories `code-reviewer-1/-2/-3` are three symptoms of one broken invariant —
**every failing node gets exactly one `node-error` observer event** — so they are
planned and fixed together rather than patched independently.

I enumerated every path that can put a node into `executeWave`'s `failures[]`
and checked each against the source:

| Failure path | emits `node-error` today |
|---|---|
| `executeWave` node-not-found (`wave-execution.ts:159`) | **none** |
| `runNodeShared` checkpoint-replay rejected (`run-node.ts:493`) | one |
| `runNodeShared` `buildNodeInput` failure (`run-node.ts:512`) | **none** |
| `runNodeShared` input-validation failure (`run-node.ts:518`) | one |
| `runNodeShared` minting refusal (`resolveMintedNodeContext`) | one |
| `runNodeShared` `run()` threw (`run-node.ts:564`) | one |
| `runNodeShared` `run()` returned `Err` (`run-node.ts:572`) | one |
| `runNodeShared` output-validation failure (`run-node.ts:580`) | one |
| `runNodeShared` checkpoint-write failure (`run-node.ts:596`) | one |
| `executeWave` per-node catch (`wave-execution.ts:183`) | one |
| **plus** the co-failed-sibling loop (`wave-execution.ts:236`) | **+1 for every non-primary failure** |

**Reproduced, not assumed.** A throwaway probe DAG with two sibling nodes both
failing via `run: async () => err(...)` produced
`node-error` counts `[["fail_a", 1], ["fail_b", 2]]` — the primary once, the
co-failed sibling twice. Any observer, metric, or alert keyed on `node-error`
double-counts a co-failed sibling today.

**This is pre-existing, not a round-16 regression.** I re-ran the same probe
against `git show 880848e:…/wave-execution.ts` (the body before round 16 replaced
the hand-rolled emission with the shared `nodeErrorEmitter`) and got the
identical `[["fail_a",1],["fail_b",2]]`. Round 16 swapped the implementation; the
behaviour is older than that, and the round-17 reviewer found it because the swap
drew attention to the call site.

**Fix (one coherent change):** make emission the responsibility of the site that
produces the error, uniformly.

1. `run-node.ts:512` — emit `node-error` on the `buildNodeInput` failure, for the
   exact reason the *adjacent* input-validation branch already documents ("so
   buffered observers don't see the node simply disappear").
2. `wave-execution.ts:159` — emit `node-error` on the node-not-found branch.
3. `wave-execution.ts:230-240` — **delete** the co-failed-sibling re-emission
   loop. With (1) and (2) in place every failure path emits at its own site, so
   the loop is provably redundant and is the sole source of the duplicate.
4. `dag-concurrent-wave-failure.test.ts:95` — replace
   `expect(nodeErrors.length).toBeGreaterThanOrEqual(1)` with exact per-node
   counts. That assertion is precisely why the duplicate survived 16 rounds.

---

## Advisory dispositions — all 15 accepted

| ID | File | Disposition & fix |
|---|---|---|
| `code-reviewer-1` | `framework/dag-runtime/wave-execution.ts:238` | **Accepted.** Reproduced (sibling gets 2 events). Delete the re-emission loop — see the family fix above. |
| `code-reviewer-2` | `framework/dag-runtime/run-node.ts:512` | **Accepted.** Verified: returns the `Err` with no emission, six lines above a branch whose comment explains why that is wrong. Emit at the site. |
| `code-reviewer-3` | `framework/dag-runtime/wave-execution.ts:160` | **Accepted.** Verified: the `node-not-found` invariant violation produces no observer event at all. Emit at the site. |
| `pr-test-analyzer-1` | `framework/dag-runtime/run-dag-stateful.ts:334` | **Accepted, and fixed as behaviour, not only coverage.** Verified `if (!derivedDag.ok) return derivedDag;` runs *before* `beginRunTelemetry`, while the very next comment states the intent ("Emit run-start BEFORE compile so a malformed DAG still produces a balanced run-start/run-end pair") and every sibling pre-flight failure honours it. `beginRunTelemetry` already takes `dag`, not `effectiveDag`, so hoisting it above the retry-merge is safe. Fix the hole *and* add the regression test the advisory asked for. |
| `pr-test-analyzer-2` | `framework/testing.ts:91` | **Accepted.** Add direct tests for `fixedBudgetCapability`'s budgeted `Remaining` branches (tokens/calls/usd `available`, `unpriced`, both `unknown-usage` arms). |
| `type-design-analyzer-1` | `framework/types/errors.ts:392` | **Accepted.** Verified `persistedTokensCeilingSchema`/`persistedCallsCeilingSchema` and the tokens/calls `observed`/`observedAtLeast` fields are bare `z.number()` — negative, fractional and `Infinity` all parse — while the usd siblings enforce `.int().nonnegative().max(…)` through `PersistedMicroUsdSchema`. Not a live budget bypass (`usageOfError` returns `undefined` for `llm-budget-exceeded`), but a defence-in-depth crack at a wire boundary. Give the count axes `.int().nonnegative()`; add tests. |
| `comment-analyzer-1` | `framework/dag-runtime/run-node.ts:466` | **Accepted.** Verified the claimed consequence does not occur: such a throw lands in `executeWave`'s per-node catch, which converts it to a per-node error result, and `carriedOutputs` preserves the siblings as `partialOutputs`. Reword to what actually happens. (The claim *is* true of the different comment at `wave-execution.ts:186`, which guards a `Promise.all` rejection.) The same comment's "two call sites below" count also needs updating once `buildNodeInput` becomes a third. |
| `comment-analyzer-2` | `framework/dag-runtime/run-dag-stateful.ts:10` | **Accepted.** Verified `handleTerminalState` has a `.with({ kind: "suspended" }, …)` branch the file header omits. |
| `comment-analyzer-3` | `framework/types/node.ts:469` | **Accepted.** Verified `DagDef.retryLimits`/`defaultRetryLimit` carry retry *counts* only; `backoffMs`/`jitterRatio` fall back to `NodeRetryConfig`'s hardcoded defaults. Two unrelated fallback chains, currently conflated in one sentence. |
| `comment-analyzer-4` | `framework/shared/validate-dag.ts:567` | **Accepted.** Verified the comment says "Re-export" directly above the original `export const recordFromNodeArray` definition. |
| `comment-analyzer-5` | `host/hitl/adapters/run-executor.ts:74` | **Accepted.** Verified `host.ts:626` passes `tenant: routedTenant`, and `routedTenant` is a non-optional `TenantId` on the wiring args — the shipped single-tenant path never omits it. |
| `architecture-tech-lead-1` | `host/adapters/node-context-factory.ts:630` | **Accepted.** Verified 10 positional parameters, 2 production call sites (`host.ts:970` passes 9 positionally on one line; `run-executor.ts:188` mirrors it), and ~28 test call sites already split across two competing conventions. Deepen into a `CreateNodeContextOptions` record, keeping `shared`/`dag`/`runId`/`signal`/`identity` direct. The signature change makes the compiler enumerate every call site, which is what makes this refactor safe rather than risky. |
| `code-simplifier-1` | `framework/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts:1026` | **Accepted.** Verified 12 blocks differing only in the injected numeric value. Collapse to `it.each` tables. |
| `code-simplifier-2` | `framework/__tests__/cli/cli.test.ts:394` | **Accepted.** Verified `--help` and `-h` carry byte-identical bodies. Collapse to one `it.each`. |
| `code-simplifier-3` | `host/__tests__/config.test.ts:627` | **Accepted.** Collapse the boundary-rejection blocks to one `it.each` table. |

### Duplicate entry (no separate work)

`type-design-analyzer-2` is the machine-summary line for `type-design-analyzer-1`
and is resolved by that fix.

---

## Files to change

**Source (all inside the frozen review scope):**

- `packages/framework/src/dag-runtime/wave-execution.ts` — `code-reviewer-1`, `-3`
- `packages/framework/src/dag-runtime/run-node.ts` — `code-reviewer-2`, `comment-analyzer-1`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts` — `pr-test-analyzer-1`, `comment-analyzer-2`
- `packages/framework/src/types/errors.ts` — `type-design-analyzer-1`
- `packages/framework/src/types/node.ts` — `comment-analyzer-3`
- `packages/framework/src/shared/validate-dag.ts` — `comment-analyzer-4`
- `packages/host/src/hitl/adapters/run-executor.ts` — `comment-analyzer-5`, `architecture-tech-lead-1`
- `packages/host/src/adapters/node-context-factory.ts` — `architecture-tech-lead-1`
- `packages/host/src/host.ts` — `architecture-tech-lead-1`

**Tests (all inside the frozen review scope):**

- `packages/framework/src/__tests__/dag-concurrent-wave-failure.test.ts` — exact emission counts
- `packages/framework/src/__tests__/dag-runtime-stateful.test.ts` — balanced telemetry on invalid `retryLimits`
- `packages/framework/src/__tests__/budget-capability.test.ts` — `fixedBudgetCapability` headroom branches
- `packages/framework/src/__tests__/errors.test.ts` — persisted-breach count-axis sanitization
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts` — `it.each`
- `packages/framework/src/__tests__/cli/cli.test.ts` — `it.each`
- `packages/host/src/__tests__/config.test.ts` — `it.each`
- `packages/host/src/__tests__/node-context-factory.test.ts` — options-record call sites
- `packages/host/src/__tests__/integration/dag-isolation.test.ts` — options-record call sites

**Remediation-owned support paths (outside the frozen review scope):**

- `.claude/plans/2026-09-06-pr-remediation-round17.md` (this file)
- `packages/framework/src/__tests__/dag-concurrent-wave-failure.test.ts` — the
  regression pin for the emission contract. The file the `code-reviewer-1`
  finding names as too weak to catch the duplicate is itself outside the frozen
  scope, so strengthening it is remediation-owned work and is registered as a
  support path rather than smuggled in as a scope edit.

---

## Validation commands

```bash
bun run typecheck
bun run test
```

Both must exit 0 before any staging or commit. If validation cannot pass, stop
without staging.

---

## Distill pass (apply mode, post-implementation)

Green baseline first; covering tests re-run after each move.

| Move | Catalog move | Location |
|---|---|---|
| A | Delete dead code | `run-executor.ts` — `agentClientMap ?? {}` became dead once the options record's destructuring default supplies the same empty map. |
| B | Cut comment noise | `wave-execution.ts` — tightened the "no co-failure re-emission" comment to the constraint it actually carries (the one-event-per-failing-node contract and why the loop was wrong), dropping the restatement. |

Also folded into the fix rather than left as debt:

- `wave-execution.ts`'s per-node catch was still hand-rolling its own `node-error`
  literal. It now goes through the same `emitWaveNodeError`, which additionally
  carries `sideEffects` — a field the hand-rolled copy silently dropped.
- `countingClock` in `wave-execution-errors.test.ts` became unreachable when its
  only consumer was rewritten, and was deleted (`noUnusedLocals` caught it).

**Skipped:** adding an `observer` parameter to `wave-execution-errors.test.ts`'s
`makeConfig` to avoid two `{ ...makeConfig(…), nodeCtx: makeValidatedCtx(observer) }`
spreads. It would add a third optional positional parameter to a shared helper —
precisely the shape `architecture-tech-lead-1` is about. Two spreads are clearer.

---

## Validation evidence

```
$ bun run typecheck      → exit 0   (all 10 workspace packages)
$ bun run test           → exit 0   (0 failures workspace-wide)
```

| Suite | Result |
|---|---|
| `@fuguejs/framework` | 3527 tests / 190 files — **0 fail** |
| `@fuguejs/host` | 2617 tests / 124 files — **0 fail** |
| remaining 8 packages | 723 tests — **0 fail** |

### Regression proofs

- **Emission contract.** A probe DAG measured `node-error` counts before and
  after. Before: `[["fail_a",1],["fail_b",2]]`. After, across three failure modes
  (`err()`, thrown, mixed): `[["a",1],["b",1]]` every time. The strengthened
  `dag-concurrent-wave-failure.test.ts` fails against `d96f372` with
  `Expected 1 / Received 2` and passes against the fix.
- **Balanced telemetry.** All three new `invalid opts.retryLimits` cases fail
  against `d96f372` (3 fail / 37 pass) and pass against the fix.
- **Persisted-breach sanitization.** New cases in `errors.test.ts` assert the
  count axes now reject `-1`, `1.5`, `±Infinity` and `NaN` on both `limit` and
  `observed`/`observedAtLeast`, matching the cost axis.

### One test-suite regression, caught and fixed

Deleting the sibling loop broke `wave-execution-errors.test.ts`'s
"a failed co-failure emission still returns the primary node-failed" — a test whose
entire premise was the loop's existence (it calibrated the clock so the *last*
reading was that loop's emission). It was replaced by two tests aimed at the
emission sites that actually exist now: the `node-not-found` emission plus its
hostile-clock fence, and an exact per-node count at the `executeWave` seam. The
round-13 C1 intent — every wave-level emission is fenced — is preserved.

### Caveat worth carrying forward

`packages/host/tsconfig.json` sets `"exclude": ["src/__tests__"]`, so the host's
test call sites are **not** typechecked. That is why the `createNodeContextForDag`
signature change surfaced in production code as two clean compile errors but in the
tests as six runtime failures — the compile-time protection `architecture-tech-lead-1`
buys stops at the test boundary. Including them is not a small change (a probe run
shows pre-existing errors across ~10 test files: `import.meta` under CommonJS,
deliberately loosened capability fixtures), so it is **out of scope for this round**
and deliberately not attempted here. It is a good candidate for its own round.
