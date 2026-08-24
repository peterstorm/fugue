# PR Remediation Plan — Adjudicated Standalone Review (round 42)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `e30023bbf7c8b9de8675c767749220b4699fd623`

**Exact scope:** all 483 paths in the canonical `result.json.scope` array

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260824T091728Z-442c98e92e78`

**Canonical result:** `<review-run>/result.json` (digest `12d58bce250585c85cac51f65db9ce1b316ad18fbff7ef9badb5a313d94e86af`, 41,953 bytes)

**Adjudication:** 7 reviewers → 5 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `security`) → **5 surviving / 0 refuted**; 9 advisories dispositioned independently below.

The canonical `result.json.scope` array is the exact frozen scope and sole path authority. No reviewer transcript or finding was reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — Redis freshness failure instrumentation can throw**
   `packages/framework/src/checkpoint/redis-freshness-index.ts:133`
   Render arbitrary non-`Error` Redis rejections with the total `safeErrorMessage` helper before storing `lastError`, preserving the original `cache-error` Result contract. Add regressions for hostile/non-coercible rejection values on both `recordWrite` and `findConflict`.

2. **`code-reviewer-2` — throwing framework logger can erase partial freshness progress**
   `packages/framework/src/dag-runtime/freshness-emission.ts:181`
   Route all subordinate freshness-emission diagnostics through the existing best-effort logging seam. Add regressions proving both conflict-check and record-write failures return `aborted`, preserve already-witnessed nodes, and cannot be replaced by a logger throw.

3. **`silent-failure-hunter-1` — malformed stored HITL checkpoint is silently treated as ordinary**
   `packages/host/src/hitl/adapters/run-store.ts:360`
   Parse all stored checkpoint bytes through the framework lossless decoder. Malformed/non-canonical bytes become a typed `internal-invariant-violated` error and emit a guarded corruption diagnostic carrying run context; valid ordinary checkpoint envelopes continue to pass through. Add direct-read and active-index regressions proving corruption is explicit while the conservative quota evidence remains fail-closed.

4. **`pr-test-analyzer-1` — RunLease authority test is vacuous after abort**
   `packages/host/src/hitl/adapters/__tests__/run-queue.test.ts:209`
   Assert copied and cross-authority leases are rejected while the original lease is still live, then separately assert abort invalidates the authentic lease. This pins the WeakMap authority invariant rather than only the abort guard.

5. **`comment-analyzer-1` — worker-registry logger throws contradict Result/best-effort contract**
   `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts:18`
   Add one local no-throw warning helper and route every mandatory-failure, corruption, probe, and prune warning through it. Render caught values with `safeErrorMessage`. Add regressions proving throwing loggers cannot replace typed Redis failures or stop best-effort reconciliation/pruning.

## Advisory dispositions

### Accepted

- **`code-reviewer-3` — `disconnectRedisQuietly` can replace startup failure while formatting cleanup error.** Sound boundary-totality defect with a small in-scope fix. Use total error rendering and guard the fallback diagnostic itself; add a hostile rejection regression.
- **`silent-failure-hunter-2` — run-store clock throws outside the Result port.** Sound typed-error defect. Guard the injected clock read and return `internal-invariant-violated` with a total diagnostic; add a Redis `setStatus` regression.
- **`pr-test-analyzer-2` — shared ioredis `setNxIfPresent` behavior is unpinned.** Sound concurrency-sensitive coverage gap. Extend the fake-client suite across `not-present`, `created`, `exists`, and WATCH-conflict retry outcomes.
- **`comment-analyzer-2` — shared Redis header says “both binaries” while listing three consumers.** Sound documentation defect. Rename the scope to shared Redis-using entrypoints.
- **`code-simplifier-1` — guardrail smoke setup is duplicated.** Sound, behavior-preserving, and local. Extract one case runner while keeping each case’s success logging explicit.
- **`code-simplifier-2` — run-executor tests duplicate Map-backed Redis fakes.** Sound and local. Parameterize the existing fake with an optional backing map and remove the duplicate implementation.

### Deferred

- **`architecture-tech-lead-1` — centralize no-throw semantics in the logger seam.** Deferred to a dedicated deepening: changing the host and framework logger contracts affects many contexts and callers. This remediation uses existing/local no-throw adapters without widening public interfaces.
- **`architecture-tech-lead-2` — extract the Redis run-publication protocol into a pure core.** Deferred to a focused protocol deepening. The current protocol is heavily covered and the advisory identifies testability/locality leverage, not demonstrated wrongness; restructuring it during correctness remediation would add disproportionate durability risk.
- **`code-simplifier-3` — share worker/tenant registry Redis fake cores.** Deferred to the same focused seam/deepening pass. The duplication crosses two exported subsystem fixtures and requires a module-placement/interface decision, which is outside behavior-preserving `distill` scope.

### Dismissed

None.

## Refuted critical findings audit

None. All five critical findings survived unanimously under reproduction, intent, and security. The authoritative panel outcomes and raw evidence remain in `result.json.panel.outcomes` and the three captured `refutation-slot:*` transcripts.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `apps/customer-summary/scripts/guardrail-smoke.ts`
- `packages/framework/src/checkpoint/redis-freshness-index.ts`
- `packages/framework/src/dag-runtime/freshness-emission.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/framework/src/__tests__/freshness-emission.test.ts`
- `packages/host/src/adapters/redis-connectivity.ts`
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-queue.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/supervisor/lifecycle/worker-registry-redis.ts`
- `packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts`

Every planned path is inside the frozen review scope; registered remediation therefore needs no support path beyond the plan itself, which is also in scope.

## Validation

Focused baseline and regression gates:

```bash
bun test packages/framework/src/__tests__/redis-freshness-index.test.ts \
  packages/framework/src/__tests__/freshness-emission.test.ts
bun test packages/host/src/adapters/__tests__/redis-connectivity.test.ts \
  packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-queue.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-executor.test.ts \
  packages/host/src/__tests__/supervisor/lifecycle/worker-registry-redis.test.ts
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
