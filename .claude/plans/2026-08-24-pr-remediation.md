# PR Remediation Plan — Adjudicated Standalone Review (round 44)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `76a2ee2bcdb31b74f0d106850018bbe770e922c0`

**Exact scope:** the complete canonical `result.json.scope` array (all paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T112038-069780432`

**Canonical result:** `<review-run>/result.json` (digest `67df7c4282e851a560e8d4eebf3a444b493ced93c42c72af34a94c3b8a10151e`, 40,228 bytes)

**Adjudication:** 7 reviewers → 2 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `blast-radius`) → **2 surviving / 0 refuted**; 11 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`silent-failure-hunter-1` — trace clock failure can prevent transition durability**
   `packages/framework/src/state-machine/runner.ts:120`
   Make trace clock reads best-effort and move the post-execution timing read after `appendEvent`/`updateData`/commit/progress persistence. A diagnostic clock failure must neither escape nor suppress a durable transition. Add a hostile-clock regression proving completed executor work is checkpointed once and is not replayed.

2. **`type-design-analyzer-1` — partial freshness completion is executor-local**
   `packages/framework/src/dag-runtime/wave-execution.ts:76`
   Replace executor-local `witnessedNodeIds` ownership with a durable `freshnessCompletedNodeIds` set in `DagMachineContextPersisted`. Wave execution starts from persisted completion proof, carries the updated set on both `wave-done` and post-wave `node-failed`, and the pure transition folds it into context. Parse and serialize the set at the durable boundary. Add a process-restart regression that aborts after partial freshness emission, resumes with a new executor/index, and proves already-committed bookkeeping is not re-emitted while outstanding bookkeeping completes.

## Advisory dispositions

### Accepted

- **`silent-failure-hunter-2` — worker registry hooks can mask typed Redis outcomes.** Sound Result-boundary defect. Invoke alive/dead hooks through a non-throwing diagnostic helper and pin both success and failure paths with throwing-hook tests.
- **`silent-failure-hunter-3` — HITL clock exception evidence is erased.** Sound diagnosability defect. Preserve `safeErrorMessage(error)` in the typed invariant error message and context; extend the existing throwing-clock test.
- **`comment-analyzer-1` — detached `executeSyncCycle` JSDoc.** Move the contract directly above `executeSyncCycle`.
- **`comment-analyzer-2` — detached `callHumanReviewHook` JSDoc.** Move the hook-body JSDoc directly above the function/type it describes and eliminate the ambiguous double block.
- **`comment-analyzer-3` — detached PostgreSQL row-validation JSDoc.** Attach the row-validation contract to `rowValidationError`; keep the shared crash-constructor contract on `pgCrash`.
- **`comment-analyzer-4` — detached Host Factory JSDoc.** Move the factory contract directly above `createHost` rather than leaving it above HITL wiring declarations.
- **`comment-analyzer-5` — production comment cites review-round metadata.** Replace `round-22 atl-1` with durable design rationale and backend-parity language.
- **`code-simplifier-1` — nested readiness ternary.** Extract a small pure, exhaustive readiness-status function using straight-line guards; keep HTTP status derived from the same `notReady` predicate.

### Deferred

- **`type-design-analyzer-2` — side-effect profiles do not require explicit replay-safety acknowledgement.** The claim is sound, but the accepted authoring contract deliberately permits gradual adoption and currently has 39 production/test declarations plus documentation that treats `idempotencyKey` as optional. Introducing an explicit `idempotent | unsafe` replay-safety ADT is a public authoring-surface redesign requiring an ADR and migration semantics; doing it inside this correctness remediation would create broad, unrelated API churn without adding runtime idempotency enforcement. Defer to a dedicated pre-1.0 type-design cycle.

### Dismissed

- **`code-simplifier-2` — repeated worker-lifecycle fixture construction.** Dismissed for this remediation: the repeated setup varies registry, probe, clock, spawn, process, tenant, config, and logger seams. A single override-heavy fixture DSL would expose nearly the implementation's whole interface and hide scenario ownership rather than deepen the test module.
- **`code-simplifier-3` — repeated checkpoint-corrupt narrowing in proof tests.** Dismissed: the explicit `Result` guards keep each negative proof case locally type-narrowed beside its distinct message evidence. A helper would save only a few lines while moving the relevant assertion away from each case.

## Refuted critical findings audit

None. Both critical findings survived unanimously under reproduction, intent, and blast-radius. The authoritative panel outcomes and raw evidence remain in `result.json.panel.outcomes` and the three captured `refutation-slot:*` transcripts.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `apps/customer-summary/src/server.ts`
- `docs/adr/0025-freshness-witness-contract.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`
- `packages/adapter-pg/src/index.ts`
- `packages/framework/src/state-machine/runner.ts`
- `packages/framework/src/checkpoint/checkpointer.ts`
- `packages/framework/src/dag-runtime/executor.ts`
- `packages/framework/src/dag-runtime/machine.ts`
- `packages/framework/src/dag-runtime/persistence.ts`
- `packages/framework/src/dag-runtime/post-wave-context.ts`
- `packages/framework/src/dag-runtime/transition.ts`
- `packages/framework/src/dag-runtime/types.ts`
- `packages/framework/src/dag-runtime/wave-execution.ts`
- `packages/framework/src/__tests__/_context-factories.ts`
- `packages/framework/src/__tests__/context-serialization-roundtrip.test.ts`
- `packages/framework/src/__tests__/dag-transition-property.test.ts`
- `packages/framework/src/__tests__/dag-transition.test.ts`
- `packages/framework/src/__tests__/freshness-emission.test.ts`
- `packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts`
- `packages/framework/src/__tests__/non-retriable-fast-fail.test.ts`
- `packages/framework/src/__tests__/retry-policy.test.ts`
- `packages/framework/src/__tests__/route-emission.test.ts`
- `packages/framework/src/__tests__/state-machine-runner.test.ts`
- `packages/framework/src/__tests__/wave-execution-errors.test.ts`
- `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/host.ts`
- `packages/host/src/sync/sync-loop.ts`

`packages/framework/src/__tests__/state-machine-runner.test.ts` is outside the frozen review scope and is the sole required support path: it pins the hostile trace-clock regression for mandatory finding `silent-failure-hunter-1`. Every other planned path is inside the frozen scope.

## Validation

Focused baseline and regression gates:

```bash
bun test packages/framework/src/__tests__/state-machine-runner.test.ts \
  packages/framework/src/__tests__/freshness-retry-exactly-once.test.ts \
  packages/framework/src/__tests__/context-serialization-roundtrip.test.ts
bun test packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts
bun test apps/customer-summary/src/__tests__/server.test.ts
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
bun run --filter customer-summary typecheck
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
