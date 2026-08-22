# PR Remediation — 2026-08-22

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/2026-08-22T150849Z-01a02a04-standalone-review`
- Canonical result: `result.json` digest `b41fb3a2a37ee4a30de2e2a920ddd57ee93b7da42bd992fbd57f7bd06915ca44`
- Frozen review scope: the 433 paths enumerated by canonical `result.json.scope`
- Baseline: relevant framework/app/host suites green (218 tests); workspace typecheck green

## Exact remediation scope

Planned production paths:

- `packages/framework/src/observer/dispatch.ts`
- `packages/framework/src/tracing/composite-exporter.ts`
- `packages/framework/src/shared/retry-async.ts`
- `packages/framework/src/types/errors.ts`
- `apps/customer-summary/src/observability-composition.ts`
- `packages/host/src/domain/circuit-breaker.ts`
- `packages/host/src/hitl/types.ts`
- `packages/host/src/hitl/ports.ts`
- `packages/host/src/hitl/run-store-job.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/decision-store.ts`
- `packages/host/src/hitl/adapters/run-queue.ts`
- `packages/host/src/hitl/service.ts`
- `packages/host/src/http/handlers/runs.ts`
- `docs/adr/0060-hitl-suspend-resume-primitive.md`

Planned regression paths:

- `packages/framework/src/__tests__/observer-property.test.ts`
- `packages/framework/src/tracing/composite-exporter.test.ts`
- `apps/customer-summary/src/__tests__/observability-composition.test.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`
- `packages/host/src/hitl/__tests__/service.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-queue.test.ts`
- `packages/host/src/__tests__/handlers/hitl-http.test.ts`

This plan path is itself in the frozen review scope.

## Mandatory surviving critical findings

### C1 — `silent-failure-hunter-1`: observer isolation can be broken by diagnostics

`packages/framework/src/observer/dispatch.ts:45`

Fix: centralize observer-failure rendering through total `safeErrorMessage` / `safeErrorStack` and route framework logging through a non-throwing helper. Preserve strict-mode semantics while ensuring production sync failures, async rejections, hostile caught values, and hostile logger transports cannot escape the observer boundary.

Regression: synchronous throw and asynchronous rejection with a throwing framework logger; hostile rejection rendering remains total.

### C2 — `silent-failure-hunter-2`: composite exporter can wedge or reject when logging throws

`packages/framework/src/tracing/composite-exporter.ts:73`

Fix: make every export/lifecycle/post-settlement diagnostic best-effort and non-throwing without changing settlement accounting, rate limiting, aggregate results, or lifecycle no-reject contracts.

Regression: failed result, synchronous throw, async callback failure, `forceFlush`, and `shutdown` all settle under a throwing framework logger.

### C3 — `type-design-analyzer-1`: persisted failed status admits malformed `FrameworkError`

`packages/host/src/hitl/adapters/run-store.ts:65`

Fix: replace the discriminant-only persisted error schema with an exhaustive structural `FrameworkError` schema that requires every variant's mandatory fields while preserving optional fields and the existing closed discriminant. Add corrupt-metadata pins for missing required fields and round-trip pins for representative valid variants.

Panel note: the intent lens argued discriminant-only forward compatibility, but reproduction and blast-radius upheld the finding; canonical adjudication requires the strict parse boundary.

### C4 — `comment-analyzer-1`: DecisionStore key-layout comment is stale

`packages/host/src/hitl/adapters/decision-store.ts:11`

Fix: document `preparePending` and the two persisted pending-marker states (`notification-required:<marker>`, `notified:<marker>`) exactly.

### C5/C6 — `comment-analyzer-2` and `architecture-tech-lead-1`: checkpoint persistence failure is falsely documented and terminalized

`packages/host/src/hitl/run-store-job.ts:10,91`

Fix: deepen the run-store JobLike seam so it records the typed `HostError` produced by `saveCheckpoint` before throwing through the framework's required `JobLike` shell. Thread a read-only checkpoint-failure channel through `RunExecutionRequest`; the production executor returns that typed infrastructure failure on `Result.err`, and `processRun` returns it to the worker for queue retry instead of writing terminal `failed`. The local checkpoint remains at the last durable state.

Regression: JobLike records the typed failure without advancing, production executor returns the original `redis-unavailable`, and service leaves the run non-terminal and returns `err` for retry.

## Advisory dispositions

### Accepted

1. `code-reviewer-1` — use the existing non-throwing framework-log helper in `FoundryRunSummaryObserver.evictStale`; add throwing-logger eviction regression.
2. `code-reviewer-2` — duplicate surface of C2; accepted and fully covered by the mandatory composite-exporter fix/tests.
3. `pr-test-analyzer-1` — make lock-contention logging non-throwing and prove deferred enqueue still occurs under a throwing logger.
4. `type-design-analyzer-2` — carry `NonEmptyString` in host suspended statuses/outcomes and parse persisted prompts with the framework smart constructor so an empty human gate is unrepresentable.
5. `comment-analyzer-3` — correct `retryAsync` JSDoc: existing `Error` is rethrown; non-Error values are wrapped.
6. `comment-analyzer-4` — describe the circuit threshold as the maximum failures allowed; opening occurs on the next failure.
7. `code-simplifier-1` — extract the shared run-id parsing, store lookup, not-found/error mapping, and authorization precondition used by both run handlers.
8. `code-simplifier-3` — remove ephemeral standalone-review provenance from the framework error-kind invariant comment while retaining the durable compile-coverage rationale.

### Deferred

1. `architecture-tech-lead-2` — the in-memory RunStore cannot truthfully verify ownership from `RunLease` alone because lease authority lives in the queue/Redis lock. Correct parity requires a shared lease-registry seam used by queue and store, not a fake-only token heuristic. Defer to a dedicated deepening that can redesign both adapters and their acquisition API without weakening the opaque capability contract; production Redis fencing already has stale-owner parity tests.
2. `code-simplifier-2` — the duplication is real, but the supervisor adapter multiplexes connectivity, data, pub/sub, privileged ACL, and audit-stream capabilities while the worker adapter owns only data connectivity. A safe extraction changes the ioredis composition seam and needs focused integration coverage for both binaries; defer rather than mix a high-blast-radius interface refactor into correctness remediation.

### Dismissed

1. `type-design-analyzer-3` — `HITL_LOCK_TTL_SEC` is parsed by `domain/config.ts` as an integer `>= 1` before the sole production call to `createRunQueue`; contention delay and attempt count are private defaults with no untrusted production input. Branded constructor types would not close a reachable invalid production state in the reviewed code.

## Refuted critical audit

Canonical `result.json.refuted_critical_findings` is empty. All six critical findings survived the registered panel. The panel's single contrary lens on C3 is retained above; it did not meet the two-lens refutation threshold.

## Validation

1. Focused regression suites:
   - `bun test packages/framework/src/__tests__/observer-property.test.ts packages/framework/src/tracing/composite-exporter.test.ts packages/framework/src/__tests__/retry-async.test.ts`
   - `bun test apps/customer-summary/src/__tests__/observability-composition.test.ts`
   - `bun test packages/host/src/hitl/__tests__/run-store-job.test.ts packages/host/src/hitl/adapters/__tests__/run-executor.test.ts packages/host/src/hitl/__tests__/service.test.ts packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/host/src/hitl/adapters/__tests__/run-queue.test.ts packages/host/src/__tests__/handlers/hitl-http.test.ts packages/host/src/__tests__/circuit-breaker.test.ts`
2. Workspace typecheck: `bun run typecheck`
3. Full workspace tests: `bun test`
4. Documentation links: `bun run check:docs`
5. Registered remediation validation and exact-index installation through the orchestration façade.
