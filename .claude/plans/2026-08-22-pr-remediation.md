# PR Remediation Plan — Adjudicated Standalone Review

- **Date:** 2026-08-22
- **Branch:** `feat/f6-file-durable-runtime`
- **Review authority:** `.claude/reviews/review-and-fix-runs/standalone-review-20260822T141150Z/result.json`
- **Review result digest:** `583c0f8503bc89cc633e233ed164dc6e074bc258765f236dfcc8ab4da29eff6c`
- **Frozen review scope:** the exact 431-path `result.json.scope` array. The plan itself is already in scope. `docs/adr/0060-hitl-suspend-resume-primitive.md` is the sole required support path outside that scope because the critical fixes supersede its accepted best-effort status-write and notification-delivery text.
- **Baseline commit:** `7055231`

## Architectural approach

The durable HITL worker will carry an opaque, run-bound lease capability from queue acquisition through the service, checkpoint job, executor, and run store. Redis checkpoint/status writes will atomically compare the live lock token before committing. Lease-renewal failure will abort the execution slice immediately, and stale workers will be unable to persist checkpoints or lifecycle outcomes even if user code is slow to observe cancellation.

HITL Redis transaction requirements will be parsed once at host composition into a narrow required-capability type. Missing compare/transaction operations will therefore fail during composition, not during a worker slice. Human-review notification delivery will become durable state (`notification-required` versus `notified`) so failed deliveries retry without making an unresolvable gate or suppressing all future notification attempts.

## Mandatory surviving critical findings

### `code-reviewer-1` — BullMQ rejects the default queue name

**Evidence:** `packages/host/src/hitl/adapters/run-queue.ts:89` defaults to `fugue:${tenant}:hitl:runs`; BullMQ 5.76.10 rejects `:` in queue names.

**Fix:**
- Derive a colon-free tenant-qualified default queue name.
- Parse custom names at construction and reject empty/colon-containing values before backend construction.
- Add a regression that passes the derived name through the real BullMQ `Queue` constructor without requiring a live Redis operation.

### `code-reviewer-2` — decision lookup failure strands an unmarked run

**Evidence:** `human-review-hook.ts` returns `pending` on `getDecision` error before creating a pending marker or notification; reconciliation cannot wake an undecided suspended run and approval cannot resolve a missing marker.

**Fix:** Throw a retriable hook failure after total best-effort diagnostics. Never return `pending` unless the pending-review and notification-delivery invariants have been established.

### `code-reviewer-3` — failed first notification is never retried

**Evidence:** the pending marker remains after a notification error, so later dispatches see an existing marker and suppress delivery forever.

**Fix:** Replace the boolean first-park protocol with durable notification state. `preparePending` returns either `notification-required` with an opaque marker token or `notified`; successful delivery atomically transitions the matching marker to `notified`. Delivery/commit failure throws, leaving `notification-required` retriable. Add failure-then-success and successful-dedup tests.

### `code-reviewer-4` and `silent-failure-hunter-2` — lease loss does not stop execution

**Evidence:** renewal failure is only inspected after `processRun` resolves, allowing the expired owner to continue while a successor acquires the run.

**Fix:**
- Create an `AbortController` per acquired lease and abort immediately on `ok(false)`, typed renewal error, or thrown renewal failure.
- Pass the lease signal through `processRun` and `RunExecutionRequest` to the executor’s node context, composed with the slice timeout.
- Check cancellation before every durable fold and make checkpoint/status writes ownership-fenced.
- Render/log renewal failures through total, best-effort diagnostics.
- Add active-slice tests for false/error/throw renewal outcomes proving immediate abort and queue retry.

### `silent-failure-hunter-1` — failed running-status write is ignored

**Evidence:** `processRun` logs `setStatus(running)` failure and executes side-effecting DAG work anyway.

**Fix:** Make the ownership-fenced running transition mandatory and return its typed error before constructing/executing the slice. Add a test proving executor invocation remains zero.

### `pr-test-analyzer-1` — renewal failure branches lack regression coverage

**Fix:** Add deterministic async tests for `compareAndExpire` returning `ok(false)`, returning `err`, and throwing while `processRun` is pending. Assert the lease signal aborts, the job rejects for retry, and release remains ownership-checked.

### `type-design-analyzer-1` — status writes carry no owner token

**Evidence:** `RunStorePort.setStatus(runId, status)` cannot distinguish the active owner from an expired worker.

**Fix:**
- Introduce an opaque `RunLease` capability containing the run identity, random owner token, and cancellation signal.
- Change worker-only checkpoint/status methods to accept the lease instead of a free run id.
- Implement Redis writes with an atomic compare-live-token-and-set transaction.
- Add stale-owner adapter tests proving a successor token prevents checkpoint and terminal writes.

### `comment-analyzer-1` — hostile clock diagnostics can escape

**Evidence:** `readClock` catches the clock but then performs unsafe coercion and unguarded replaceable logger calls.

**Fix:** Use total `safeErrorMessage` rendering and a non-throwing framework-logger helper. Add a hostile thrown-value plus throwing-logger regression for `observe` and `evictStale`.

## Advisory dispositions

### Accepted — `pr-test-analyzer-2`

Add the missing negative reconciliation test: a suspended run with no durable decision is skipped and not enqueued. This is low-risk and directly protects queue-churn behavior touched by the critical hook fixes.

### Accepted — `comment-analyzer-2`

Update `startRun` documentation from “persist + enqueue” to truthful “persist + request wakeup; reconciliation retries wakeup failures.” This documents existing accepted durability semantics.

### Accepted — `comment-analyzer-3`

Correct the observability test by making the clock hostile before the assertion and pinning the intended no-throw/drop behavior. The current comment and setup disagree.

### Accepted — `architecture-tech-lead-1`

Introduce a narrow required HITL Redis transaction-capability type and parse the broad optional `RedisPort` once during host composition. Queue, decision, and run-store adapters receive only a construction-proven capability; missing renewal/decision/fenced-write operations fail before worker startup. This is practical in scope and directly supports the mandatory invariants.

### Accepted — `code-simplifier-1`

Extract the duplicated run-status timestamp parsing/error construction in `run-store.ts` into one file-local Result helper while modifying both status adapters for lease fencing.

### Accepted — `code-simplifier-2`

Precompute the optional actor patch once in `parseDecision` and reuse it in all successful `HumanAction` branches. This is behavior-preserving, local, and independently test-covered by the existing handler suite.

## Refuted critical audit

`result.json.refuted_critical_findings` is empty. The Refutation Panel upheld all nine critical findings (eight unanimously across reproduction/intent/security; the test-gap finding was upheld by reproduction/security and uncertain only under intent). No refuted finding will be fixed.

## Planned files

- `.claude/plans/2026-08-22-pr-remediation.md`
- `docs/adr/0060-hitl-suspend-resume-primitive.md` (registered remediation support path)
- `packages/host/package.json`, `bun.lock`
- `packages/host/src/ports.ts`
- `packages/host/src/adapters/redis-connectivity.ts`
- `packages/host/src/main-supervisor.ts`
- `CONTEXT.md`
- `packages/host/src/domain/host-error.ts`
- `packages/host/src/host.ts`
- `packages/host/src/__tests__/fixtures/host-boot-fakes.ts`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/run-store-job.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/hitl/human-review-hook.ts`
- `packages/host/src/hitl/adapters/run-queue.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/decision-store.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- relevant existing HITL adapter/service/hook/executor/job tests
- `packages/host/src/http/handlers/runs.ts`, `packages/host/src/http/middleware/error-handler.ts`, and existing handler tests
- `apps/customer-summary/src/observability-composition.ts`
- `apps/customer-summary/src/__tests__/observability-composition.test.ts`

All listed paths belong to the frozen review scope except the explicitly registered ADR-0060 support path above.

## Validation

1. Establish green baseline before implementation/distillation:
   - `bun test packages/host/src/hitl/__tests__/human-review-hook.test.ts packages/host/src/hitl/__tests__/run-store-job.test.ts packages/host/src/hitl/__tests__/service.test.ts packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/host/src/hitl/adapters/__tests__/run-executor.test.ts packages/host/src/hitl/adapters/__tests__/run-queue.test.ts`
   - `bun test apps/customer-summary/src/__tests__/observability-composition.test.ts`
2. Focused tests after each coherent move.
3. `bun run --filter @fuguejs/host typecheck`
4. `bun run --filter @fuguejs/customer-summary typecheck`
5. `bun run --filter @fuguejs/host test`
6. `bun run --filter customer-summary test`
7. `bun run typecheck`
8. `bun test`
9. `bun scripts/check-doc-links.ts`
10. Distill apply-mode pass only after the affected baseline is green; rerun covering tests after each simplification.
11. Registered remediation must validate and atomically install the exact authorized index before commit/push.
