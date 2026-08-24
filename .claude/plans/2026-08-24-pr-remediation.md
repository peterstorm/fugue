# PR Remediation Plan — Adjudicated Standalone Review (round 50)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `ec785e79a17e21816cdd3febe253efcccf32a5fe`

**Exact scope:** the complete canonical `result.json.scope` array (all 503 paths frozen by the engine)

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/raf-20260824-170514-01a034bb-review`

**Canonical result:** `<review-run>/result.json` (digest `1b843e88a13e54b99421157905c42058a190503688089255a7aa26bdb2739f29`, 42,767 bytes)

**Adjudication:** 7 reviewers → 4 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **4 surviving / 0 refuted**; 11 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — in-flight HITL checkpoint writes outlive the deadline fence**
   `packages/host/src/hitl/adapters/run-executor.ts:48`
   Replace the pre-call-only Boolean fence with persistence-bound execution authorization. A timeout must revoke the execution generation at the durable commit seam, so an update admitted before the deadline cannot commit afterward. Preserve the hard slice bound and the existing run lease as the outer ownership fence. Add a deterministic delayed-write regression proving that a write started before timeout cannot alter the durable checkpoint after timeout terminalization.

2. **`silent-failure-hunter-1` — failed `UNWATCH` cleanup poisons a shared Redis connection silently**
   `packages/host/src/adapters/redis-connectivity.ts:87`
   Preserve both the primary transaction error and the cleanup failure in the typed `redis-unavailable` diagnostic, mark the optimistic-transaction capability poisoned, and reject later WATCH transactions without reusing uncertain connection state. Add regressions for combined diagnostics and fail-closed subsequent transactions.

3. **`silent-failure-hunter-2` — shared hard-deadline helper swallows late rejections**
   `packages/host/src/adapters/settle-before-deadline.ts:35`
   Deepen the helper with explicit, non-throwing diagnostic callbacks for late operation rejection and timeout-cancellation failure. Thread structured run/DAG context from the host HTTP and HITL callers. Add regressions proving the original timeout outcome remains authoritative even when the late operation or diagnostic transport fails.

4. **`silent-failure-hunter-3` — customer-summary hard deadline swallows late DAG failures**
   `apps/customer-summary/src/server.ts:131`
   Apply the same explicit diagnostic policy to the app-local deadline shell, logging the late failure with customer/run context through `reportWithoutThrowing`. Add a route regression where the response is already 504 and the delayed DAG failure is still observable.

## Advisory dispositions

### Accepted

- **`silent-failure-hunter-4` — timeout cancellation callback failures are invisible.** Sound and shares the critical deadline-helper seam. Route the caught callback failure through the new timeout-cancellation diagnostic without allowing it to replace hard settlement.
- **`pr-test-analyzer-1` — no late `onDecisionConsumed` fence regression.** Sound safety gap. Add an abort-insensitive HITL gate continuation that reaches decision consumption after timeout and prove the callback is fenced.
- **`type-design-analyzer-1` — `LlmMeter` exposes a runtime-mutable `Map`.** Sound immutability breach with a local fix. Return a frozen runtime `ReadonlyMap` facade from meter constructors/transitions and add a mutation-bypass regression.
- **`comment-analyzer-1` — OAuth provider header is password-grant-only.** Correct the module description to cover generic form-encoded grants and optional resource-owner credentials.
- **`comment-analyzer-2` — freshness corruption comment says “BOTH” methods.** Correct it to all three freshness-index methods.
- **`comment-analyzer-3` — freshness clock comment omits `hasRecordedWrite`.** Name all TTL/read clock consumers and remove the stale two-site wording.
- **`code-simplifier-1` — batch freshness check sorts unused witness events.** Keep the public signature but sort/scan write events directly; the witness argument remains forensic input compatibility and is explicitly unused.
- **`code-simplifier-2` — exported `isRateLimit` is dead after shared status classification.** Remove the predicate, its stale commentary, and dedicated tests; retain behavior coverage through `classifyLlmError`.
- **`code-simplifier-3` — repeated executor-owned non-terminal match arms.** Combine identical `ts-pattern` arms while leaving `retrying-hook` node attribution separate.
- **`code-simplifier-4` — `createFileCheckpointer` JSDoc is orphaned.** Move the factory contract directly above the factory declaration.

### Deferred

- **`type-design-analyzer-2` — `deregisteredAt` is an unbranded number.** The claim is sound, but a complete fix is not local: the timestamp crosses registry transition, Redis hydration/serialization, grace-window arithmetic, admin fixtures, and purge APIs. None of those paths is part of a surviving defect, and branding only the field would create casts rather than a parsed invariant. Defer to a bounded tenant-lifecycle timestamp migration that introduces one smart constructor and retypes every producer/consumer together.

### Dismissed

None.

## Refuted critical findings audit

None. All four critical entries reached the panel threshold. `code-reviewer-1` was refuted by the reproduction lens because Redis WATCH serialization orders the current checkpoint and terminal metadata writes, but it was upheld by intent and security because authorization is still checked only before asynchronous persistence. The other three findings were upheld by all lenses. The authoritative panel outcomes and captured `refutation-slot:*` transcripts remain under the Review Run Directory.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `CONTEXT.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`
- `apps/customer-summary/src/server.ts`
- `apps/customer-summary/src/__tests__/server.test.ts`
- `packages/framework/src/dag-runtime/freshness-check.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/file/checkpointer.ts`
- `packages/framework/src/file/freshness-index.ts`
- `packages/framework/src/llm/llm-errors.ts`
- `packages/framework/src/__tests__/freshness-check.test.ts`
- `packages/framework/src/__tests__/llm-errors.test.ts`
- `packages/host/src/ports.ts`
- `packages/host/src/adapters/redis-connectivity.ts`
- `packages/host/src/adapters/settle-before-deadline.ts`
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
- `packages/host/src/domain/llm-meter.ts`
- `packages/host/src/__tests__/llm-meter.test.ts`
- `packages/host/src/http/handlers/run-dag.ts`
- `packages/host/src/__tests__/fixtures/host-boot-fakes.ts`
- `packages/host/src/__tests__/handlers/run-dag.test.ts`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/run-store-job.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-queue.test.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/http-auth/src/auth.ts`

All planned paths except one are inside the frozen review scope. The accepted `LlmMeter` mutation-bypass regression requires this remediation support path:

- `packages/host/src/__tests__/llm-meter.test.ts`

The first remediation registration omitted it and blocked without staging; the superseding registration included it explicitly.

## Validation evidence

- Pre-production-edit focused baseline: **250 tests passed / 0 failed** across 9 files.
- Post-implementation focused gate: **338 tests passed / 0 failed** across 11 files.
- Workspace typecheck: all 12 workspace packages passed.
- Workspace test: **6,174 tests passed / 0 failed** (plus the repository's environment-gated skips).
- Shipped-document links and `git diff --check`: passed.

## Validation commands

Baseline and focused regression gate:

```bash
bun test \
  apps/customer-summary/src/__tests__/server.test.ts \
  packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/llm-errors.test.ts \
  packages/host/src/adapters/__tests__/redis-connectivity.test.ts \
  packages/host/src/__tests__/llm-meter.test.ts \
  packages/host/src/__tests__/handlers/run-dag.test.ts \
  packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-executor.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-queue.test.ts \
  packages/host/src/hitl/__tests__/run-store-job.test.ts \
  packages/host/src/hitl/__tests__/service.test.ts
```

Focused typecheck:

```bash
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
bun run --filter @fuguejs/http-auth typecheck
bun run --filter @fuguejs/customer-summary typecheck
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
