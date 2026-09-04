# PR Remediation — 2026-09-04

**Branch:** `feat/f3-budget-capability-surface`
**Review HEAD:** `0754660` (`fix: preserve spend transaction isolation`)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-09-04T00-00-00Z-standalone-review-r10`
**Canonical result:** `<run>/result.json` (digest `9e843f659d9d682487471ca345dabd0a684c86427ed9c37c51421943bf16893e`)

## Scope

The frozen review scope is the full branch surface recorded in `result.json → scope`
(F3 budget / spend / capability work: `packages/framework`, `packages/host`,
`apps/customer-summary`, the ADRs and plan notes shipped with it).

## Review outcome

| Bucket | Count |
| --- | --- |
| Reviewers spawned | 7 |
| Critical findings raised | 0 |
| Critical findings refuted | 0 |
| **Surviving critical findings** | **0** |
| Advisory findings | 19 |

No refutation panel ran: the critical set was empty, so the registered Standalone
Review Program published `result.json` directly. There is no refuted-finding audit
to report — `refuted_critical_findings` is `[]`.

## Surviving critical findings

None. Every reviewer returned `CRITICAL_COUNT: 0`.

## Advisory dispositions

14 accepted, 5 dismissed. No deferrals — every accepted item is fixed in this
remediation. One advisory (`code-simplifier-1`) was accepted during planning and
then refuted by the compiler during implementation; it is re-listed as dismissed
with the evidence.

### Accepted

| ID | File | Fix |
| --- | --- | --- |
| `pr-test-analyzer-1` | `packages/host/src/adapters/node-context-factory.ts:426` | Add tests for the spend-retention floor in the untested directions: `checkpointTtlSec > resumableRunTtlSec` (floor must hold at `checkpointTtlSec`) and `resumableRunTtlSec` omitted. Pins the invariant that a resumed run's spend record never expires before its checkpoint. |
| `pr-test-analyzer-2` | `packages/framework/src/dag-runtime/run-node.ts:388` | Add `per-node-minting.test.ts` cases for a `requires` iterable whose iterator throws and a `provides()` that throws, asserting the failure is classified non-retriable so broker egress is not re-fired on retry. |
| `pr-test-analyzer-3` | `packages/host/src/domain/capability-manager.ts:414` | Add tests exercising both `runScopedLlmFacade` defensive throws: an alias colliding with a standard operation name, and an alias naming an unknown operation. |
| `type-design-analyzer-1` | `packages/framework/src/types/capability-broker.ts:140` | Convert `CapabilityBroker` from an `interface` with method-shorthand members to a `type` alias with `readonly` function properties, so `mintFor`/`provides` get contravariant parameter checking under `strictFunctionTypes` instead of bivariant. Matches `typescript-patterns.md` → Ports & Adapters. No `implements` sites exist; all conformance is via object literals, and `CapabilityBroker["mintFor"]` indexed access still resolves. |
| `code-simplifier-4` | `packages/framework/src/dag-runtime/executor.ts:379` | Collapse the `succeeded`/`failed` terminal arms into one `.with({kind:"succeeded"},{kind:"failed"}, …)` that interpolates `p.kind` into the unreachable-invariant message. |
| `code-simplifier-5` | `packages/framework/src/dag-runtime/run-dag-stateful.ts:452` | Split the grouped non-terminal arm: `pending`/`running` keep `EXECUTOR_NODE_ID`; `retrying`/`awaiting-human` carry a real `nodeId` (confirmed on `DagPhase` in `dag-runtime/types.ts:68-100`) and must attribute the invariant violation to it, matching the sibling `retrying-hook` arm. |
| `code-simplifier-6` | `packages/host/src/adapters/metered-llm.ts:40` | Export `isObjectLike` from `run-spend-authority.ts` (already a type-only import target of `metered-llm.ts`) and use it in both `snapshotDataObject` and `parseSchema`, removing all three copies of the predicate. |
| `code-simplifier-7` | `packages/host/src/adapters/metered-llm.ts:181` | `parseTool` must propagate `parseSchema`'s specific error instead of replacing it with a fixed `must expose safeParse` — the discarded message distinguishes "not a schema object" and "could not be inspected safely" from the safeParse case. |
| `code-simplifier-8` | `packages/host/src/adapters/node-context-factory.ts:480` | Hoist the conditional `checkpointCommit` spread into one binding used by all three return arms of `selectAndHydrateSpendLedger`. |
| `code-simplifier-9` | `packages/host/src/adapters/redis-connectivity.ts:198` | Extract the shared WATCH → compare → MULTI-set retry loop behind one private helper taking the guard list; `setIfValue` and `setIfValues` keep their distinct operation labels (observable in telemetry/errors), so behaviour is preserved exactly. |
| `code-simplifier-10` | `packages/host/src/adapters/runtime-capabilities.ts:60` | Extract the repeated build → push → log-if-defined shape into one helper taking the handle and a lazy describe thunk (the CDRator/Oracle messages read config eagerly today and must stay lazy). |
| `code-simplifier-11` | `packages/host/src/http/middleware/error-handler.ts:149` | Replace `dagIdFor`/`runIdFor` with one shared own-string-field extractor. |
| `code-simplifier-13` | `packages/host/src/__tests__/run-spend-authority.test.ts:44` | Extract a local `createTestAuthority({…})` factory with per-test overrides, matching the pattern already used in `metered-llm.test.ts`; 13 call sites currently repeat the full `createRunSpendAuthority` literal. |
| `code-simplifier-15` | `apps/customer-summary/src/dag/nodes/enrich-with-tools.example.ts:14` | Delete the dead `__forExample` export and the `_Reference` alias, plus the `CrmRecord` import that only existed to feed it. Grep confirms zero consumers anywhere in the repo. |

### Dismissed

| ID | Reason |
| --- | --- |
| `code-simplifier-2` | `snapshotScopedCapabilities` and `parseBrokerResult` do share a two-line own-data-descriptor read with `ownDataValue`, but the differentiator is the diagnostic message, and `snapshotScopedCapabilities` additionally distinguishes "property disappeared during inspection" from "must be a data property". Routing them through `ownDataValue` collapses three distinct hostile-broker diagnostics into one generic "scoped binding" message at an authority boundary. Parameterising the message would make the helper longer than the inline read it replaces. |
| `code-simplifier-3` | Same reasoning across the package boundary: `types/spend.ts`'s `ownValue` emits `Spend.<key> must be an own data property` and additionally wraps the descriptor read in its own try/catch. A shared framework-internal module for four lines whose only variable part is the error text is not a net simplification. |
| `code-simplifier-12` | `parseHostError`'s variants do not share a uniform shape — each has a different field set, different branded smart constructors, and different optional-field handling. A table-driven engine would trade a compiler-checked exhaustive `switch` over the `HostError` union for a generic interpreter, on the parser that guards the throwing HTTP authority seam. The table plus engine would be at least as long as the switch, at strictly higher risk. |
| `code-simplifier-1` | **Refuted by the compiler.** The claim that the branch, predicate and type are deletable is false: `CeilingHeadroom`'s `unknown-usage` arm is a CORRELATED union (`TokensCeiling` pairs with a plain `number` `observedAtLeast`; `UsdCeiling` with a branded `MicroUsd`), and TypeScript will not narrow `headroom` from the nested discriminant `headroom.ceiling.kind`. The predicate IS that narrowing. Deleting it fails `bun run typecheck` in three packages with `TS2322` on `testing.ts:23`. The branches are textually identical and type-distinct. Restored, with the reason documented in place so the next reader does not repeat the deletion. |
| `code-simplifier-14` | Not behaviour-preserving. `makeCtx` returns `BaseNodeContext`; the shared `testNodeContext` returns `NodeContext` — different types. The two also seed different fixture ids (`r1`/`d1` vs `test-run`/`test-dag`), and other assertions in `extensible-capabilities.test.ts` (lines 310, 320, 333, 346, …) depend on `r1`/`d1`. |

## Validation commands

```bash
bun run typecheck   # all 12 packages, must exit 0
bun run test        # all 12 packages, must exit 0
```

Green baseline before remediation: `typecheck` clean; `test` 12/12 packages
`Exited with code 0` (framework 3372 pass, host + 10 others all 0 fail).

## Defect found while implementing

Writing the `pr-test-analyzer-2` regression test surfaced a real bug that no
reviewer raised.

`snapshotMintingAuthority` (`packages/framework/src/dag-runtime/run-dag-stateful.ts:281`)
fenced `broker.provides()` inside a `try`, but the enclosing
`for (const capability of node.requires)` iteration was **outside** any fence. A
`DagDef` assembled by hand (rather than through `defineDagFromArray`, which
snapshots `requires` into a frozen array) can carry a hostile iterable, and its
throw escaped `runDag` as an **uncaught exception** instead of returning on the
`Result` channel — breaking `runDag`'s contract and leaving run telemetry
unbalanced.

Fixed by spreading `node.requires` inside its own fence and returning a
`validation` FrameworkError attributed to the offending node. Pinned by
`per-node-minting.test.ts` → "a throwing requires iterable refuses on the Result
channel, before any egress", which also asserts the broker is never consulted.
Recorded under `### Fixed` in `packages/framework/CHANGELOG.md`.

## Distill pass (apply mode, post-implementation)

Run on the green baseline, one move at a time, re-testing after each:

1. **Reuse before rewrite** — `setIfGuardsHold` now takes `readonly RedisValueGuard[]`
   (the port's own named type) instead of a re-declared inline shape.
2. **Delete a type assertion** — the first cut of the shared error-handler field
   extractor used `error[field as keyof HostError] as string` twice, which
   `typescript-patterns.md` forbids and the original code did not need. Replaced
   with a `Reflect.get` read into `unknown` plus a `typeof` check: no assertions.
3. **Restore altitude** — that extractor also made all six call sites longer than
   the two functions it replaced. Since every one of the three sites wants the
   *pair*, it became `correlationFor(error)` spread into each — one concept,
   three uses, call sites shorter than the original.
4. **Collapse duplicate import** — `metered-llm.ts` imported value and type from
   `./run-spend-authority.js` on two lines; merged with an inline `type` modifier,
   matching the file's own `@fuguejs/framework` import.
5. **Direct types over derived** — the new `testAuthority` factory used
   `Parameters<typeof runId>[0]` / `ReturnType<typeof ceilings>`; replaced with
   `string` and the imported `Ceilings`.

**Skipped deliberately:** `snapshotMintingAuthority` now constructs the same
`err({ kind: "validation", nodeId, message })` shape five times and could take a
local `violation()` helper. Left alone — four of the five sites are pre-existing
code no finding named, and collapsing error construction inside an authority
parse fence is churn that widens the diff without a reviewer asking for it. The
site this remediation added follows the established local shape.

**Nothing surfaced warranting a `deepen` session.**

## Validation evidence

Final run, after implementation and the distill pass:

```
bun run typecheck   → 12/12 packages "Exited with code 0"
bun run test        → 12/12 packages "Exited with code 0", 0 fail everywhere
```

Per-package test counts (baseline → final):

| Package | Baseline | Final |
| --- | --- | --- |
| `@fuguejs/framework` | 3372 pass | **3374 pass** (+2) |
| `@fuguejs/host` | 2510 + 10 pass | **2514 + 10 pass** (+4) |
| `@fuguejs/customer-summary` | 243 pass | 243 pass |
| `@fuguejs/ms-graph` | 142 pass | 142 pass |
| `@fuguejs/http-auth` | 90 pass | 90 pass |
| `@fuguejs/oracle` | 79 pass | 79 pass |
| `@fuguejs/pg` | 73 pass | 73 pass |
| `@fuguejs/fs` | 25 pass | 25 pass |
| `@fuguejs/examples` | 23 pass | 23 pass |
| `@fuguejs/xlsx` | 20 pass | 20 pass |
| `@fuguejs/document-source` | 18 pass | 18 pass |
| `@fuguejs/hitl-smoke` | 10 pass | 10 pass |

+6 tests, 0 failures, no test weakened.

**Mutation check.** The two new spend-retention tests were verified to actually
pin the invariant: replacing
`Math.max(checkpointTtlSec, resumableRunTtlSec ?? checkpointTtlSec)` with
`(resumableRunTtlSec ?? checkpointTtlSec)` turned
"floors spend retention at the checkpoint TTL when it exceeds the resumable run
TTL" red (2511 pass / 1 fail). Source restored before proceeding.
