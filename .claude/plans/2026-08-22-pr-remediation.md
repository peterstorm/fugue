# PR remediation — 2026-08-22

- **Branch:** `feat/f6-file-durable-runtime`
- **Review run:** `.claude/reviews/review-and-fix-runs/standalone-review-20260822T070500Z-3598828`
- **Canonical result:** `result.json`, SHA-256 `99753f949f356028d5f240f3aa05357f20b7ffbc02fbcb67219a7b6b9c68c4ad`
- **Frozen review scope:** the exact ordered `scope` array in the canonical result (430 paths). Remediation reads findings only from that immutable result.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — `packages/host/src/hitl/types.ts:36`**: branded `RunTimestampMs` has unconverted timestamp producers.
   - Parse every clock result through `tryRunTimestampMs` at each record/meta construction and update fixture builders to mint branded timestamps; propagate invalid-clock failures through existing typed boundaries.

2. **`code-reviewer-2` — `packages/host/src/hitl/__tests__/human-review-hook.test.ts:104`**: tests assert obsolete fail-open pending-marker handling.
   - Update the marker-failure tests for the implemented fail-closed contract: reject the hook call and prove no notification is delivered, including when diagnostic logging is hostile.

3. **`silent-failure-hunter-1` and `pr-test-analyzer-1` — `packages/host/src/hitl/adapters/run-queue.ts:140`**: lease-renewal capability validation and renewal failures can leak an acquired lock.
   - Validate required renewal/release capabilities before acquisition; make the entire owned interval release-safe; ensure renewal failures cannot prevent token-validated release. Add deterministic absent, rejected, and lost-ownership renewal tests.

4. **`pr-test-analyzer-2` — `packages/host/src/hitl/adapters/run-queue.ts:78`**: a shared queue and bare `RunId` trigger permit cross-tenant wakeups.
   - Make enqueue and worker consumption tenant-qualified and verify the trigger tenant matches the worker tenant before processing. Add a deterministic cross-tenant rejection/isolation test.

5. **`pr-test-analyzer-3` — `packages/framework/src/queue-bullmq/adapter.ts:31`**: Redis URL normalization loses credentials, database, and TLS semantics.
   - Preserve supported Redis URL connection semantics when constructing ioredis/BullMQ connections and add authenticated/database-selected/`rediss` regression cases.

6. **`pr-test-analyzer-4` — `packages/framework/src/tracing/composite-exporter.ts:160`**: exporter catch paths can throw while coercing hostile thrown values.
   - Replace unsafe message/stack coercion with total safe-error helpers in export, flush, and shutdown paths; add hostile thrown-value coverage for each non-throwing contract.

7. **`type-design-analyzer-1` — `packages/host/src/hitl/ports.ts:45`**: terminal writes are not fenced by lease ownership.
   - Introduce an opaque ownership/fencing capability minted only by successful lease acquisition and require it for run-store mutations performed by queue execution. Carry the capability through the executor seam and test that a stale worker cannot settle after ownership loss.

8. **`comment-analyzer-1` — `packages/host/src/hitl/adapters/run-queue.ts:9`**: the single-flight comment says the opposite of the lock invariant.
   - Correct the comment to state that valid ownership prevents concurrent execution.

9. **`architecture-tech-lead-1` — `packages/framework/src/dag-runtime/executor.ts:116`**: human-review hook exception normalization is not total.
   - Use the existing safe-error helpers when constructing the typed node-failure and add a hostile thrown-value executor regression test.

## Advisory dispositions

| ID | Disposition | Reason / action |
| --- | --- | --- |
| `silent-failure-hunter-2` | accepted | A failed durable create must compensate checkpoint/active-index state to avoid quota exhaustion; add compensation and failure-path tests. |
| `pr-test-analyzer-5` | accepted | It duplicates surviving `code-reviewer-2` and will be satisfied by the same fail-closed regression coverage. |
| `type-design-analyzer-2` | accepted | Narrow required Redis capabilities make the lease and decision invariants type-visible; migrate HITL adapter dependencies to the narrower ports. |
| `architecture-tech-lead-2` | deferred | Extracting the summary route is a broad orchestration redesign unrelated to the adjudicated durability defects; preserve behavior and record the specific seam opportunity. |
| `code-simplifier-1` | accepted | Replace the nested checkpoint node-id ternary with a named guard/helper while retaining its three distinct cases. |
| `code-simplifier-2` | accepted | Consolidate repeated test infrastructure through a local overrideable fixture factory without changing test semantics. |
| `code-simplifier-3` | accepted | Centralize HITL safe logging in a private helper so the diagnostics-must-not-throw invariant has one implementation. |

## Refuted-critical audit

`result.json.refuted_critical_findings` is empty; no finding is exempt from remediation. The panel recorded intent-lens objections to surviving `code-reviewer-2` and `pr-test-analyzer-3`, but both passed the two-lens survival threshold and remain mandatory.

## Planned paths

- `packages/host/src/{ports.ts,__tests__/node-context-factory.test.ts}` and focused Redis/HITL fakes
- `packages/host/src/hitl/{ports.ts,types.ts,human-review-hook.ts,safe-logging.ts,__tests__/human-review-hook.test.ts}`
- `packages/host/src/hitl/adapters/{run-queue.ts,run-store.ts,run-executor.ts,__tests__/run-queue.test.ts,__tests__/redis-stores.test.ts}`
- `packages/framework/src/{dag-runtime/executor.ts,tracing/composite-exporter.ts,queue-bullmq/adapter.ts,types/error-factories.ts}` and their focused tests
- this plan

## Validation

1. Focused framework queue, tracing, executor, and error-factory tests.
2. Focused host HITL queue, Redis-store, executor, and human-review-hook tests.
3. `bun run typecheck`.
4. `bun run test`.
5. Distill apply-mode after a green baseline, rerunning focused coverage after every applied simplification.
