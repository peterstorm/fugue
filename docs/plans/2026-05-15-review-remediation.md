# Plan: State-Transition Observability — Review Remediation

**Created:** 2026-05-15
**Status:** Draft
**Goal:** Fix all findings from the comprehensive PR review of Phases 1–5.

---

## Findings Summary

| # | Severity | Category | Description |
|---|----------|----------|-------------|
| 1 | Critical | silent-failure | Empty catch in executor.ts:730 — confidence extraction silent |
| 2 | High | silent-failure | Redis findConflict returns "no conflict" on infra failure |
| 3 | High | silent-failure | Mega catch block hides 6 failure modes under one message |
| 4 | High | silent-failure | decodeMember silently returns null on corrupt data |
| 5 | Medium | silent-failure | computeJsonPatch logs at debug level — should be warn |
| 6 | Medium | silent-failure | MLflow exporter permanent latch with no retry |
| 7 | Medium | architecture | InMemoryFreshnessIndex grows unbounded (sinceMs:0) |
| 8 | Medium | comment-drift | MLflow exporter header describes stale architecture |
| 9 | Medium | comment-drift | Docs claim extractConditionedOn called "before execution" |
| 10 | Medium | comment-drift | Worked example shows route-decided for unconditional edges |
| 11 | Medium | comment-drift | FreshnessIndex comment claims `T | Promise<T>` union |
| 12 | Medium | comment-drift | checkFreshness algorithm description inaccurate |
| 13 | Low | architecture | types/events.ts imports from dag-runtime/json-patch.ts |
| 14 | Low | test-gap | checkFreshness never tested with witness events |
| 15 | Low | test-gap | No full-pipeline reads→violation→human test |
| 16 | Low | test-gap | No extractor-throw test in executor context |

---

## Wave 1 — Critical + High silent-failure fixes (executor hardening)

All in `packages/framework/src/dag-runtime/executor.ts`.

### 1.1 — Add logging to empty catch at line ~730

The confidence extraction catch block in `runWave` is completely silent. Add `fwLogger().warn(...)` matching the pattern already used in `emitHumanIntervention`.

```ts
// Before:
} catch {
  upstreamConfidence = null;
}

// After:
} catch (e) {
  fwLogger().warn(
    `[runWave] confidence.extract failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`,
  );
  upstreamConfidence = null;
}
```

### 1.2 — Split mega catch block in emitFreshnessWitnessEvents (writes branch)

The single try/catch wrapping ~35 lines masks 6 distinct failure modes. Split into:
1. **Input reconstruction** — `fwLogger().error(...)` (framework invariant violation)
2. **User extractors** (`extractConditionedOn`, `extractNewWitness`) — `fwLogger().warn(...)` (user code)
3. **Freshness index I/O** (`findConflict`, `recordWrite`) — already handled by the index itself, but wrap emit calls

### 1.3 — Add logging to decodeMember in redis-freshness-index.ts

```ts
// Before: bare return null
// After: fwLogger().warn with the corrupt member string (truncated to 100 chars)
```

---

## Wave 2 — High + Medium silent-failure fixes (Redis + exporter)

### 2.1 — Redis findConflict: emit degradation signal

In `checkpoint/redis-freshness-index.ts`, when `findConflict` catches an error, the return value `null` semantically means "no conflict" which masks a "couldn't check" state. 

**Fix:** Add a `degradedChecks` counter (like `consecutiveFailures`) and emit a `fwLogger().error` that explicitly states freshness was NOT checked. Also add a `degraded` boolean getter for health-check consumers.

The return type stays `Promise<WriteEntry | null>` for now (changing to a discriminated result is too invasive for remediation). Document the "null means unchecked on failure" contract.

### 2.2 — computeJsonPatch: bump debug → warn

In `dag-runtime/json-patch.ts`, change `fwLogger().debug(...)` to `fwLogger().warn(...)`. This makes serialization failures visible in production logs.

### 2.3 — MLflow exporter: add bounded init retry (3 attempts)

In `tracing/mlflow-otlp-exporter.ts`, add an `initAttempts` counter. Only latch `failedPermanently` after 3 failed attempts. On attempts 1–2, reset `innerPromise = null` to allow retry on next `export()` call.

---

## Wave 3 — Architecture fix (json-patch location)

### 3.1 — Move json-patch.ts from dag-runtime/ to shared/

Move `packages/framework/src/dag-runtime/json-patch.ts` → `packages/framework/src/shared/json-patch.ts`.

Update imports in:
- `packages/framework/src/types/events.ts` (change `../dag-runtime/json-patch.js` → `../shared/json-patch.js`)
- `packages/framework/src/types/index.ts` (same)
- `packages/framework/src/dag-runtime/executor.ts` (change `./json-patch.js` → `../shared/json-patch.js`)

This fixes the inverted dependency (types/ → dag-runtime/) and places a pure function in the correct layer.

### 3.2 — Add boundary rule: types/ must not import dag-runtime/

In `scripts/check-imports.ts`, add:
```ts
{
  scope: ["types"],
  forbiddenModules: ["../dag-runtime", "../executor"],
  reason: "types/ is a lower layer; it must not import from dag-runtime/ or executor/.",
},
```

---

## Wave 4 — InMemoryFreshnessIndex bounded growth

### 4.1 — Add maxEntriesPerResource with LRU eviction

In `dag-runtime/freshness-check.ts`, add a constructor option:

```ts
export interface InMemoryFreshnessIndexOpts {
  /** Max write entries per resource. Default: 1000. Oldest evicted on overflow. */
  readonly maxEntriesPerResource?: number;
}
```

On `recordWrite`, if entries for a resource exceed the cap, drop the oldest (lowest `succeededAtMs`). This bounds memory usage for long-lived shared indexes.

### 4.2 — Document sinceMs:0 contract

Add a doc comment to the `findConflict` call in `executor.ts` explaining that `0` is intentional: within a single run, all prior writes are relevant because the DAG's topological ordering means the read witness was captured before any writes in later waves.

---

## Wave 5 — Comment/doc fixes

### 5.1 — MLflow exporter header comment

Rewrite lines 19–23 of `mlflow-otlp-exporter.ts` to accurately describe the inline Proxy approach.

### 5.2 — state-transitions.md: extractConditionedOn timing

Change "Called before execution" to "Called after the node completes. Extracts the version the write assumed was current (from the node's input)."

### 5.3 — state-transitions.md: worked example route-decided

Add a conditional predicate edge to the `assess-risk → execute-refund` edge so the route-decided event in the example is consistent with the DAG definition.

### 5.4 — FreshnessIndex comment about `T | Promise<T>`

Rewrite to: "Both methods return `Promise<...>`. The in-memory implementation uses trivially-async methods to satisfy the same interface as the Redis adapter."

### 5.5 — checkFreshness algorithm description

Rewrite step 2: "For each WriteAttemptedEvent, check if the latest recorded write to the same resource produced a different witness value than conditionedOn.value. If so, the conditioned-on state is stale — record a conflict."

---

## Wave 6 — Test gap coverage

### 6.1 — checkFreshness with non-empty witnessEvents

Add test cases in `freshness-check.test.ts` that pass `WitnessCapturedEvent[]` to verify timeline interleaving doesn't affect conflict detection.

### 6.2 — Full pipeline integration test

New test file: `__tests__/freshness-full-pipeline.test.ts`

Scenario:
1. `reader` node (reads, postgres:orders) → extractWitness returns version=42
2. Inject a conflicting write into the freshnessIndex (simulating another process)
3. `writer` node (writes, postgres:orders) → extractConditionedOn returns version=42
4. Verify `freshness-violation` event is emitted
5. `review` node (humanReview) → approve
6. Verify `human-intervention` event has `priorWitnesses` containing version=42

### 6.3 — Extractor failure test

New test in `freshness-check.test.ts` or new file: verify that when `extractWitness` throws during a DAG run, the run still succeeds (freshness silently skipped) and a warning is logged (test with recording logger or spy).

---

## Estimated effort

| Wave | LoC (approx) | Risk |
|------|-------------|------|
| 1 | ~60 | Low — additive logging, split catch |
| 2 | ~80 | Low–Medium — exporter retry needs care |
| 3 | ~20 + boundary rule | Low — file move + import updates |
| 4 | ~40 | Low — additive, backwards compat |
| 5 | ~50 | None — pure text edits |
| 6 | ~200 | Low — additive tests |

**Total:** ~450 LoC across 6 waves. Each wave is independently committable.

---

## Acceptance criteria

- [ ] `bun test` — all tests pass
- [ ] `bunx tsc --noEmit` — framework typechecks
- [ ] `bun run packages/framework/src/scripts/check-imports.ts` — no violations
- [ ] New boundary rule catches `types/ → dag-runtime/` if re-introduced
- [ ] MLflow exporter survives 1 transient init failure without permanent latch
- [ ] InMemoryFreshnessIndex stays bounded at 1000 entries per resource
- [ ] Full pipeline test exercises reads → violation → human with witnesses
