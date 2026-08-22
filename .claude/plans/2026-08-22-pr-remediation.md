# PR remediation — 2026-08-22

- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-20260822-051625-f6-file-durable-runtime`
- **Frozen review scope:** the canonical `result.json` scope for that run (419 paths).
- **Source of remediation inputs:** the canonical review `result.json` only.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — `packages/host/src/hitl/adapters/run-store.ts:244`**: Redis run creation can return after a durable queued record has been partially persisted, leaving it without a wakeup.
   - Reorder the Redis create protocol so metadata publication is last: write the checkpoint and active-index intent first, then atomically publish metadata with `SET NX EX`. Unpublished checkpoint/index remnants are non-runnable and self-heal from the index; a visible queued run is therefore complete.
   - Add regression coverage for checkpoint, index, and metadata publication failures.

2. **`code-reviewer-2` — `packages/host/src/hitl/adapters/run-queue.ts:145`**: an expired worker can delete a successor worker's lock.
   - Make each lock lease carry a fresh ownership token and release only if the stored token still equals the holder's token. Extend the narrow Redis port with a compare-and-delete capability implemented atomically by the Redis adapter; preserve retry behavior and log typed release context.
   - Add lease-expiry/successor-lock regression coverage.

3. **`silent-failure-hunter-1` — `packages/framework/src/dag-runtime/node-span.ts:203`**: error handling can throw while rendering a hostile thrown value.
   - Use total `safeErrorMessage` and a new guarded `safeErrorStack` helper for every caught value in the failure path; secondary span/logger operations remain guarded.
   - Add hostile coercion and throwing-message/stack tests.

4. **`silent-failure-hunter-2` — `packages/framework/src/observer/buffered.ts:169`**: clock-failure handling can throw while rendering a hostile value.
   - Render caught values through total diagnostics and guard the dead-letter callback so a secondary failure cannot replace replay accounting.
   - Add hostile-clock and throwing-dead-letter tests.

5. **`comment-analyzer-1` — `packages/host/src/adapters/module-loader.ts:6`**: the loader's no-throw contract is violated by import-failure rendering.
   - Route import-failure message/stack extraction through the framework total diagnostic helpers; add a module fixture that rejects with a hostile value and assert `import-failed` rather than rejection.

6. **`architecture-tech-lead-1` — `packages/host/src/hitl/service.ts:135`**: durable runs/decisions are not guaranteed a server-owned wakeup recovery path after queue failure.
   - Add a `RunStorePort` active-run enumeration capability and a typed service reconciliation operation that attempts an idempotent wakeup for every durable non-terminal run.
   - Start reconciliation after the worker and repeat it at a bounded interval owned and cleared by host lifecycle. A failed immediate queue enqueue leaves an accepted durable run and is surfaced in logs; reconciliation, including after restart, owns eventual wakeup.
   - Add service, Redis-store, and host lifecycle coverage for immediate enqueue failure/recovery and reconciliation errors.

## Advisory dispositions

| ID | Disposition | Reason / planned action |
| --- | --- | --- |
| `silent-failure-hunter-3` | accepted | A dead-letter sink is a secondary diagnostic seam and must not abort replay accounting; guard it and log both failures. |
| `silent-failure-hunter-4` | accepted | Included with the token-ownership lock fix; warning fields will include the typed Redis failure kind. |
| `pr-test-analyzer-1` | accepted | Regression coverage is required for the durable reconciliation path: a stored decision whose direct enqueue fails must resume and complete after reconciliation. |
| `type-design-analyzer-1` | dismissed | `rawCheckpointJson` is intentionally a test-visible boundary constructor; production creation still occurs only in `journal.ts`, and all current external use is test-only direct-module import. Removing its barrel export would not make the brand opaque to TypeScript callers and would be API churn without enforcement leverage. |
| `comment-analyzer-2` | accepted | Correct the soft-ceiling documentation: overshoot is bounded by concurrent starters, not a single event loop. |
| `comment-analyzer-3` | accepted | The documented `tryCatch` promise is sound only with total default error construction; use `safeErrorMessage` and add hostile-value pins for sync and async variants. |
| `architecture-tech-lead-2` | accepted | Replace check-then-write with a `resolvePending` decision-store command using Redis `SET NX EX`, returning a discriminated accepted/already-resolved/not-pending outcome. Preserve first-writer action and only enqueue after accepted or already-resolved durable state. |
| `code-simplifier-1` | accepted | After a green baseline, replace the nested `saveOpts` ternary with explicit union-case branches and run its covering test after that single distill move. |

## Refuted-critical audit

None. The Refutation Panel retained all six critical findings, each upheld by reproduction, intent, and security lenses.

## Expected touched paths

- `packages/framework/src/types/safe-error.ts`, `packages/framework/src/types/result.ts`, `packages/framework/src/dag-runtime/node-span.ts`, `packages/framework/src/observer/buffered.ts`, `packages/framework/src/file/checkpointer-codec.ts`
- their focused framework tests
- `packages/host/src/adapters/module-loader.ts`, `packages/host/src/hitl/{ports.ts,service.ts}`, `packages/host/src/hitl/adapters/{run-store.ts,run-queue.ts,decision-store.ts}`, `packages/host/src/{host.ts,ports.ts}`
- their focused host tests and this plan.

## Validation

1. Focused framework tests: result, node-span/executor, buffered observer, file checkpointer codec.
2. Focused host tests: module loader, HITL service, Redis stores, run queue, host lifecycle/wiring.
3. `bun run typecheck`
4. `bun run test`
5. Distill apply-mode: run baseline first, make only the accepted `saveOpts` flattening move, rerun its covering test.
