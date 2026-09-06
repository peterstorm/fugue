# PR #41 remediation — round 3

- **Branch:** `feat/f3-budget-capability-surface`
- **Revision reviewed:** `4b2cd8ae862f66235d8a69bee1d9d0552b451ad6`
- **Review run:** `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round3`
- **Frozen scope:** the 78 paths in that run's authoritative `result.json`
- **Required support paths:** this plan and `packages/framework/src/dag-runtime/run-dag-stateful.ts`; the latter is the run-preparation seam where one immutable authority snapshot can be shared by validation and dispatch, and the critical cannot be fixed locally in `run-node.ts` without duplicated/drifting state
- **Refuted criticals:** none

## Surviving critical findings

### `code-reviewer-1` — live `CapabilityBroker.provides()` can drift

Snapshot the broker's answers for the DAG's required capabilities once during run preparation, validate against a broker facade backed by that immutable set, and carry the same facade through dispatch. A stateful broker predicate must therefore be observed once per distinct capability and cannot waive validation before later allowing static fallback. Add a regression where the source predicate changes after its first answer.

### `type-design-analyzer-1` — inherited built-ins satisfy capability bags

Require `Object.hasOwn(caps, key)` before accepting a built-in fallback from `NodeContextInit.capabilities`. Preserve the established precedence: own, non-`undefined` top-level values (including `null`) win; otherwise own bag values are used; inherited values become `null`. Add prototype-pollution and custom-prototype regressions.

### `comment-analyzer-1` — `NodeContextInit` custom-capability comment is false

Document that custom capabilities are accepted only in the `capabilities` record and that only built-ins retain top-level compatibility fields.

### `comment-analyzer-2` — overshoot comment promises an unprovable bound

Replace the one-call bound with the actual estimate-based invariant: admission reserves the largest observed settled call, but a later larger concurrent burst can exceed that estimate; the authority learns the larger size for later admissions.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` — rejecting ledger reads:** fence `SpendLedgerPort.read`; budgeted runs remain fail-closed and unbudgeted runs use the documented metering-from-zero degradation with a diagnostic. Add both regressions.
2. **`code-reviewer-3` — incomplete Zod issue parsing:** parse every `$ZodIssue` discriminant and required variant payload recursively from the frozen snapshot. Add malformed and canonical nested-issue regressions.
3. **`code-reviewer-4` — reflective LLM subtype surface:** forward `has`, `ownKeys`, and compatible property descriptors while preserving private-field receiver binding and Proxy invariants. Cover frozen and extensible clients, `in`, `Object.keys`, spread, and descriptors.
4. **`silent-failure-hunter-1` — lifecycle logging can go silent:** emit a separately guarded stderr breadcrumb when the configured lifecycle logger throws; lifecycle outcomes remain authoritative. Add logger-and-stderr failure tests.
5. **`comment-analyzer-3` — ledger port policy comment:** state that budget-enforcing callers fail closed while non-enforcing callers may explicitly degrade.
6. **`comment-analyzer-4` — stale `Object.assign` reference:** describe the actual own-property merge path.
7. **`code-simplifier-1` — duplicated settlement sequence:** extract one local `record → release → persist` helper and reuse it for successful and partial-usage outcomes without changing effect order.
8. **`code-simplifier-2` — pass-through logging wrapper:** remove `reportWithoutThrowing` and call the existing guarded logger directly, restoring comment locality.
9. **`code-simplifier-3` — HITL start boilerplate:** add a test-only `startRunOrThrow` helper and replace only the repeated successful-start guards; keep tests that assert start failures explicit.

### Deferred

1. **`architecture-tech-lead-1` — typed `createNodeContextForDag` result seam:** defer to a dedicated host-boundary migration. The public factory is consumed directly by HTTP, HITL, host wiring, integration tests, and dozens of factory tests. A complete change must introduce typed setup-error variants, convert every expected throw, update the `CreateNodeContext` port and both HTTP/HITL shells, and remove string/rejection assertions together. Partially wrapping only the three currently identified throws would create dual error taxonomies at the same seam. This is the same deliberate boundary redesign recorded in the prior remediation, not a correctness workaround for the F3 changes.

### Dismissed

None.

## Implementation order

1. Establish focused green baseline.
2. Fix and test capability authority snapshotting and own-property context construction.
3. Fix and test ledger-read policy, exhaustive HostError parsing, reflective LLM forwarding, and lifecycle diagnostics.
4. Correct comments.
5. Apply the three accepted distillation moves one at a time with covering tests.
6. Run focused suites, all workspace typechecks, docs checks, `git diff --check`, and the full workspace suite.
7. Register the plan as a remediation support path and let Loom install the exact verified index.

## Validation

```bash
bun test packages/framework/src/__tests__/per-node-minting.test.ts \
  packages/framework/src/__tests__/make-node-context-merge.test.ts \
  packages/framework/src/__tests__/capability-validation.test.ts
bun test packages/host/src/__tests__/node-context-factory.test.ts \
  packages/host/src/__tests__/metered-llm.test.ts \
  packages/host/src/__tests__/middleware/error-handler.test.ts \
  packages/host/src/__tests__/capability-manager.test.ts \
  packages/host/src/__tests__/run-spend-authority.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts
bun run typecheck
bun run check:docs
git diff --check
bun run test
```
