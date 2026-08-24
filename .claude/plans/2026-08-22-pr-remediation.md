# PR Remediation Plan — 2026-08-22

## Authority and exact scope

- Branch: `feat/f6-file-durable-runtime`
- Review HEAD: `7f4ca177dfb4229ec9eb7e0c0f2010d1c6f6d794`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T205421Z`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T205421Z/result.json`
- Result digest: `27c79e56e34e0caa4f21e456a70c3ab5f9bfb286b880ef13804157eb6549ae6a`
- Frozen review scope: exactly the 443 paths in the immutable canonical `result.json.scope` array. That array is the literal reviewed-path authority.
- Support paths outside frozen scope: none. This plan and every production/regression path below are members of `result.json.scope`.

## Surviving critical findings — mandatory

### `silent-failure-hunter-1` — synchronous BullMQ failure handlers escape isolation

**Finding:** `Promise.resolve(handler(...)).catch(...)` evaluates `handler(...)` before constructing the promise, so a synchronous `onFailed` or `onExhausted` throw bypasses worker-error emission.

**Fix:** defer handler invocation through a promise continuation before attaching the rejection handler, preserving the existing asynchronous isolation contract for both sync throws and rejected promises. Add a pure regression pin for synchronous throws and retain the integration coverage for async rejection.

### `type-design-analyzer-1` — incomplete `DagPhase` variants inhabit persisted checkpoints

**Finding:** `makeRunStoreJobLike` checks only `state.kind`; variants such as `{ kind: "running" }` pass despite missing required fields such as `wave`.

**Fix:** replace the discriminator-only guard with a complete, exhaustively keyed `DagPhase` parser. Parse every variant's required scalar, branded-id, array, gate-payload, and persisted-framework-error fields before constructing `Envelope`. Keep the context check at the existing framework-authored object boundary. Add a malformed-variant corpus proving each incomplete phase fails closed, plus valid representative phase coverage.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — one corrupt active run aborts the reconciliation sweep.** The claim is reproducible: `runStore.get` returns the whole operation early. Extend `ReconciliationAttempt` with a per-run `inspection-failed` outcome, log it without throwing, and continue to later active runs. Apply the same per-run treatment to decision inspection while retaining active-index enumeration failure as the top-level `Err`. Add a corrupt-first/healthy-second regression.
2. **`silent-failure-hunter-2` — freshness extractor failure conversion is not total.** Both extractor catches use executable coercion and direct logging. Render caught values with `safeErrorMessage`, guard warning emission, and prove a hostile thrown value plus throwing logger still returns the intended fail-closed `node-crash` result.
3. **`silent-failure-hunter-3` — run-queue diagnostics can mask retry/release outcomes.** Replace the two direct process/release logger calls with the existing `logWithoutThrowing` boundary. Add regressions showing a throwing logger cannot replace the process error or turn a release diagnostic into a worker failure.
4. **`comment-analyzer-1` — Redis key-layout documentation is incomplete.** Expand the load-bearing tenant-scope comment to include the active-run index and lease-fence keys the adapter uses.
5. **`code-simplifier-1` — host boot-log comment retains review provenance.** Delete only the stale reviewer/run footer; retain the constraint-bearing explanation.
6. **`code-simplifier-2` — load-options parser comment retains review provenance.** Delete only the stale reviewer/run footer; retain the proxy-read invariant and regression reference.

### Deferred

None.

### Dismissed

1. **`type-design-analyzer-2` — `RunTimestampMs` accepts negative, fractional, and unsafe finite values.** Dismissed because the documented clock-domain invariant in `CONTEXT.md` deliberately defines raw persisted millisecond values as finiteness-only; representability constraints apply only at ms-to-`Date` boundaries. Tightening this constructor would contradict the accepted D6 two-clock-domain decision without evidence that HITL timestamps are a different domain.

## Refuted critical audit — retain, never fix

The canonical `result.json.refuted_critical_findings` array is empty. No critical finding was refuted. Both surviving criticals were unanimously upheld by the registered reproduction, intent, and security lenses:

- `silent-failure-hunter-1`: synchronous callback invocation occurs before `Promise.resolve`, while the public handler contract permits synchronous `void` handlers; the throw therefore bypasses intended worker-error emission and creates an availability risk.
- `type-design-analyzer-1`: discriminator-only parsing admits missing `wave`, gate payload, retry bookkeeping, or error data into `DagPhase`, allowing corrupted persisted state to drive execution branches.

## Planned files

- `.claude/plans/2026-08-22-pr-remediation.md`
- `packages/framework/src/queue-bullmq/adapter.ts`
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts`
- `packages/host/src/hitl/run-store-job.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/__tests__/freshness-emission.test.ts`
- `packages/host/src/hitl/adapters/run-queue.ts`
- `packages/host/src/hitl/adapters/__tests__/run-queue.test.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/host.ts`
- `packages/framework/src/file/checkpointer-codec.ts`

## Validation

1. Green focused baseline before implementation:
   ```bash
   bun test packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts packages/framework/src/__tests__/freshness-emission.test.ts packages/host/src/hitl/__tests__/run-store-job.test.ts packages/host/src/hitl/__tests__/service.test.ts packages/host/src/hitl/adapters/__tests__/run-queue.test.ts
   ```
2. Repeat focused tests after each cohesive remediation move.
3. Package typechecks:
   ```bash
   bun run --filter @fuguejs/framework typecheck
   bun run --filter @fuguejs/host typecheck
   ```
4. Full workspace typecheck: `bun run typecheck`.
5. Full workspace tests: `bun run test`.
6. Documentation links: `bun run check:docs`.
7. Distill apply-mode pass after a green implementation; rerun focused tests after each accepted simplification.
