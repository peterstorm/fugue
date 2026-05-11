---

# Plan: Framework PR-review remediation — pass 2 (`feat/initial-setup`)

**Created:** 2026-05-11
**Status:** Draft
**Goal:** Resolve every finding from the 2026-05-11 multi-agent review of `packages/framework/**` that ran against the post-Wave-8 state of `feat/initial-setup`. Each wave is an independent PR.

**Source review:** 6-agent fan-out (`/loom:review-pr` — code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead). Aggregate: **13 critical, 57 advisory** across the framework. Test fortification from the previous remediation is preserved; this pass extends it.

**Licence:** The framework has **zero external consumers** (README §"Adding to the public surface"). Treat the public surface as freely editable — no semver, no shims, no migration code.

**Decisions baked in:**

- **D1 — `ERROR.retriable` is implemented, not removed.** `dagTransition` reads it; permanent errors fast-fail without consuming retry budget. This is the contract callers expect from `classifyError`.
- **D2 — Tool-call iteration exhaustion is `node-crash` (not `transient`).** A deterministically-looping model will not converge on retry.
- **D3 — `outputNodeId` stays optional.** Threading the inferred output-node id through `DagDef` to narrow `runDagStateful`'s return type is out of scope for this pass. Capture as a follow-up.
- **D4 — Internal helpers stay off the barrel.** No public-surface widening this pass.

---

## Scope and triage

| Wave | Theme | Risk if deferred |
|------|-------|------------------|
| 1 | Critical correctness (silent failures + onTrace guard + dead `retriable`) | Healthy transitions misreported as crashes; retry budget burned on permanent errors; tool-loops never fail fast |
| 2 | Critical type-system holes (`ToolDef.run` widening, OpenAI SDK `as any`, `GuardrailValidated` lie, `dagFingerprint` unenforced) | Illegal state representable; silent SDK breakage on minor bump; checkpoint resume into restructured DAG |
| 3 | Critical doc fixes (README `close()`, `gpt-5.2-codex`) | Consumers code against a fictional return type and an unverified model |
| 4 | Error-handling polish (observer emission, registry parse, scheduler backoff, wave-index guard, redis-checkpointer corrupt signaling, buffered run-end guard) | Failures invisible to operators; flapping enqueue logs without backoff |
| 5 | Type-design narrowing (skip pairing, `as DagMachineContext` strip, error-kind union, eval-judge array→record, runtime widening, residual `as unknown as` casts) | Type holes that future refactors silently extend |
| 6 | Architecture (hook-handler dedup, `now`/`rng`/`warn` seams, `outgoingByNode` precompute, `LegacyTracingConfig` deletion, replay flag) | Duplicated branches diverge, real-timer test flakes lock in, dead deprecated surface ossifies |
| 7 | Test fortification — durability + coverage gaps + property tests + flake elimination | Silent reintroduction of fixed bugs; opaque MLflow/cost regression risk |
| 8 | Comment + doc rot sweep (Wave §N.M references, what-comments, stale line numbers) | Comments rot the moment plans are archived |

Waves 1–3 are merge blockers. Waves 4–6 follow with minimal coupling and may interleave. Wave 7 lands after the code it tests is in. Wave 8 runs last to avoid merge churn.

---

## 1. Wave 1 — Critical correctness

All four items are runtime defects with reproducible failure paths. Land before any further work.

### 1.1 Guard `onTrace` invocations in the kernel loop

`packages/framework/src/state-machine/runner.ts:70, :152`. Two unguarded `opts.onTrace(...)` call sites. A throwing observer/tracer escapes the kernel loop, gets caught by `run-dag-stateful.ts:382`, and surfaces as `err({ kind: "node-crash", nodeId: "__executor__" })` — a healthy transition reported as a fatal crash.

Fix: wrap both call sites in try-catch; log via `console.error` with the prefix `[runStateMachine] onTrace threw — ignoring to preserve durability:`. Do not let the exception out of the loop. This mirrors the observer-strict pattern (when `OBSERVER_STRICT=1` the test harness sets up its own escape hatch; production durability comes first).

Regression test (Wave 7.1): write a `runStateMachine` test where `onTrace` throws on every call — assert the run completes successfully and the final state is the expected terminal.

### 1.2 Surface swallowed job failures in `InMemoryQueue`

`packages/framework/src/queue/in-memory.ts:129-145`. When a job exhausts its retry budget and no `onFailed` handler is registered, the catch block iterates an empty handler list and the failure is lost entirely.

Fix: when `failedHandlers.get(name)?.length` is zero (or the entry is missing), emit `console.error(\`[InMemoryQueue] Job "\${entry.id}" failed (attempt \${attempt}/\${max}) with no onFailed handler:\`, jobErr)` after the final retry attempt. Optionally bump an internal `unhandledFailureCount` exposed on the backend handle for tests.

Regression test (Wave 7.2): enqueue a job that always throws, register no `onFailed`, assert the console.error was emitted (use a `vi.spyOn(console, "error")` pattern that already exists elsewhere in the suite).

### 1.3 Reclassify tool-call iteration exhaustion as permanent

`packages/framework/src/llm/anthropic-client.ts:339` and `packages/framework/src/llm/openai-client.ts:547`. Both clients return `err({ kind: "transient", ... })` when `maxIterations` is hit. A model in a tool-call loop will not converge on retry.

Fix: change both call sites to `err({ kind: "node-crash", nodeId: ctx.nodeId, message: \`tool-call iteration limit (\${maxIterations}) exhausted\` })`. `node-crash` already maps to non-retriable; combined with Wave 1.4 it short-circuits the retry budget.

Regression test (Wave 7.3): `FakeLlmClient` script that emits `maxIterations + 1` tool-use turns; assert the run fails on the first attempt with `kind: "node-crash"` and that the retry counter is `1`, not `retryLimit`.

### 1.4 Implement `ERROR.retriable` in the DAG transition

`packages/framework/src/dag-runtime/transition.ts:59-100` and `dag-runtime/transition-helpers.ts:handleNodeFailed`. The `ERROR` event already carries `retriable: boolean` (`dag-runtime/types.ts:93`), but `handleNodeFailed` ignores it and always applies the retry budget.

Fix: in `handleNodeFailed`, fast-fail when `event.retriable === false` regardless of remaining budget. Skip the increment of `retryCounters`, skip co-failed-sibling pre-increment, transition straight to `{ kind: "failed", failedNodeId, attempts: current.attempts ?? 1, error: event.error }`. Preserve the documented invariant: `attempts` reflects executions attempted, which is `1` for fast-fail.

This makes `RunOptions.classifyError` (in `run-dag-stateful.ts:247`) actually load-bearing: a custom classifier returning `retriable: false` for a deterministic failure (e.g., schema mismatch) now fast-fails as documented.

Regression test (Wave 7.4): two scenarios — (a) classifier returns `retriable: false`, assert single execution and terminal `failed`; (b) classifier returns `retriable: true`, assert full retry budget burns (existing behavior).

---

## 2. Wave 2 — Critical type-system holes

### 2.1 Narrow `ToolDef.run` to `TypedNodeContext<R>`

`packages/framework/src/llm/tools.ts:26`. `ToolDef.run` is `(input: I, ctx: NodeContext) => Promise<O>` — the wide context with every capability nullable. Tool authors who read `ctx.llm` get no compile error even when the enclosing node declares no `requires`.

Fix: parameterise `ToolDef` over a capability list: `ToolDef<I, O, R extends readonly Capability[] = []>`. `run` becomes `(input: I, ctx: TypedNodeContext<R>) => Promise<O>`. The `tool(...)` builder accepts `requires?: R` and threads it. `sendWithTools` validates at compile time that the host node's `requires` is a superset of every tool's `requires` (intersection check on the array type, or runtime check at registration with a typed compile-time helper).

Adjacent fix: in `llm/anthropic-client.ts:208` and `llm/openai-client.ts:388`, the `runtime as NodeContext` widening cast inside `sendWithTools` is the structural reason for the type hole. After this change the cast is still needed (cycle constraint) but the tool surface is sound.

Regression test (Wave 7.5): construct a tool with `requires: ["llm"]`; assert that hosting it in a node without `"llm"` in its `requires` is a compile error (use a `// @ts-expect-error` assertion in the test file).

### 2.2 Replace OpenAI SDK private-field reads with explicit constructor opts

`packages/framework/src/llm/openai-client.ts:221-223`. Three `(openai as any)` reads of `_options.baseURL`, `_options.apiKey`, `_options.defaultQuery["api-version"]`. The SDK guarantees nothing about these.

Fix: `OpenAILlmClient` constructor adds explicit `opts: { baseUrl: string; apiKey: string; apiVersion?: string; openai: OpenAI }`. Callers pass the values they used to construct the `OpenAI` instance. Delete the three `as any` reads. Tests that construct via the convenience overload update accordingly.

Regression test (Wave 7.5): no `as` cast remains in `openai-client.ts` (boundary-imports test extends to a grep assertion); construct a client without `openai._options` and assert it still emits proper span attributes.

### 2.3 Fix `GuardrailValidated<T>.value` on the error path

`packages/framework/src/nodes/guardrail.ts:86`. When the validate function throws, the result is `{ kind: "validated", value: undefined as unknown as T, ... }` — a lie at the type level.

Fix: introduce a `GuardrailFailed<T>` variant: `{ kind: "failed"; check: GuardrailCheck; error: string; value?: never }`. The error path returns `GuardrailFailed`. `GuardrailResult<T> = GuardrailValidated<T> | GuardrailSkipped | GuardrailFailed<T>`. Update the union exhaustive checks (TS will list them via `never`).

Regression test (Wave 7.6): guardrail whose validator throws; assert the result is `kind: "failed"` and `.value` access is a compile error.

### 2.4 Enforce `dagFingerprint` on resume

`packages/framework/src/checkpoint/checkpointer.ts:23` and `redis-checkpointer.ts:120`. `RunMeta.dagFingerprint` is documented as enforced at resume but `load()` only checks `frameworkVersion`.

Fix: mirror the `frameworkVersion` enforcement pattern at `redis-checkpointer.ts:120`:

- On `save()` / `init()`: when `meta.dagFingerprint` is undefined, the call site must supply it. Make it required on the `RunMeta` write surface (drop the `?` on `RunMeta.dagFingerprint`). Stamp at `runDagStateful` from `dagFingerprint(effectiveDag)`.
- On `load()`: read stored fingerprint; reject with `err({ kind: "checkpoint-version-mismatch", expected: <current-fingerprint>, actual: <stored>, runId })` when they differ. The error kind is reused intentionally — the operator-facing message is the same: "this checkpoint is incompatible with the current DAG".
- Update boundary-imports test fixtures.

Regression test (Wave 7.7): write a checkpoint with fingerprint A; attempt to resume against a DAG with fingerprint B; assert `checkpoint-version-mismatch` is returned and no node outputs replay.

---

## 3. Wave 3 — Critical doc fixes

Two small documentation lies. Land in a single tiny PR.

### 3.1 Fix `README.md:121-122` description of BullMQ adapter `close()`

The README claims `close()` returns `Promise<{ ok: true } | { ok: false; errors: Error[] }>`. The actual signature (`queue-bullmq/adapter.ts:207`) is `async function close(): Promise<void>` which throws an `AggregateError` on partial failure.

Fix: replace the README paragraph with the actual behavior — close throws an `AggregateError` whose `errors` array carries the individual close failures; on clean shutdown it resolves to `undefined`. Drop the discriminated-union return type description entirely.

### 3.2 Remove `gpt-5.2-codex` from `OpenAILlmClient` class JSDoc

`packages/framework/src/llm/openai-client.ts:210`. The docstring lists `gpt-5.2-codex` alongside `gpt-4o-mini` and `gpt-5-mini`. The model does not appear in `PRICE_TABLE`, fixtures, or any test. Speculative listing in a docstring is a doc lie.

Fix: drop `gpt-5.2-codex` from the docstring. Enumerate only models actually exercised in the test suite. Add a one-line note: "Other OpenAI models work but require a `PRICE_TABLE` entry for cost attribution."

---

## 4. Wave 4 — Error-handling polish (silent-failure follow-ups)

Six advisories from the silent-failure hunt. Independent edits.

### 4.1 Emit `node-error` on input-validation failure

`packages/framework/src/shared/run-node.ts:131`. The early return after `validateInput` failure produces no `node-start` and no `node-error` observer event. The node vanishes from the buffered stream.

Fix: emit `node-error` (with `kind: "validation"`) before the return. Do not emit `node-start` — there was no execution to start. Mirror the checkpoint-replay failure path at lines 106-114 which already does this.

### 4.2 Propagate scheduler enqueue failures into backoff

`packages/framework/src/scheduler/scheduler.ts:207-211`. `handleFire` swallows enqueue failures internally, returns normally, and the `.then` branch resets `consecutiveFailures` and reschedules at the normal cron interval — bypassing the Wave-3 §3.9 backoff.

Fix: `handleFire` rethrows the enqueue error after the console.error. The outer `setTimeout` callback in `scheduleNext` catches it (or chains `.catch(err => rescheduleTaskWithBackoff(...))`) and applies the exponential backoff. Failure of the marker store (set/delete) keeps the existing behavior — only the enqueue error path changes.

Regression test (Wave 7.8): fault-injected enqueue; assert the second fire happens at `BACKOFF_BASE_MS`, not at the cron interval.

### 4.3 Distinguish registry file missing from registry file malformed

`packages/framework/src/prompts/registry.ts:44-48`. The catch block collapses `readFile` ENOENT with `JSON.parse` failure under `"not in registry"`.

Fix: split the try. `readFile` runs first; on ENOENT return `err({ kind: "prompt-not-found", promptName: name, reason: "registry file does not exist" })`. `JSON.parse` runs second; on failure return `err({ kind: "prompt-not-found", promptName: name, reason: "registry file is not valid JSON" })`. Consider widening to a `registry-malformed` kind in `FrameworkError` if the operator-facing semantics warrant it — but the `reason` field carries the information, so reuse `prompt-not-found` for this pass.

### 4.4 Surface invalid `waveIndex` instead of empty fallback

`packages/framework/src/dag-runtime/executor.ts:333`. `machineCtx.waves[waveIndex] ?? []` silently emits `wave-done` with no outputs.

Fix: when `waveIndex >= machineCtx.waves.length` or `waveIndex < 0`, treat as an invariant violation. Log via `console.error` with the prefix `[runWave] out-of-bounds waveIndex \${waveIndex}/\${machineCtx.waves.length}`, then emit a `wave-failed` event (or — if the eventing layer cannot carry a non-node failure — return `err({ kind: "cycle-detected", nodeIds: [] })` or a new `kind: "invariant-violation"`). Decision: add `kind: "invariant-violation"` to `FrameworkError` for these cases; reuse it in §4.6.

### 4.5 Surface corrupt-checkpoint node ids

`packages/framework/src/checkpoint/redis-checkpointer.ts:154-158`. Per-entry corruption is logged and silently skipped; callers cannot distinguish corruption from absence.

Fix: extend `RunState` with `corruptNodeIds?: readonly string[]` (advisory field, default empty). On `load()`, accumulate ids whose deserialize failed and attach to the returned state. Consumers (resume logic) can warn on non-empty `corruptNodeIds`.

### 4.6 Guard `dispatchEvent` for final `run-end` in `BufferedObserver`

`packages/framework/src/observer/buffered.ts:251`. The replay loop is try/catch-guarded; the final `run-end` dispatch is not. A throw leaks the buffer (the `this.buffers.delete(e.runId)` at line 254 never runs).

Fix: wrap the line-251 `dispatchEvent` in the same try/catch as the replay loop. Move `this.buffers.delete(e.runId)` to a `finally` block so the buffer is cleared regardless of inner throw.

---

## 5. Wave 5 — Type-design narrowing

Items from the type-design analysis that survived after Wave 2's critical fixes.

### 5.1 Discriminated union for `LlmNodeConfig.skipWhen` / `skipDefault`

`packages/framework/src/nodes/llm.ts:16-19`. Optional-field pairing only enforced at runtime.

Fix:
```ts
type LlmSkipConfig<I, O> =
  | { readonly skipWhen?: undefined; readonly skipDefault?: undefined }
  | { readonly skipWhen: (input: I) => boolean; readonly skipDefault: O };
```
Intersect into `LlmNodeConfig`. Update tests that previously asserted the runtime validation error to assert a compile error instead (`// @ts-expect-error`).

### 5.2 Replace `rest as DagMachineContext` with a typed strip helper

`packages/framework/src/dag-runtime/run-dag-stateful.ts:115`. The cast erases the structural check; a new non-serializable field on `DagMachineContext` would be silently stripped.

Fix: introduce a `stripNonPersistable(ctx: DagMachineContext): PersistableDagMachineContext` helper with an explicit return type that omits `dag` and `incomingByNode` (`Omit<DagMachineContext, "dag" | "incomingByNode">`). Cast becomes structurally checked. Mirror on the re-injection side: `injectStripped(stored: PersistableDagMachineContext, dag, incomingByNode): DagMachineContext`. New fields added to `DagMachineContext` either land in `PersistableDagMachineContext` (serialized) or in the omit list (stripped), forced by the type system.

### 5.3 `missing-capability.capability` is `Capability`, not `string`

`packages/framework/src/types/errors.ts:44`. Typed `string`, so an error payload can carry a non-`Capability` value, defeating discriminated-union round-tripping at consumers.

Fix: change the field type to `Capability` (imported from `types/node.ts`). Update the single producer in `shared/capabilities.ts` (or wherever the error is constructed) to narrow at the source — the value is statically a `Capability` at every call site, so no runtime change needed.

### 5.4 Carry `criteria` as an array in `eval-judge.ts:189`

`packages/framework/src/nodes/eval-judge.ts:189`. `config.criteria as unknown as Record<string, unknown>` — array cast to record.

Fix: change `extraInputs` shape (in `nodes/eval-judge.ts` or wherever it's read for span enrichment) to accept `readonly string[]` directly under a `criteria` key, or stringify (`config.criteria.join(", ")`) for the span attribute. Pick the form the consumer in `tracing/span-enrich.ts` (or wherever) actually wants. Drop the cast.

### 5.5 Tighten `define-dag.ts:69` widening cast

`packages/framework/src/executor/define-dag.ts:69` `input as unknown as DagDefInput`. The generic constraint is erased before `validateDagShape` runs.

Fix: change `validateDagShape`'s signature to accept `DagDefInput<infer Nodes>` (or a structurally-wider parameter that doesn't require erasure). If structurally infeasible without restructuring, downgrade the cast to a `// type-narrowing: generic constraint validated at the generic call site` comment block — but try the structural approach first.

### 5.6 Tighten `queue/in-memory.ts:127` worker dispatch cast

`packages/framework/src/queue/in-memory.ts:127` `job as unknown as JobLike<unknown, unknown>`. S/C generic mismatches silently accepted.

Fix: change the dispatch signature to take `JobLike<unknown, unknown>` natively (the worker is generic-erased at dispatch time by design); annotate the architectural reason in a one-line comment and drop the `as unknown as`. The S/C generics on enqueue are still enforced; the erasure happens cleanly at one well-marked point rather than via a chain of casts.

### 5.7 Fix `wrapDagJobLike.appendEvent` type signature

`packages/framework/src/dag-runtime/run-dag-stateful.ts:118`. Pass-through with `(event: unknown, dedupKey?: string)` — the wrapper's declared `JobLike<…, DagEvent>` surface promises `DagEvent` but accepts `unknown`.

Fix: tighten to `(event: DagEvent, dedupKey?: string) => inner.appendEvent(event, dedupKey)`. Inner is `JobLike<DagPhase, DagMachineContext>` (E defaults to `unknown`), which accepts `DagEvent` (subtype of `unknown`) cleanly. The wrapper's external contract is honest, and TypeScript catches any future widening at the call site.

---

## 6. Wave 6 — Architecture cleanups

### 6.1 Extract `callHumanReviewHook` helper

`packages/framework/src/dag-runtime/executor.ts:152-302`. `awaiting-human` and `retrying-hook` branches are ~70 lines of near-duplicate code.

Fix: private async function `callHumanReviewHook(phase, hooks, nodeMap, nodeCtx, dag): Promise<HumanReviewResult>` that handles: missing-hook check, hook invocation, exception → `node-error`, `approve-with-edit` schema validation. Both `.with()` arms call it; `retrying-hook` prepends `await sleep(delayWithJitter)`. Reduces each branch to ~10 lines. The existing tests cover both branches and should pass unchanged.

### 6.2 Add `now` / `rng` / `warn` seams

Hits four files; ship as one wave-6 PR or split.

- `packages/framework/src/cache/cache.ts` — `InMemoryCache` constructor opt `now?: () => number = Date.now`. Use in `get()` and `set()`.
- `packages/framework/src/state-machine/runner.ts` — `RunOptions.now?: () => number = Date.now`. Use at lines 81 and 105 for `durationMs`.
- `packages/framework/src/observer/policy.ts:16` — `ratio(p: number, rng: () => number = Math.random): PersistencePolicy`. Update the `policy.test.ts` fixture to call with a seeded rng.
- `packages/framework/src/state-machine/replay.ts:133` — accept `opts.warn?: (msg: string) => void = console.warn`. The pure-function header is honest again. Remove the module-level `warnedReplayEventSliceFromZero` (see 6.3).

### 6.3 Replace module-level `warnedReplayEventSliceFromZero` with per-call guard

`packages/framework/src/state-machine/replay.ts:100`. Module-level mutable flag leaks across tests.

Fix: drop the flag entirely. The warning is best-effort developer guidance; firing it on every misuse is fine. Combined with 6.2 (injectable `warn`), tests can capture the warnings deterministically.

### 6.4 Precompute `outgoingByNode` on `DagMachineContext`

`packages/framework/src/dag-runtime/conditional.ts:254`. `outgoingOf` is `dag.edges.filter(...)` — O(E) per call, invoked per active node per wave from `executor.ts:runWave` and `transition-helpers.ts`.

Fix: compute `outgoingByNode: ReadonlyMap<string, readonly EdgeDef[]>` once in `compileDagToMachine` (`dag-runtime/machine.ts`) alongside `incomingByNode`. Add to `DagMachineContext`. Update `wrapDagJobLike.updateData` strip / re-inject (see 5.2 — the new field is in the strip list, re-injected from the live DAG). Replace `outgoingOf(dag, id)` with `machineCtx.outgoingByNode.get(id) ?? []`.

### 6.5 Delete `LegacyTracingConfig`

`packages/framework/src/tracing/init.ts`. `@deprecated` surface on a framework with zero external consumers is dead weight.

Fix: remove `LegacyTracingConfig`, the deprecated overload of `initTracing`, and any internal call site. Update `tracing/index.ts` barrel. Boundary-imports test catches references.

---

## 7. Wave 7 — Test fortification

Test gaps from the test analysis + regressions for waves 1–6. Each item is one or more `*.test.ts` files; cross-reference the wave-N section they protect.

### 7.1 `onTrace` exception isolation (Wave 1.1)

New test file `__tests__/runner-ontrace-throws.test.ts`. Run a state machine to completion with an `onTrace` that throws every call; assert the final state is the expected terminal, no `node-crash` is emitted, and one `console.error` per throw.

### 7.2 `InMemoryQueue` swallowed-failure logging (Wave 1.2)

Extend `__tests__/queue-memory.test.ts`. Enqueue an always-throwing job with no `onFailed` handler; assert `console.error` was called once per exhausted attempt with the expected prefix.

### 7.3 Tool-call iteration as `node-crash` (Wave 1.3)

Extend `__tests__/llm-tool-call.test.ts`. `FakeLlmClient` script emits `maxIterations + 1` tool-use turns; assert single execution, terminal `failed`, `error.kind === "node-crash"`, retry counter `1`.

### 7.4 `ERROR.retriable` short-circuits the retry budget (Wave 1.4)

New test file `__tests__/dag-retriable-classifier.test.ts`. Two cases: classifier returns `retriable: false` → single execution, terminal failed; classifier returns `retriable: true` → full budget burns. Build on existing `RunOptions.classifyError` plumbing.

### 7.5 `ToolDef` capability narrowing + no `as` in `openai-client.ts` (Waves 2.1, 2.2)

Extend `__tests__/boundary-imports.test.ts` to grep `openai-client.ts` for `as any` and fail if any remain. New test fixture in `__tests__/llm-tool-call.test.ts` using `// @ts-expect-error` to assert that hosting a `requires: ["llm"]` tool in a node without `"llm"` is a compile error.

### 7.6 `GuardrailFailed` variant (Wave 2.3)

Extend `__tests__/guardrail.test.ts` with a validator that throws; assert `result.kind === "failed"`, `result.error` is the thrown message; `// @ts-expect-error` that `result.value` is not accessible on the failed branch.

### 7.7 `dagFingerprint` enforced on resume (Wave 2.4)

Extend `__tests__/redis-checkpointer.test.ts`. Write a checkpoint with fingerprint A; build a DAG that produces fingerprint B; attempt resume; assert `kind: "checkpoint-version-mismatch"` and no replay events emitted.

### 7.8 Scheduler enqueue-failure backoff (Wave 4.2)

Extend `__tests__/scheduler-cron.test.ts`. Fault-inject the enqueue; assert second fire happens at `BACKOFF_BASE_MS` (not the cron interval); after success, asserted reset of `consecutiveFailures` (verified by next fire being at cron interval).

### 7.9 `resumeCheckpoint` on the stateful path (review-noted critical gap)

New test file `__tests__/runner-resume-checkpoint-stateful.test.ts`. Build a DAG, write a partial checkpoint via `RunOptions.resumeCheckpoint`. Three sub-cases: (a) all node outputs valid → skip + emit `node-skipped`; (b) cached output fails current `outputSchema` → emit `node-error` with `kind: "validation"`; (c) `writeCheckpoint` throws mid-wave → emit `checkpoint-write-failed`.

### 7.10 `coFailedNodeIds` retry-counter accounting (review-noted critical gap)

Extend `__tests__/dag-runtime-stateful.test.ts`. Two-node wave where both nodes fail in the same execution; assert total executions of each is exactly `retryLimit`, not `retryLimit + 1`.

### 7.11 Scheduler exponential backoff math (review-noted critical gap)

Extend `__tests__/scheduler-cron.test.ts`. Inject a `now` seam (Wave 6.2 not in scope for scheduler — add an internal `clock` opt here if needed). Fault-inject enqueue N times; assert delays `BACKOFF_BASE_MS`, `2*BACKOFF_BASE_MS`, … capped at `BACKOFF_CAP_MS`.

### 7.12 MLflow OTLP exporter coverage

New test file `__tests__/mlflow-otlp-exporter.test.ts`. Fixtures: a `ReadableSpan` with `gen_ai.*` attributes and tool spans; assert (a) span-type uppercasing, (b) input/output event→attribute merge, (c) Proxy wrap behavior for object-valued attributes, (d) failed-permanently latching after malformed URL, (e) rate-limited log emission cadence.

### 7.13 `span-enrich.ts` cost arithmetic + PII gate

New test file `__tests__/span-enrich.test.ts`. Cases: (a) cost formula `(tokensIn * inputPer1M + tokensOut * outputPer1M) / 1_000_000` with known table entries; (b) `includeContent: false` (default) — prompt/response content not on span; (c) `includeContent: true` — content present; (d) `extraInputs` branch with array and record values.

### 7.14 `cost.ts` and `span-attribute-registry.ts`

New test files. `cost.test.ts`: every entry in `PRICE_TABLE` round-trips through `computeCostUsd`; unknown model returns 0 (or `null` — match current behavior); negative tokens guard. `span-attribute-registry.test.ts`: register/retrieve, multi-write merge semantics.

### 7.15 `TailSamplingProcessor` TTL eviction + cap

Extend `__tests__/tail-sampling-processor.test.ts`. Inject `now` seam; populate buffer past `MAX_BUFFERED_TRACES`; assert eviction policy; advance `now` past `BUFFER_TTL_MS`; assert eviction sweep.

### 7.16 `BufferedObserver.evictStale`

Extend `__tests__/buffered-observer.test.ts`. Inject `now` (already supported); populate a run buffer without `run-end`; advance time past `ttlMs`; trigger sweep; assert buffer deleted and `evicted` counter incremented.

### 7.17 `dispatchToolCall` invalid_input branch

Extend `__tests__/llm-tool-call.test.ts`. Tool with strict `inputSchema`; LLM emits a tool call with a payload that fails Zod parse; assert the `invalid_input` error branch fires.

### 7.18 Property tests

Single new file `__tests__/framework-property-suite.test.ts` (or extend existing property files).

- `computeDedupKey`: same `(prevStateKey, attempt, eventType)` → same key; distinct triples → distinct keys (cap 1000 runs, expect zero collisions).
- `applyJitter`: result ∈ `[base * (1 - ratio), base * (1 + ratio)]` for all `(base, ratio, random) ∈ [0,1e6] × [0,1] × [0,1]`.
- `diffRegistry`: idempotency — `diff(d, d).add === [] && remove === [] && update === []` for all `d`.
- `replayEvents`: deterministic — same events in same order produces same state.

### 7.19 Real-timer flake elimination

Convert these to use injected `now` (Wave 6.2):

- `state-machine-runner.test.ts:387` — `durationMs` band test.
- `scheduler-cron.test.ts` — `makeNowSupplierForDelay(30)` + `wait(80)` patterns.
- `queue-memory.test.ts:218` — 5ms TTL real timer.
- `ontrace-run-end-ordering.test.ts` — seed the `runId` LCG instead of using `Math.random`.

---

## 8. Wave 8 — Comment + doc sweep

Mechanical sweep. One PR. All cosmetic — no behavior changes.

### 8.1 Strip Wave §N.M references in inline comments

Replace each with one of: an ADR citation if the invariant is ADR-backed; a one-line inline statement of the invariant; deletion if the surrounding code is self-evident. Files (line refs as found by the review):

- `observer/buffered.ts:32-35, 76` — Wave 3 §3.5
- `tracing/mlflow-otlp-exporter.ts:162-165, 222-226` — Wave 3 §3.7, §3.2
- `queue-bullmq/adapter.ts:211-214` — Wave 3 §3.3
- `state-machine/runner.ts:47-51` — Wave 4 §4.3 (keep "third generic defaults to `unknown` for source-compat" as the invariant)
- `llm/anthropic-client.ts:201-208` — keep ADR-0012 ref, strip Wave 4 §4.4
- `dag-runtime/executor.ts:43-48, 192-196, 273-276, 99-110` — Wave 2 §2.5, Wave 7 §7.3/§7.6
- `dag-runtime/transition-helpers.ts:252-259` — Wave 3 §3.6, Wave 7 §7.3 (keep fail-fast rationale)
- `state-machine/replay.ts:79-82` — Wave 7 §7.7 rename note (delete entirely)
- `scheduler/scheduler.ts:75, 112, 118, 159` — four Wave 3 §3.9 refs
- `queue-bullmq/job.ts:15, 188` — Wave 3 §3.10 (keep "atomic dedup-then-XADD via single Lua script" invariant)

### 8.2 Strip Wave §N.M references in README

`packages/framework/README.md:5, 54, 68, 74, 116, 121-122, 131, 137`. Replace plan-section refs with ADR citations (where applicable) or strip parenthetical entirely.

### 8.3 Delete what-comments

- `llm/anthropic-client.ts:144, 149, 158, 292, 297`
- `dag-runtime/executor.ts:336-338, 340, 389-391`
- `observer/buffered.ts:98, 125, 238, 243`
- `state-machine/runner.ts:58-59, 167`
- `tracing/mlflow-otlp-exporter.ts:275`

### 8.4 Fix stale line-number reference

`dag-runtime/executor.ts:136-140` cites `runWave:341`; the actual guard is line 345. Either update or remove the citation. Line-number refs rot quickly — prefer naming the function/section.

---

## Out-of-scope (follow-ups)

Items deferred from this pass, captured so they don't fall through:

- **`outputNodeId` type-narrowing through `DagDef` to `runDagStateful` return type.** Threading the inferred output-node id so `runDagStateful` returns `Result<typeof effectiveDag["nodes"][outputNodeId]["outputSchema"]["_output"], FrameworkError>` is a substantial type-level refactor. Capture as `docs/plans/2026-05-NN-typed-dag-output.md` when prioritized.
- **`shared/node-span.ts` placement.** OTel imports in `shared/`. Either move to `shared/tracing/` or co-locate with `tracing/`. Decision deferred — not load-bearing.
- **`decideRoute` double invocation.** `executor.ts` and `transition-helpers.ts` each evaluate `decideRoute` for the same wave. Comment acknowledges determinism, but carrying `Decision` on the `wave-done` event would avoid the re-evaluation. Defer to a perf pass.
- **`InMemoryBackend.drain()` concurrency parity with BullMQ.** `drain()` ignores `opts.concurrency`. Tests written against in-memory pass and fail against BullMQ. Either honor concurrency in `drain()` or document the discrepancy.
- **`validateDagShape` / `recordFromNodeArray` on the barrel.** README lists them but no external consumer needs them. Candidate for removal in a future barrel-narrowing pass.

---

## Acceptance criteria

A wave is complete when:

1. All items in the wave have their fix landed.
2. The regression tests called out under Wave 7 for that wave pass.
3. The full framework test suite passes (`bun test packages/framework`).
4. `bun run tsc --noEmit` (or the project's typecheck command) is clean.
5. The boundary-imports test passes (no new OTel imports outside `shared/` and `tracing/`).
6. No `as any` or `as unknown as` introduced; any `as` cast carries a one-line justification.

PR description must list the wave number, the items addressed, and link to the regression test file(s).
