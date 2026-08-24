# PR Remediation Plan — Adjudicated Standalone Review (round 51)

**Branch:** `feat/f6-file-durable-runtime`

**Review HEAD (frozen source):** `4f5cb7cb30e818932e4f3cef623b1147ea931b1b`

**Exact scope:** the complete canonical `result.json.scope` array: all 504 paths frozen by the engine.

**Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-review-20260824T181419Z-01a034fa`

**Canonical result:** `<review-run>/result.json` (digest `56b47410b8ce8706ccdcf047634254bce7355035beba235f8fa2062e7f9db273`, 40,625 bytes)

**Adjudication:** 7 reviewers → 2 critical findings → registered 3-lens Refutation Panel (`reproduction`, `intent`, `blast-radius`) → **2 surviving / 0 refuted**; 11 advisories dispositioned independently below.

The canonical `result.json` is the sole remediation authority. Findings, scope, and panel outcomes were not reconstructed by the parent.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — throwing metering diagnostics replace successful LLM outcomes**
   `packages/host/src/adapters/metered-llm.ts:142`
   Route every metering `info`/`warn` call through the existing total diagnostic helper, extend that helper to support `info`, and render thrown provider values with the framework's total error renderer. Add regressions proving successful, refused, typed-error, and throwing-provider outcomes remain authoritative when the logger and fallback fail.

2. **`pr-test-analyzer-1` — Redis execution-generation TTL is not tested at the integrated store seam**
   `packages/host/src/hitl/adapters/run-store.ts:746`
   Add a deterministic RedisRunStore regression whose fake records the millisecond expiry passed by `beginExecution`, advances beyond it, and rejects `saveCheckpoint` through the expired execution-generation guard while preserving the prior checkpoint.

## Advisory dispositions

### Accepted

- **`code-reviewer-2` — batch freshness writes are indexed under the conditioned resource.** The claim is a high-confidence correctness defect: a write may condition on A while producing B. Look up conflicts under `conditionedOn.resource`, record the completed write under `newWitness.resource`, and extend both example and fast-check differential tests to generate independent resources.
- **`code-reviewer-3` — execution-token source throws can escape RedisRunStore.** The port promises `Promise<Result<…>>`. Fold token-source throws/non-string/empty values into `internal-invariant-violated`, and move `startSlice` inside RunExecutor's never-throw shell so another JobLike violation cannot escape through the same pre-try gap. Add typed-boundary regressions.
- **`type-design-analyzer-1` — member-key constructor can mint bytes its parser rejects.** The persisted grammar already rejects empty witness values, while `freshnessMemberKey` accepts them. Make the constructor enforce the same non-empty invariant and pin the constructor/parser symmetry.
- **`comment-analyzer-1` — FreshnessIndex option is inaccurately described as in-memory.** Update both option contracts to describe the port and state only that omission creates a private in-memory adapter.
- **`comment-analyzer-2` — `now` documentation references removed `runWave`.** Correct the execution hook reference to `executeWave`.
- **`architecture-tech-lead-1` — tenant HITL adapters receive admin-capable Redis commands.** Narrow `HitlRedisPort` to the exact tenant-safe commands used by run queue/store/decision adapters plus the required transaction capabilities. Keep `scan` available only on the supervisor-facing `RedisPort`; typecheck and existing fakes prove composition remains valid.
- **`code-simplifier-1` — file option grammar is rebuilt twice.** Name one immutable `supportedOptionKeys` value and use it for validation and diagnostics.
- **`code-simplifier-3` — prompt comparator uses a nested ternary.** Replace it with guard returns, preserving raw UTF-16 codepoint ordering exactly.

### Deferred

- **`pr-test-analyzer-2` — no timeout regression with `onDecisionConsumed` already in flight.** The gap is real, but a truthful fix is not a test-only change: once `DecisionStorePort.clear` is already in flight, RunExecutor's Boolean authorization check cannot revoke the Redis `DEL`. Complete prevention requires a persistence-bound decision-consumption generation guard (or an abort-aware atomic port operation) shared with the execution fence. Defer to an ADR-0060 deepening that changes the DecisionStore seam and both real/fake adapters together; do not add a knowingly failing or falsely reassuring test here.

### Dismissed

- **`type-design-analyzer-2` — tenant agent-client map should be DagId-keyed.** The host intentionally keys `AgentClientMap` by the DAG authoring surface, whose `DagDef.id` remains `string` per `CONTEXT.md`; consumers bridge to `DagId` only at durable/key-address boundaries. Unknown mapping keys are inert, values are parsed/non-empty, and changing only this registry field would disagree with the shared environment-side `AgentClientMap` without preventing forged object keys at runtime.
- **`code-simplifier-2` — Bot and realm JOSE classifiers should share a helper.** The apparent overlap is policy-specific and small. Realm verification deliberately recognizes rotation, malformed-JWKS, HTTP-body, and Bun socket failures that Bot verification does not; extracting only their three common facts would add cross-auth-context coupling without reducing state space, while merging policy would change security classification behavior outside the finding.

## Refuted critical findings audit

None. Both critical findings were upheld by all three registered panel lenses. The authoritative panel outcomes and captured `refutation-slot:*` transcripts remain under the Review Run Directory.

## Planned files

- `.claude/plans/2026-08-24-pr-remediation.md`
- `packages/framework/src/cli/prompts.ts`
- `packages/framework/src/dag-runtime/executor.ts`
- `packages/framework/src/dag-runtime/freshness-check.ts`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts`
- `packages/framework/src/file/options.ts`
- `packages/framework/src/types/freshness.ts`
- `packages/framework/src/__tests__/freshness-check.test.ts`
- `packages/framework/src/__tests__/freshness-check-property.test.ts`
- `packages/framework/src/__tests__/redis-freshness-index.test.ts`
- `packages/host/src/ports.ts`
- `packages/host/src/adapters/metered-llm.ts`
- `packages/host/src/__tests__/metered-llm.test.ts`
- `packages/host/src/hitl/diagnostic-logging.ts`
- `packages/host/src/hitl/adapters/run-store.ts`
- `packages/host/src/hitl/adapters/run-executor.ts`
- `packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts`
- `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
- `packages/host/src/hitl/__tests__/run-store-job.test.ts`

Every planned path is inside the frozen review scope; no additional remediation support path is required.

## Validation evidence

- Pre-production focused baseline: **223 passed / 0 failed** across 10 files.
- Post-implementation focused regression gate: **231 passed / 0 failed** across 10 files.
- Focused framework and host typechecks: passed.
- Workspace typecheck: all 12 workspace packages passed.
- Workspace test: **6,182 passed / 0 failed** (plus the repository's environment-gated skips).
- Shipped-document links and `git diff --check`: passed.
- Distill apply-mode move: replaced the batch freshness oracle's unused per-resource arrays with one latest-write entry per resource; its 17 example/property tests remained green. Skipped further cleanup because the remaining changed helpers encode new Result/port invariants or are explicit regression fixtures, not incidental abstraction.

## Validation commands

Focused baseline/regression gate:

```bash
bun test \
  packages/framework/src/__tests__/freshness-check.test.ts \
  packages/framework/src/__tests__/freshness-check-property.test.ts \
  packages/framework/src/__tests__/redis-freshness-index.test.ts \
  packages/framework/src/__tests__/cli/cli.test.ts \
  packages/framework/src/__tests__/file-boundary.test.ts \
  packages/host/src/__tests__/metered-llm.test.ts \
  packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-executor.test.ts \
  packages/host/src/hitl/adapters/__tests__/run-queue.test.ts \
  packages/host/src/hitl/__tests__/run-store-job.test.ts
```

Focused typecheck:

```bash
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
```

Full validation before registered remediation:

```bash
bun run typecheck
bun run test
bun run check:docs
git diff --check
```

After implementation is green, run the mandatory `distill` apply-mode pass one move at a time and re-run covering tests before starting registered remediation.
