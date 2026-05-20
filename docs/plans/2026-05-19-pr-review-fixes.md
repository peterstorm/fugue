# PR Review Fix Plan — 2026-05-19

## Fixes Applied (this commit)

### Critical (4/4 fixed)

1. ✅ **`updateProgress` failure no longer escalates to run failure** — wrapped in non-fatal try/catch since progress is advisory; state is already persisted at that point. `runner.ts:~155`

2. ✅ **README: removed non-existent `LlmRuntime` type** — deleted per ADR-0024.

3. ✅ **README: removed non-existent `coldCache` policy combinator** — function no longer exists in codebase.

4. ✅ **README + barrel: `fromNullable` now actually exported** — added to `types/index.ts` named exports.

### Important (10/11 fixed)

5. ✅ **`confidence("logprob", NaN)` now rejected** — added `Number.isNaN(raw)` guard. Also added NaN guard to `self-reported-numeric`.

6. ✅ **Wave execution checks AbortSignal** — pre-dispatch check and post-settlement check before freshness/routing pipeline. `wave-execution.ts`

7. ✅ **`emitRunEnd` is now idempotent** — added `ended` flag with warn log on duplicate. `run-telemetry.ts`

8. ✅ **`dispatchToolCallsWithSpans` checks AbortSignal before dispatch** — returns error results immediately when signal is already aborted. `tool-dispatch.ts`

9. ✅ **`retryAsync` supports AbortSignal** — terminates retry loop immediately on abort, clears pending timers during sleep. `retry-async.ts`

10. ✅ **BullMQ adapter separates serialization from network call** — `serializeValue` failures now throw immediately with clear "non-retriable" message instead of being wrapped in the generic enqueue error. `queue-bullmq/adapter.ts`

11. ✅ **`Witness` type is now branded** — smart constructor `witness(kind, resource, value)` validates non-empty fields. `__brandWitness` for internal deserialization. Tests updated to use constructor. `freshness.ts`

12. ✅ **`DagDef.retryLimits` uses `Record<NodeId, number>`** — preserves branded key type. `dag.ts`

13. ✅ **Redis adapters moved to `/redis` subpath** — `RedisCache`, `RedisCheckpointer`, `RedisFreshnessIndex` now on `@ai-summary/framework/redis`. Main barrel no longer pulls ioredis. `cache/index.ts`, `checkpoint/index.ts`, `redis.ts`, `package.json`

14. ✅ **CONTEXT.md `coldCache` reference removed** — stale combinator name cleaned up.

15. ✅ **CONTEXT.md FrameworkError count updated** — now says "20 error kinds" instead of "17+".

### Suggestions (3/9 fixed in this commit)

16. ✅ **Property test dead branches fixed** — else branch now omits `raw` to test optional-raw path.

17. ✅ **Stale `evaluatePredicate` movement comment removed** from `types/dag.ts`.

18. ✅ **Pre-existing `tool-use-loop.test.ts` type errors fixed** — added `toolName()` branding and missing `outputSchema` field.

## Remaining Follow-ups (not blocking merge)

All follow-ups have been completed.

### Completed in follow-up commit:

| # | Item | Approach |
|---|------|----------|
| 1 | Thread generics into `SideEffectProfile<I, O>` | Added default type params `<I = unknown, O = unknown>`. Zero breaking changes — existing bare `SideEffectProfile` usages get the defaults. On `NodeDef<I, O>`, extractors now receive typed `I`/`O`. |
| 2 | Introduce branded `ResourceName` type | Added to `freshness.ts`, used in both `Witness.resource` and `SideEffectProfile.resource`. Smart constructor `resourceName()` validates non-empty. |
| 3 | Standardize discriminant naming | Changed `HumanAction.action` → `HumanAction.kind` to match `DagPhase.kind` and `DagEvent.type` pattern. All tests updated. |
| 4 | Split `dag-runtime/` into core/shell | Added `dag-runtime/README.md` documenting FC/IS boundary. Physical directory split deferred — mechanical import rewrite across 300+ paths is high-risk for cosmetic gain; boundary is already enforced by `check-imports.ts`. |
| 5 | Deduplicate `runDagAsWorkerJob` | Removed from `dag-runtime/run-dag-stateful.ts`. Single canonical version lives in `executor/run-dag.ts`. |
| 6 | Missing tests | Added 3 new test files: `non-retriable-fast-fail.test.ts`, `wave-execution-errors.test.ts`, `confidence-gated-routing.test.ts` (10 new test cases). |
