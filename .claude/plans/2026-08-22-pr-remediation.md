# PR remediation — 2026-08-22

- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-review-20260822T060329Z`
- **Canonical result:** `result.json`, SHA-256 `9bb977ae232648adc669f7d3ed46712821fc3e82226098c7a560c3f25f72ae58`
- **Frozen review scope:** the 428 paths enumerated by that canonical result. Remediation reads findings only from that result.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — `packages/host/src/hitl/service.ts:298`**: reconciliation re-enqueues undecided suspended runs.
   - Reconcile queued/running runs directly; before waking a suspended run, read the durable decision for its suspended gate and wake only when it exists. Preserve typed errors and reconcile the decision-bearing suspended run after a failed direct wakeup.
   - Add lifecycle tests proving undecided parked runs are not churned while a stored decision remains recoverable.

2. **`code-reviewer-2` — `packages/host/src/hitl/adapters/run-queue.ts:116`**: a fixed lease can expire while a slice runs.
   - Add an ownership-checked lease-renewal operation to the narrow Redis port and concrete Redis adapters. Renew the acquired lease for the full processing interval; a failed/changed lease fails the worker job rather than allowing an unowned slice to continue. Retain ownership-checked release.
   - Add deterministic queue-adapter tests for renewal, lost ownership, and renewal failure.

3. **`code-reviewer-3` — `packages/host/src/hitl/adapters/decision-store.ts:90`**: pending verification and decision creation are not atomic.
   - Add a narrow Redis conditional-resolution operation implemented with retrying `WATCH`/`MULTI`/`EXEC`, checking the pending key and creating the first decision in one transaction. Return the existing `DecisionResolution` union, including `not-pending`, without a stale acceptance window.
   - Add deterministic interleaving coverage for clear-versus-resolve and preserve first-writer semantics.

4. **`code-reviewer-4`, `silent-failure-hunter-1`, and `code-simplifier-1` — `packages/host/src/hitl/adapters/run-queue.ts:97`**: enqueue diagnostics can throw.
   - Replace ad-hoc caught-value rendering with framework `safeErrorMessage`, retaining the Result-only queue-port contract.
   - Add hostile rejected-value adapter coverage.

5. **`silent-failure-hunter-2` — `packages/host/src/hitl/adapters/webhook-notifier.ts:96`**: webhook notifier diagnostic rendering can throw.
   - Use `safeErrorMessage` in both card-build and transport failure mappings; add hostile thrown-value coverage for both paths.

6. **`silent-failure-hunter-3` — `packages/host/src/hitl/adapters/bot/notifier.ts:57`**: Bot Framework card-build diagnostic rendering can throw.
   - Use `safeErrorMessage` in the guarded card-build mapping and add hostile thrown-value coverage.

7. **`comment-analyzer-1` — `packages/host/src/hitl/ports.ts:169`**: executor-port documentation conflicts with its failed-outcome contract.
   - Correct the public comment: framework/context-build faults that occur after execution starts are `ok({ kind: "failed" })`; reserve `Err` for failure before the slice can execute.

8. **`architecture-tech-lead-1` — `packages/adapter-pg/src/index.ts:336`**: default fake-Pg routing can accept SQL/parameter mismatches.
   - Make fake routes exact SQL plus parameter matching by default. Preserve broad prefix routing only behind explicit opt-in route syntax, update the public contract, and migrate current tests/routes to exact fixtures.
   - Add tests that wrong SQL and wrong bindings do not consume an exact canned route.

## Advisory dispositions

| ID | Disposition | Reason / action |
| --- | --- | --- |
| `silent-failure-hunter-4` | accepted | Include `formatHostError`/operation context in parked-without-notice logs so notification failures are actionable. |
| `silent-failure-hunter-5` | accepted | Include formatted HostError context in initial, resume, and reconciliation wakeup-failure logs. |
| `pr-test-analyzer-1` | accepted | Required regression coverage for queue-backend enqueue throws, including the hostile rejection path mandated above. |
| `pr-test-analyzer-2` | accepted | Required regression coverage that deferred-enqueue failure throws, preserving queue retry rather than silently dropping a wakeup. |
| `type-design-analyzer-1` | dismissed | ADR-0078 deliberately defines single writer as a consumer lifecycle/deployment contract; a directory string alone cannot make process-wide writer uniqueness representable. The append lock is the enforceable shared mechanism, and a nominal wrapper would add no enforcement leverage. |
| `type-design-analyzer-2` | accepted | Parse a clock result into a finite branded HITL timestamp before it enters a `RunRecord`, use that domain type for record timestamps, and add invalid-clock coverage. |
| `comment-analyzer-2` | accepted | Qualify the queue single-flight documentation with ownership-renewed lease semantics; it must not promise concurrency exclusion beyond the verified lease. |
| `comment-analyzer-3` | accepted | Correct `countActiveRuns` documentation to describe conservative counting of unreadable/checkpoint-only evidence. |
| `architecture-tech-lead-2` | deferred | Preserving the warning while removing global I/O from a transform needs an observer/domain-event output seam; the present transform Result has no such channel. Removing the warning would be behavior loss, and widening the application observability contract is not necessary to remediate a durable-runtime review. |

## Refuted-critical audit

`result.json.refuted_critical_findings` is empty. The panel recorded no refuted critical entry. Two surviving findings had an intent-lens objection but still met the two-lens survival threshold: `code-reviewer-1` (the existing all-active reconciliation intent) and `architecture-tech-lead-1` (the fake's documented canned-response intent). Neither is treated as refuted or skipped.

## Planned paths

- `packages/host/src/{ports.ts,adapters/redis-connectivity.ts,main.ts,main-supervisor.ts}` and Redis-port fakes/tests
- `packages/host/src/hitl/{ports.ts,service.ts,types.ts,human-review-hook.ts}` and focused tests
- `packages/host/src/hitl/adapters/{run-queue.ts,decision-store.ts,webhook-notifier.ts,run-store.ts,bot/notifier.ts}` and focused tests
- `packages/adapter-pg/src/{index.ts,__tests__/pg-adapter.test.ts}`
- this plan

## Validation

1. Focused host tests: `run-queue`, `redis-stores`, `webhook-notifier`, Bot notifier, and HITL service.
2. Focused PG adapter tests.
3. `bun run typecheck`.
4. `bun run test`.
5. Distill apply-mode after a green baseline: reuse existing total diagnostics and avoid new wrappers; rerun focused coverage after each applied simplification.
