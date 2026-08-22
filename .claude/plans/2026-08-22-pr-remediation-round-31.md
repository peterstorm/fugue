# PR Remediation — Standalone Review Round 31

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T190958Z-01a02ae1`
- Canonical result: `result.json` (digest `81340ee621cd5947f68cd067d7f831c97a6fd1b406a307b0240cd03a217412f6`, 35,497 bytes)
- Exact frozen review scope: the 439-path `result.json.scope` manifest. This immutable manifest is the scope authority; remediation targets and support paths are listed below.
- Baseline: 204 targeted tests passed across six files before remediation.

## Mandatory surviving critical findings

### `code-reviewer-1` — Redis run metadata is not losslessness-gated

`packages/host/src/hitl/adapters/run-store.ts:343` serializes arbitrary run input and completed output through `toJson` without the framework codec's required pre-scan and round-trip verdict. Reserved serializer-tag-shaped objects can therefore return as a different value or type.

Fix:

1. Apply the framework-owned losslessness pre-scan before emitting run metadata.
2. Parse the emitted bytes and require a deep-equal round trip before Redis publication.
3. Fail closed through the existing typed `internal-invariant-violated` result and write no metadata on rejection.
4. Add regressions for reserved serializer keys in both initial input and completed output, while retaining the supported Map/Set/Date round-trip pin.

### `comment-analyzer-1` — false compiler-option comment

`packages/framework/src/cli/authored-codegen.ts:704` says `noImplicitReturns` is disabled although `tsconfig.base.json` enables it.

Fix: rewrite the comment to state the actual purpose of `assertNever`: exhaustive shape checking when the union grows.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-1` — late PostgreSQL health-probe failure disappears.**
   - Reason: the query remains in flight after the timeout verdict, and its eventual root cause is operationally useful. The Oracle adapter already establishes the repository pattern.
   - Fix: retain the query promise, record whether the timeout won, and emit a never-throwing late-failure warning containing a total safe diagnostic. Add a delayed-rejection regression.

2. **`type-design-analyzer-1` — TenantRegistry exposes its live Map.**
   - Reason: `ReadonlyMap` is compile-time only; a cast can call `set` on the actual backing map and bypass team uniqueness and lifecycle transitions.
   - Fix: keep the existing read interface but expose a frozen read-only facade with no mutation methods, backed by a hidden copied Map. Add a regression proving an attempted cast-based mutation cannot alter lookup or active-tenant state.

3. **`architecture-tech-lead-1` — host owns the FrameworkError persistence codec.**
   - Reason: the claim is sound and the codec belongs beside the framework-owned ADT. Moving it reduces cross-package semantic duplication without widening host responsibilities.
   - Fix: export the exhaustive loose persisted-error Zod schema from `packages/framework/src/types/errors.ts`, test required-field rejection/additive-field preservation in the framework, and consume it from the host RunMeta schema. Update `CONTEXT.md` to record codec ownership.

4. **`code-simplifier-1` — duplicated HITL safe-logging helper.**
   - Reason: six copies encode one diagnostic-safety invariant and have already diverged in naming/signature. A HITL-local helper has multiple real callers and concentrates the rule.
   - Fix: add one local `logWithoutThrowing` helper and replace the copies in human review, service, decision store, run store, run queue, and run executor without changing message levels or fields.

5. **`code-simplifier-2` — nested node-id ternary.**
   - Reason: the three domain cases are clearer as explicit control flow and the change is behavior-preserving.
   - Fix: extract a small pure selector using `if` branches for metadata, valid node id, and invalid node id.

6. **`code-simplifier-3` — nested Redis-outcome ternary.**
   - Reason: an exhaustive typed lookup makes the Redis-to-domain vocabulary explicit and prevents drift.
   - Fix: use a `satisfies Record<...>` mapping from Redis outcomes to `DecisionResolution`.

7. **`code-simplifier-4` — duplicated terminal-status predicate.**
   - Reason: `isTerminalStatus` is already the local source of truth.
   - Fix: reuse it in `parsePersistedStatus`.

### Deferred

None.

### Dismissed

None.

## Refuted critical audit

No critical findings were refuted. The panel upheld both criticals under reproduction, intent, and security lenses.

## Planned remediation paths

Reviewed-scope paths:

- `CONTEXT.md`
- `packages/adapter-pg/src/index.ts`
- `packages/adapter-pg/src/__tests__/pg-adapter.test.ts`
- `packages/framework/src/types/errors.ts`
- `packages/framework/src/types/index.ts`
- `packages/framework/src/types/error-factories.ts`
- `packages/framework/src/__tests__/errors.test.ts`
- `packages/framework/src/__tests__/error-factories.test.ts`
- `packages/framework/src/cli/authored-codegen.ts`
- `packages/host/src/hitl/human-review-hook.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/hitl/adapters/decision-store.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/run-queue.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/supervisor/registry/tenant-registry.ts`

Support paths outside the frozen review scope:

- `.claude/plans/2026-08-22-pr-remediation-round-31.md`
- `packages/host/src/hitl/diagnostic-logging.ts`
- `packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts`

## Validation

1. Targeted regression suite:
   ```bash
   bun test packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/host/src/__tests__/supervisor/registry/tenant-registry.test.ts packages/adapter-pg/src/__tests__/pg-adapter.test.ts packages/framework/src/__tests__/errors.test.ts packages/framework/src/__tests__/error-factories.test.ts packages/framework/src/__tests__/cli/cli.test.ts
   ```
2. Package typechecks:
   ```bash
   bun run --filter @fuguejs/framework typecheck
   bun run --filter @fuguejs/host typecheck
   bun run --filter @fuguejs/pg typecheck
   ```
3. Full repository gates:
   ```bash
   bun run typecheck
   bun run test
   bun run check:docs
   ```
4. Run the `distill` apply-mode pass only from a green targeted baseline, one behavior-preserving move at a time, then rerun the full gates.
