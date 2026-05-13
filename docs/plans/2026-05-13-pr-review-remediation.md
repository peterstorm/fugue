# PR Review Remediation Plan — 2026-05-13

Fixes all 28 findings from the comprehensive PR review across 5 waves.
Each wave is independently shippable and testable.

**Ground rules:**
- Every change gets a corresponding test (new or updated).
- Run `bun test` after each wave to confirm green.
- ADR comments reference the review finding number (e.g. `// Fix #3: ...`).

**Status:** 713 tests pass, 0 fail, 0 type errors after first commit.

---

## Wave 1 — Critical correctness & data integrity (7 findings)

### ✅ 1.1 Race condition in `runWave` — shared mutable `outputs` Map
**Finding:** #1 (code-reviewer, CRITICAL)
**Status:** DONE
**Files changed:** `dag-runtime/executor.ts`, `dag-runtime/run-node.ts`
**What was done:**
- Changed `runNodeShared` `outputs` param from `Map<string, unknown>` to
  `ReadonlyMap<string, unknown>` — compile-time enforcement of no mutation.
- Removed both `outputs.set(nodeId, ...)` side-effect calls from inside
  `runNodeShared` (lines 134 and 235). Node output is returned via `Result`
  and the caller handles merge.
- In `runWave`, replaced mutable `outputs` map with immutable `priorOutputs`
  snapshot from `machineCtx.outputs`. Each concurrent node reads only prior-wave
  data. Post-`Promise.all` merge via existing `newOutputs` collection was
  already correct.
**Remaining:** Add dedicated `concurrent-wave-isolation.test.ts` to prove the
fix prevents same-wave cross-reads.

---

### ✅ 1.2 `nodeId: "unknown"` raw string where branded `NodeId` expected
**Finding:** #2 (code-reviewer, CRITICAL)
**Status:** DONE
**Files changed:** `dag-runtime/types.ts`, `dag-runtime/transition.ts`
**What was done:**
- Added `EXECUTOR_NODE_ID = __brandNodeId("__executor__")` sentinel constant
  in `types.ts`, with JSDoc explaining the purpose. Unifies with the existing
  `"__executor__"` usage in `run-dag-stateful.ts`.
- Replaced both `nodeId: "unknown"` occurrences in `transition.ts` (lines 66,
  98) with `EXECUTOR_NODE_ID`.

---

### ✅ 1.3 `RedisCache.get` returns `ok(garbage)` — no schema validation
**Finding:** #3 (silent-failure-hunter, CRITICAL)
**Status:** DONE
**Files changed:** `cache/cache.ts`, `cache/redis-cache.ts`
**What was done:**
- Added optional `validate?: (v: unknown) => boolean` parameter to both the
  `Cache` interface and `RedisCache.get`. Existing callers unaffected (param
  is optional).
- When validator is provided and returns `false`, returns `Err` with
  `operation: "get-validation"` and logs at `error` level.
**Remaining:** Add test case to `redis-cache.test.ts` — valid JSON but wrong
shape returns `Err` when `validate` is provided.

---

### ✅ 1.4 `RedisCache.set` conflates serialization vs Redis errors
**Finding:** #4 (silent-failure-hunter, CRITICAL)
**Status:** DONE
**Files changed:** `cache/redis-cache.ts`
**What was done:**
- Split into two try blocks: `JSON.stringify` (non-retriable) catches to
  `operation: "set-serialize"` at `error` level; `redis.set` (retriable)
  catches to `operation: "set"` at `warn` level.
**Remaining:** Add test case for circular-reference value → `Err` with
`operation: "set-serialize"`.

---

### ✅ 1.5 MLflow exporter `forceFlush`/`shutdown` silently succeed when permanently failed
**Finding:** #5 (silent-failure-hunter, CRITICAL)
**Status:** DONE
**Files changed:** `tracing/mlflow-otlp-exporter.ts`
**What was done:**
- Both `shutdown()` and `forceFlush()` now log at `warn` level with the
  `droppedSpanCount` and the original error message when `failedPermanently`
  is set.
- Intentionally do NOT throw — throwing in `shutdown()` aborts the OTel SDK
  shutdown chain. The `failed` getter and `droppedSpanCount` remain the
  programmatic health-check surface.

---

### 🔲 1.6 Branded IDs are soft — `string` satisfies `RunId`/`NodeId`/`DagId`
**Finding:** #6 (type-design-analyzer, CRITICAL)
**Status:** TODO — largest single change, ~25+ files
**File:** `types/ids.ts`
**Plan:** Make brand required (`?` → non-optional). Run `tsc --noEmit`, fix all
compile errors using smart constructors or `__brandXxx` for trusted internal
code. Do together with 1.7 in a dedicated commit.

---

### 🔲 1.7 `DagMachineContext` uses `ReadonlyMap<string, unknown>` — brand erased
**Finding:** #7 (type-design-analyzer, CRITICAL)
**Status:** TODO — cascades through ~15 files
**File:** `dag-runtime/types.ts`
**Plan:** Change all `string` keys to `NodeId` in `DagMachineContext`,
`DagPhase`, `DagEvent`, and `HumanAction`. Requires 1.6 first.

---

## Wave 2 — Error handling parity & resilience (8 findings)

### ✅ 2.1 Anthropic client: timeout treated as non-retriable abort
**Finding:** #8 (code-reviewer, IMPORTANT)
**Status:** DONE
**Files changed:** `llm/anthropic-client.ts`
**What was done:**
- Replaced `AbortSignal.timeout()` + `AbortSignal.any()` with manual
  `setTimeout` + `timedOut` flag pattern (matching `openai-client.ts`).
- Applied to both `sendStructured` and `sendWithTools` (per-turn timeout in
  the tool loop).
- Timeout → `{ kind: "transient" }` (retriable). Caller abort → `{ kind: "aborted" }`.
- Added `finally` blocks for cleanup (`clearTimeout`, `removeEventListener`).
**Remaining:** Add test: timeout → `transient` (not `aborted`).

---

### ✅ 2.2 OpenAI timeout: replace monkey-patching with WeakSet
**Finding:** #14 (silent-failure-hunter, IMPORTANT)
**Status:** DONE
**Files changed:** `llm/openai-client.ts`
**What was done:**
- Replaced `Object.assign(e, { __timedOut: true })` with module-level
  `const timedOutErrors = new WeakSet<Error>()`.
- `postResponses` now calls `timedOutErrors.add(e)` instead of mutating.
- `isTimeoutAbort` now checks `timedOutErrors.has(e)` — works on frozen errors.

---

### ✅ 2.3 Dead-letter handler: silent drop on malformed `attempts`
**Finding:** #10 (silent-failure-hunter, IMPORTANT)
**Status:** DONE
**Files changed:** `queue/dead-letter.ts`, `__tests__/queue-dead-letter.test.ts`
**What was done:**
- Removed `return;` on malformed `attempts`. Now logs `error` and falls through
  to `notify()` — the job is dead, notification matters more.
- Updated 2 tests that asserted the old "silently skip" behavior to expect
  notification instead.

---

### 🔲 2.4 Scheduler: marker-write failure abandons dependent chain
**Finding:** #11 (silent-failure-hunter, IMPORTANT)
**Status:** TODO
**File:** `scheduler/scheduler.ts`
**Plan:** Add 3-attempt retry loop with linear backoff on `markers.set(completed)`.

---

### 🔲 2.5 Scheduler: dependent enqueue failure is terminal
**Finding:** #12 (silent-failure-hunter, IMPORTANT)
**Status:** TODO
**File:** `scheduler/scheduler.ts`
**Plan:** Add 3-attempt retry loop with linear backoff on `enqueue(dep)`.

---

### ✅ 2.6 BufferedObserver: replay failures at `warn` → upgrade to `error`
**Finding:** #13 (silent-failure-hunter, IMPORTANT)
**Status:** DONE
**Files changed:** `observer/buffered.ts`
**What was done:**
- Upgraded `fwLogger().warn` → `fwLogger().error` on all replay failure paths.
- Added replay failure counter with summary log:
  `"${replayFailures}/${events.length} events lost during replay for run ${e.runId}"`.

---

### ✅ 2.7 `prompts/registry.ts` — bare `catch {}` loses error context
**Finding:** #27 (silent-failure-hunter, ADVISORY)
**Status:** DONE
**Files changed:** `prompts/registry.ts`
**What was done:**
- Both `readFile` catch blocks now inspect `(e as NodeJS.ErrnoException).code`.
- ENOENT → original message. EACCES/EMFILE/etc → distinct message including
  the error code.

---

### 🔲 2.8 `llm/spans.ts` — bare `catch {}` in `stringifyOrTruncate`
**Finding:** #13 from code-reviewer (ADVISORY)
**Status:** TODO
**File:** `llm/spans.ts`
**Plan:** Log at debug level with `typeof value` in the fallback JSON.

---

## Wave 3 — Type safety hardening (4 findings)

### 🔲 3.1 `DagEvent` transitions not exhaustively checked
**Finding:** #15 (type-design-analyzer, IMPORTANT)
**Status:** TODO
**File:** `dag-runtime/transition.ts`
**Plan:** Refactor each phase block to use nested `switch (event.type)` with
`never` exhaustive check, or use `assertNeverEvent` helper.

---

### 🔲 3.2 `Predicate<unknown>` erases authoring-time type safety
**Finding:** #16 (type-design-analyzer, IMPORTANT)
**Status:** TODO — documentation only, no code change
**File:** `types/dag.ts`
**Plan:** Add explicit JSDoc on `EdgeDef` documenting the intentional widening
and the runtime safety net (Zod schema validation).

---

### ✅ 3.3 `Result.unwrap` — add `@deprecated` tag + `fold` combinator
**Finding:** #21 (type-design-analyzer, SUGGESTION)
**Status:** DONE
**Files changed:** `types/result.ts`, `types/index.ts`, `index.ts`,
`__tests__/result.test.ts`
**What was done:**
- Added `@deprecated` JSDoc on `unwrap`.
- Added `fold` combinator for exhaustive Ok/Err consumption.
- Exported `fold` from both barrel files.
- Added 2 tests for `fold` (Ok and Err paths).

---

### 🔲 3.4 `__brandXxx` escape hatches — add `@internal` docs
**Finding:** from type-design-analyzer (SUGGESTION)
**Status:** TODO — documentation only
**File:** `types/ids.ts`
**Plan:** Add `@internal` JSDoc on all three `__brand*` exports.

---

## Wave 4 — Performance & architecture (4 findings)

### ✅ 4.1 `expandActive` rebuilds adjacency map per call
**Finding:** #9 (code-reviewer, IMPORTANT)
**Status:** DONE
**Files changed:** `dag-runtime/conditional.ts`, `dag-runtime/wave-resolution.ts`,
`dag-runtime/human-resolution.ts`
**What was done:**
- Added optional `outgoing?: ReadonlyMap<string, readonly EdgeDef[]>` parameter
  to `expandActive`. Falls back to `buildOutgoing(dag)` when not provided
  (backward-compatible for validators/tests).
- Updated all 3 runtime callers to pass `ctx.outgoingByNode`.

---

### 🔲 4.2 Precompute `Map<NodeId, NodeDef>` for O(1) node lookup
**Finding:** #24 (architecture-agent, SUGGESTION)
**Status:** TODO
**Files:** `dag-runtime/machine.ts`, `dag-runtime/types.ts`,
`dag-runtime/wave-resolution.ts`, `dag-runtime/retry-policy.ts`
**Plan:** Add `nodeById` to `DagMachineContext`, compute in
`compileDagToMachine`, replace `.find()` calls with `.get()`.

---

### 🔲 4.3 `runStateMachine` throws for terminal-failed (architecture doc)
**Finding:** #17 (architecture-agent, IMPORTANT)
**Status:** TODO — documentation only
**File:** `state-machine/runner.ts`
**Plan:** Add prominent comment citing ADR FR-007 rationale.

---

### ✅ 4.4 `DagMachineContext.outputs` — already `ReadonlyMap`
**Finding:** #25 (architecture-agent, SUGGESTION)
**Status:** N/A — already `ReadonlyMap`. Full fix deferred to 1.7 (NodeId keys).

---

## Wave 5 — Test coverage gaps (2 findings)

### 🔲 5.1 `tracing/span-enrich.ts` — cost calculation unit tests
**Finding:** #18 (pr-test-analyzer, IMPORTANT)
**Status:** TODO
**File:** New: `__tests__/span-enrich.test.ts`
**Plan:** 6 test cases covering known/unknown models, zero tokens, content
filter on/off, thinking attribute.

---

### 🔲 5.2 `dag-runtime/run-node.ts` — conditional dep input assembly
**Finding:** #19 (pr-test-analyzer, IMPORTANT)
**Status:** TODO
**File:** New: `__tests__/run-node-input-assembly.test.ts`
**Plan:** 6 test cases covering 0/1/2+ required deps, optional deps
present/absent, mixed.

---

## Wave 6 — Code simplifier pass

**Status:** TODO — run after all other waves land.

---

## Execution Order & Dependencies

```
Wave 1.1–1.5 (critical fixes)  ── ✅ DONE (this commit)
Wave 2.1–2.3, 2.6–2.7 (errors) ── ✅ DONE (this commit)
Wave 3.3 (Result.fold)          ── ✅ DONE (this commit)
Wave 4.1 (expandActive)         ── ✅ DONE (this commit)

Wave 1.6 + 1.7 (branded IDs + DagMachineContext)
  → Next commit: largest change, ~25 files
  → Run full test suite afterward

Wave 2.4 + 2.5 (scheduler retry)
  → Independent, can ship anytime

Wave 2.8 (spans bare catch)
  → Small, independent

Wave 3.1 (exhaustive events)
  → Independent of branded ID migration

Wave 3.2, 3.4, 4.3 (documentation-only)
  → Small, ship together

Wave 4.2 (nodeById lookup)
  → Depends on 1.7 for NodeId-keyed maps

Wave 5.1 + 5.2 (new tests)
  → Independent, ship anytime

Wave 6 (simplifier)
  → After all above
```

## Progress Summary

| Wave | Findings | Done | Remaining |
|------|----------|------|-----------|
| 1 (critical) | 7 | **5** ✅ | 2 (branded ID migration) |
| 2 (errors) | 8 | **5** ✅ | 3 (scheduler retry, spans catch) |
| 3 (types) | 4 | **1** ✅ | 3 (exhaustive events, docs) |
| 4 (perf) | 4 | **2** ✅ | 2 (nodeById, runner doc) |
| 5 (tests) | 2 | 0 | 2 (new test files) |
| 6 (simplify) | — | 0 | Agent pass |
| **Total** | **25** | **13 ✅** | **12 remaining** |

**21 files changed, 713 tests pass, 0 type errors.**
