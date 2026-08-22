# PR Remediation Plan — 2026-08-22

## Authority

- Branch: `feat/f6-file-durable-runtime`
- Review run: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T161223Z`
- Canonical result: `.claude/reviews/review-and-fix-runs/standalone-review-20260822T161223Z/result.json`
- Frozen review scope: the exact 433-path `result.json.scope` array.
- Planned remediation paths inside that scope:
  - `.claude/plans/2026-08-22-pr-remediation.md`
  - `docs/adr/0060-hitl-suspend-resume-primitive.md`
  - `apps/customer-summary/src/server.ts`
  - `apps/customer-summary/src/__tests__/server.test.ts`
  - `packages/adapter-ms-graph/src/path-resolving.ts`
  - `packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts`
  - `packages/adapter-pg/src/__tests__/pg-adapter.test.ts`
  - `packages/framework/src/__tests__/cli/cli.test.ts`
  - `packages/framework/src/__tests__/cli/new.test.ts`
  - `packages/framework/src/__tests__/cli/visualize.test.ts`
  - `packages/framework/src/file/job.ts`
  - `packages/framework/src/file/journal.ts`
  - `packages/host/src/adapters/redis-connectivity.ts`
  - `packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
  - `packages/host/src/hitl/adapters/decision-store.ts`
  - `packages/host/src/hitl/adapters/run-executor.ts`
  - `packages/host/src/hitl/adapters/run-queue.ts`
  - `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
  - `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
  - `packages/host/src/hitl/ports.ts`
  - `packages/host/src/hitl/service.ts`
  - `packages/host/src/hitl/__tests__/service.test.ts`
  - `packages/host/src/ports.ts`
  - `packages/http-auth/src/index.ts`
- Required support paths outside frozen scope:
  - `packages/framework/src/__tests__/cli/_run-bin.ts` — shared subprocess fixture accepted from advisory `code-simplifier-3`.
  - `packages/framework/src/tracing/azure-monitor-exporter.ts` — package-build validation support; rename the ESM-safe loader binding that collides with TypeScript's CommonJS-reserved `require` identifier.

## Baseline

The targeted 14-file regression suite was green before remediation: **407 pass, 0 fail**.

## Surviving critical findings — mandatory

### `code-reviewer-1` — atomic decision consumption

**Finding:** `DecisionStore.clear` can delete the pending marker and then fail deleting the decision, allowing a stale human action to resolve a later gate at the same `(runId, nodeId)`.

**Fix:** deepen the Redis port's existing `DEL` capability to accept a non-empty variadic key set and have `DecisionStore.clear` issue one atomic Redis `DEL pending decision` command. Update in-memory Redis fakes and add a regression proving the pair is submitted in one operation and no partial state is observable. Update ADR-0060 to replace the now-invalid tolerated-clear-failure text with the atomic-consumption invariant.

### `code-reviewer-2` — permanently missing DAG must settle

**Finding:** a DAG removed after durable run creation currently returns `dag-not-found` on the retryable host-error channel, leaving the run active and repeatedly reconcilable forever.

**Fix:** use the executor's existing typed channel split correctly: `seedCheckpoint` keeps unknown DAG as a request-time `HostError`, while `run` maps a DAG that disappeared after acceptance to `ok({ kind: "failed", error: non-retriable node-crash })`. The service then persists a terminal failed status and removes the run from the active index. Replace the old opposite assertion with production-executor and service regressions.

### `silent-failure-hunter-2` — corrupt checkpoint entries at app resume

**Finding:** the customer-summary resume handler ignores non-empty `corruptNodeAddresses` and resumes from a partial checkpoint.

**Fix:** after subject and DAG-identity checks, fail closed on any corrupt address, log the discriminated addresses, and return HTTP 500 without invoking the DAG. Add a Checkpointer fake regression that proves partial output is not resumed.

### `pr-test-analyzer-1` — Redis hostile thrown-value coverage

**Finding:** Redis adapter call sites are not pinned against revoked proxies or throwing accessors.

**Fix:** extend the fake client to throw arbitrary values and add boundary tests for a revoked proxy and a throwing `message` accessor, asserting typed `redis-unavailable` results and total diagnostics.

### `pr-test-analyzer-2` — PostgreSQL hostile thrown-value coverage

**Finding:** `mapPgError`, `createPgClient`, and `healthCheckWithTimeout` lack direct hostile-value regressions.

**Fix:** add revoked-proxy and throwing-accessor tests through all three public seams, asserting no rejection escapes and each boundary returns its documented typed result.

### `code-simplifier-1` — SharePoint path-resolution catch totality

**Finding:** token and request catch paths hand-roll `instanceof Error`/`String`, allowing hostile thrown values to escape the Result boundary.

**Fix:** reuse `safeErrorMessage` at both catches and add token-provider plus fetch regressions using hostile values.

## Advisory dispositions

### Accepted

1. **`code-reviewer-3`** — throwing logger after initial enqueue failure. Route service diagnostics through a non-throwing helper so a durable accepted run always returns its run ID.
2. **`pr-test-analyzer-3`** — missing empty/malformed `resume_run_id` tests. Add explicit ingress regressions returning 400.
3. **`pr-test-analyzer-4`** — missing throwing-logger HITL tests. Pin initial wakeup, decision wakeup, and reconciliation diagnostics so logger transport failure never changes the typed outcome.
4. **`comment-analyzer-1`** — run-queue header incorrectly says only run id. Correct it to “run id plus tenant context; never run state.”
5. **`comment-analyzer-2`** — service header implies guaranteed initial enqueue. Document durable acceptance plus best-effort direct wakeup and reconciliation.
6. **`comment-analyzer-3`** — file-job unchecked-body comment misstates the wrapping site. Distinguish factory-shell wrapping from method-local wrapping.
7. **`comment-analyzer-4`** — remove the ephemeral remediation-round tag from the journal checkpoint-brand documentation.
8. **`code-simplifier-2`** — remove the pass-through `describeError` helper and call `formatFrameworkError` directly.
9. **`code-simplifier-3`** — consolidate the identical CLI subprocess helper into `packages/framework/src/__tests__/cli/_run-bin.ts` and import it from the three suites.

### Deferred

1. **`type-design-analyzer-2`** — `RunStoreJobLike.data` exposes its in-memory envelope. Sound concern, but changing only this adapter would create a stronger snapshot contract than the shared `JobLike` interface and its other adapters. Defer to a coordinated JobLike-wide immutable-snapshot deepening with adapter-parity tests.
2. **`type-design-analyzer-3`** — `RunRecord.checkpoint` is a plain string. A brand added only at the field would lie at the Redis read boundary; a truthful fix requires a shared serialized-checkpoint codec/smart constructor used by seed, persistence parsing, and job construction. Defer to that dedicated interface redesign.

### Dismissed

1. **`silent-failure-hunter-3`** — namespaced cache writes returning `ok` on write failure. Dismiss: the adapter explicitly defines cache writes as best-effort graceful degradation; callers must not abort DAG execution for an optional cache population failure, and the failures are logged/escalated.
2. **`type-design-analyzer-1`** — exported `issueRunLease` permits minting by importers. Dismiss: the host package does not export this internal module publicly, and the constructor does not confer Redis ownership; every durable write atomically verifies the unpredictable live owner token, so a shape-minted lease cannot bypass the persistence fence.

## Refuted critical audit — never fix

### `silent-failure-hunter-1`

**Claim:** `startRun` returning success after direct enqueue failure hides an accepted run whose wakeup may be lost.

**Refutation evidence retained:**

- Reproduction lens: queue delivery is explicitly a wakeup optimization; the durable queued record remains in the active index, `reconcileActiveRuns` re-enqueues it, host lifecycle runs reconciliation immediately and periodically, and tests cover enqueue-failure and restart recovery.
- Intent lens: durable creation is the acceptance boundary. Returning the run id after a direct wakeup failure matches the documented eventual-delivery design rather than representing data loss.

No compensation/deletion behavior will be introduced. The accepted logger advisory only ensures diagnostics cannot prevent returning the authoritative accepted run id.

## Validation

1. Targeted regression suite:
   ```bash
   bun test packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts packages/host/src/hitl/adapters/__tests__/run-executor.test.ts packages/host/src/hitl/__tests__/service.test.ts packages/host/src/hitl/__tests__/human-review-hook.test.ts packages/host/src/adapters/__tests__/redis-connectivity.test.ts apps/customer-summary/src/__tests__/server.test.ts packages/adapter-pg/src/__tests__/pg-adapter.test.ts packages/adapter-ms-graph/src/__tests__/path-resolving.test.ts packages/http-auth/src/__tests__/index.test.ts packages/framework/src/__tests__/cli/cli.test.ts packages/framework/src/__tests__/cli/new.test.ts packages/framework/src/__tests__/cli/visualize.test.ts packages/framework/src/__tests__/file-job.test.ts packages/framework/src/__tests__/file-journal.test.ts
   ```
2. Full workspace typecheck: `bun run typecheck`
3. Full workspace tests: `bun run test`
4. Package builds for changed published adapters: `bun run --filter @fuguejs/pg build && bun run --filter @fuguejs/ms-graph build`
5. Documentation links: `bun run check:docs`
