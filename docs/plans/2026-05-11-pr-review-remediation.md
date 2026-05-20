---

# Plan: Remediation of `feat/initial-setup` PR review findings (framework)

**Created:** 2026-05-11
**Status:** Draft
**Goal:** Resolve every finding from the multi-agent PR review of `packages/framework/**` against `main`. Nothing is deferred — Phase-5 work (legacy-path retirement, runNode dedup, module-cycle break) is folded into the waves. Each wave is an independent PR.

**Source review:** chat session 2026-05-11 — 7 critical, 22 advisory findings + test gaps across code-reviewer / silent-failure-hunter / pr-test-analyzer / type-design-analyzer / comment-analyzer / architecture-tech-lead.

**Decisions baked in:**

- **D1 = A** — `onBackground` stays supported on the SM path; we write ADR-0018 to align the design record with the code, and harden the `finalize().catch` to always close the span + emit `run-end`.
- **D2 = include everything** — legacy-path retirement, `runNode` dedup, and the `executor/ ↔ dag-runtime/` cycle are in scope.
- **D3 = aggressive** — strip internal helpers from the public `src/index.ts` barrel now, while there are no external consumers.

---

## Scope and triage

| Wave | Theme | Risk if deferred |
|------|-------|------------------|
| 1 ✅ | Quick blockers (`null`-as-`number` cast, retry trace outcome, FRAMEWORK_VERSION enforcement, stale ADR-0017 comments, `scheduler/` boundary lint) | Wrong telemetry, silent v1↔v2 checkpoint resume, doc rot |
| 2 ✅ | Durability critical-path (checkpoint serialization, `finalize` span/run-end, legacy checkpoint failure, `approve-with-edit` schema) | Resume corruption, orphaned spans, output-shape corruption |
| 3 ✅ | Observability silent failures (TailSamplingProcessor, MlflowOtlpExporter, BullMQ close, DLQ notifier, dispatchEvent, predicate-malformed) | Invisible data loss, undetectable partial shutdowns |
| 4 ✅ | Public-surface + type hygiene (barrel strip, `JobLike<E>`, `runtime as NodeContext`, `as DagDef` cast, ContextCacheAdapter miss/hit) | Locked-in semver surface, type-erased domain events |
| 5 ✅ | Architecture cleanups — namespace move, ADRs 0018/0019/0020, no-jobLike warning | Boundary regressions, future maintainer confusion |
| 6 ✅ | Test fortification (Redis NOSCRIPT, BullMQ dedup, AsyncMutex double-release, property tests, regressions for waves 1-2) | Silent reintroduction of waves 1-2 bugs |
| 7 | Structural refactors (runNode dedup, executor/dag-runtime cycle, legacy-path retirement, OpenAI client `any`-cleanup, capability-typed NodeContext, `applyJitter` extraction) | Permanent two-path tech debt |
| 8 | Final polish — comment sweep beyond ADR-0017, `code-simplifier` pass, ADR cross-link audit | Cosmetic |

Each wave is a separate PR. Waves 1–4 are merge blockers for the branch; waves 5–8 follow and may overlap.

---

## 1. Wave 1 — Quick blockers ✅ DONE 2026-05-11

Independent edits with low coupling and high signal. All XS–S effort.

**Status:** complete. Typecheck clean. 570 pass / 0 fail / 29 Redis-gated skips. Boundary lint extended to scheduler/** with 4 new synthetic-fixture tests; cron-parser added to package.json.

### 1.1 Remove `null as unknown as number` cast on eval-judge crash path ✅

`packages/framework/src/dag-runtime/eval-judges.ts:53`. `EvalJudgeResult.score` is already `number | null` (per `nodes/eval-judge.ts:29`). Just write `score: null`. Drop the cast. Add a unit test that forces the judge to throw and asserts `score === null`.

### 1.2 Fix `"retry"` trace outcome detection in the runner ✅

`packages/framework/src/state-machine/runner.ts:109`. `isRetry = stateKey === prevStateKey` is wrong for the DAG machine: `running → retrying` is a *state change*, so retries are reported as `"success"` in the trace. Change to:

```ts
const isRetry =
  nextState != null &&
  typeof nextState === "object" &&
  "kind" in nextState &&
  ((nextState as { kind: string }).kind === "retrying" ||
   (nextState as { kind: string }).kind === "retrying-hook");
```

Or, cleaner: have machines declare an optional `isRetryState(s): boolean` predicate and call that. Prefer the helper — it keeps the runner generic. Add an `isRetryState` field to the kernel `Machine<S, C, E>` type with a default of `() => false`. For the DAG machine, return `s.kind === "retrying" || s.kind === "retrying-hook"`.

Regression test in wave 6 (§6.12).

### 1.3 Enforce `FRAMEWORK_VERSION` on checkpoint resume ✅

ADR-0017 bumped `FRAMEWORK_VERSION` to `"2"` so v1 checkpoints would be rejected; the enforcement was never wired.

- `packages/framework/src/checkpoint/redis-checkpointer.ts` `load()`: read `frameworkVersion` from the meta key (already written); if it doesn't match the imported `FRAMEWORK_VERSION`, return `err({ kind: "checkpoint-version-mismatch", expected, actual, runId })`.
- `packages/framework/src/types/errors.ts`: add the new variant to `FrameworkError`.
- Update any exhaustive matches on `FrameworkError` (use TypeScript's `never`-default exhaustiveness check; the compiler will list them).
- Test: write a v1-shaped meta payload to Redis, attempt to `load()`, assert the new error kind.

### 1.4 Stale ADR-0017 comment sweep ✅

ADR-0017 removed `deps` / `optionalDeps` from `NodeDef`; the references survived in five places:

- `packages/framework/src/executor/define-dag.ts:4-5` — describes "deps ↔ edges" and "optionalDeps partitioning" as live checks. Replace with the actual current validation surface (edge endpoints, else-totality, output reachability, edge uniqueness, predicate well-formedness).
- `packages/framework/src/types/dag.ts:82-85` — claims `deps`/`optionalDeps` "remain" in `NodeDef`. **Delete the paragraph.**
- `packages/framework/src/dag-runtime/machine.ts:66` — "deps mismatch" referenced as a known failure class. Drop the phrase; keep the rest of the comment.
- `packages/framework/src/dag-runtime/executor.ts:360` — `optionalDeps` reference; replace with "optional sources from `incomingByNode`".
- `packages/framework/src/executor/executor.ts:94` — `onBackground` labeled as "legacy-path flag". Rewrite per the corrected behavior (see Wave 2 §2.2 — `onBackground` works on both paths).
- `packages/framework/src/executor/executor.ts:155` — opaque `SC-001` reference. Replace with a sentence explaining the legacy fast-path stability contract: same behavior as the original single-path executor, new features go through `runDagStateful`.

### 1.5 Add `scheduler/` boundary rule to `check-imports.ts` ✅

`packages/framework/src/scripts/check-imports.ts:48-69`. Add:

```ts
{
  name: "scheduler-no-queue-bullmq",
  matches: (file) => file.startsWith("packages/framework/src/scheduler/"),
  forbiddenImports: [
    /^bullmq($|\/)/,
    /^ioredis($|\/)/,
    /^.*\/queue-bullmq\//,
  ],
  reason: "scheduler/** must remain transport-agnostic (see scheduler.ts file header)",
},
```

The scheduler's file-header comment already claims this; CI just doesn't enforce it. Add an assertion to `boundary-imports.test.ts` that the rule fires for a synthetic violation.

### 1.6 Verify `cron-parser` dependency ✅

`packages/framework/src/scheduler/scheduler.ts:2` claims "already in monorepo" — `cron-parser` is not in `packages/framework/package.json`. Either:

- Add `cron-parser` to `packages/framework/package.json` (preferred — explicit deps per package), or
- Add a comment explaining the workspace hoist that resolves it.

Pick the explicit dep. Update `bun.lock`/`bun.lockb` accordingly.

---

## 2. Wave 2 — Durability critical-path ✅ DONE 2026-05-11

The findings that can corrupt state in production.

**Status:** complete. Typecheck clean. 573 pass / 0 fail / 29 Redis-gated skips. 3 new regression tests added; 1 existing test flipped to assert new behavior. §2.3 regression test deferred to Wave 6 (no clean unit-test seam without OTel SDK integration).

### 2.1 Strip non-serializable fields from the BullMQ checkpoint payload ✅

`packages/framework/src/dag-runtime/types.ts`, `packages/framework/src/queue-bullmq/job.ts:85`. `DagMachineContext` includes:

- `incomingByNode: ReadonlyMap<string, IncomingSources>` — derived from `dag.edges` at compile time
- `dag: DagDef` — carries `nodes: NodeDef[]` with `run` function closures

`serializeValue` round-trips `Map` correctly but turns `run` closures into `{}`. On BullMQ resume `nodeMap.get(nodeId)` returns `undefined` for every node — every node emits `"node-not-found"`.

Plan:

- Define `SerializableDagMachineContext` as `DagMachineContext` minus `incomingByNode` and `dag`.
- Add `toSerializable(ctx, dag) → SerializableDagMachineContext` and `fromSerializable(serialized, dag) → DagMachineContext` helpers (recompute `incomingByNode` from `dag.edges`).
- `adaptBullMQJob.updateData` writes `serializeValue(toSerializable(d, dag))`; `adaptBullMQJob` constructor takes the DAG so resume can `fromSerializable`.
- Add an assertion in `toSerializable` that `serializeValue(result)` round-trips bit-identically (defends against future drift).

Coupled with §2.2 because both fixes touch `run-dag-stateful.ts`.

### 2.2 `runDagStateful` resume must not re-`compileDagToMachine(input)` ✅

`packages/framework/src/dag-runtime/run-dag-stateful.ts:131-161`. When `opts.jobLike` is supplied, the resumed `initialInput` may differ from the call-site `input`. Today `compileDagToMachine(effectiveDag, input)` runs unconditionally and the runner ignores its `initialState/initialContext`, which works by accident — but `compileDagToMachine`'s `topoSort` cycle check runs against the *current* DAG every time, masking a real risk: a DAG-def change mid-flight using stale wiring.

Plan:

- Branch: if `opts.jobLike` is provided, skip `compileDagToMachine`. Derive `machine` from the runner-resumed context.
- The `initialInput` comes from the persisted context (`fromSerializable`), not from the call-site `input`. The call-site `input` is ignored on resume; document this in `DagRunOpts.input`.
- Add a test: enqueue a job with input `A`, crash, resume with input `B` — assert the run finishes with the effects of input `A` only.

### 2.3 `finalize().catch` must close the span and emit `run-end` ✅ (regression test deferred to Wave 6)

`packages/framework/src/dag-runtime/run-dag-stateful.ts:224-228`. Today:

```ts
const p = finalize().catch((e) => {
  console.error("[runDagStateful] background finalize failed:", e);
});
opts.onBackground(p);
```

Must become:

```ts
const p = finalize().catch((e) => {
  console.error("[runDagStateful] background finalize failed:", e);
  try { rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(e) }); } catch {}
  try { rootSpan.end(); } catch {}
  try { emitRunEnd("error"); } catch {}
});
opts.onBackground(p);
```

Wrapped in their own `try` because each cleanup is independent — a failure in `setStatus` must not prevent `end()`.

Add a regression test: provide an `onBackground` that surfaces the captured promise; arrange for `runEvalJudges` to throw; assert that the test observer received `run-end` with `status: "error"` and the span is `ended`.

### 2.4 Legacy path: surface checkpoint write failures, don't warn-and-continue ✅

`packages/framework/src/executor/executor.ts:380-385`. Today writeCheckpoint failure is `console.warn` + continue, returning `ok(value)`. The next crash-resume re-runs the node, breaking idempotency.

Plan:

- On `writeCheckpoint` failure, return `err({ kind: "checkpoint-write-failed", nodeId, runId, cause })`.
- Add `"checkpoint-write-failed"` to `FrameworkError` if not already present.
- The legacy path's outer error handler returns this as the run error.
- Test: inject a checkpointer whose `writeCheckpoint` throws; assert the run resolves to `Err` (not `Ok`) and the checkpoint key is absent.

### 2.5 `approve-with-edit.newOutput` must validate against `nodeDef.outputSchema` ✅ (implementation differs from plan — see note)

`packages/framework/src/dag-runtime/transition-helpers.ts:392-394`. Today `action.newOutput` (typed `unknown`) is written directly into `ctx.outputs.set(currentState.nodeId, action.newOutput)` with no validation.

Plan:

- `handleHumanResponse` needs access to `nodeDef.outputSchema`. The transition layer is pure, so threading a `NodesRecord` (or `(nodeId) => NodeDef`) into the function signature is the cleanest fix.
- On `approve-with-edit`: call `nodeDef.outputSchema.safeParse(action.newOutput)`. If `!success`, return a `failed` phase with `error: { kind: "validation", nodeId, message }`.
- Update all callers of `handleHumanResponse` to pass the node-lookup.
- Test: dispatch `approve-with-edit` with output that fails schema; assert `failed` + `kind: "validation"`. Add a positive test that valid `newOutput` is accepted.

**Implementation note (deviation from plan):** Validation lives in the imperative shell (`buildDagExecutor`'s `awaiting-human` and `retrying-hook` handlers) rather than inside the pure transition. Reason: Zod schemas don't survive JSON serialization (they're closure-rich objects); on resume `ctx.dag.nodes[i].outputSchema` would be `{}`. The shell holds `nodeMap`, built from the live call-site `dag`, so its schemas are always callable. On validation failure the shell emits `node-failed` with `kind: "validation"` — the existing hook-crash retry path then re-prompts the reviewer, giving them a chance to fix bad input. After retry budget exhaustion the run fails with the validation message preserved.

---

## 3. Wave 3 — Observability silent failures ✅ DONE 2026-05-11

These are the silent-failure-hunter findings that aren't already in Wave 2.

**Status:** complete. Typecheck clean. 576 pass / 0 fail / 29 Redis-gated skips. 6 new tests added; 3 existing tests flipped to assert the new behavior (DLQ propagation, BullMQ Lua dedup path).

### 3.1 `TailSamplingProcessor.trackExport` must surface failures ✅

`packages/framework/src/observer/tail-sampling-processor.ts:117-123`. Today:

```ts
const p = exportAsync(this.exporter, spans).catch((err) => {
  console.error(...);
});
this.pendingExports.add(p);
```

`.catch` converts rejection to resolved-`undefined` before `add` — `forceFlush` can't detect failures. Plan:

- Track the original promise plus a separate `exportFailed` counter:
  ```ts
  const p = exportAsync(this.exporter, spans);
  p.catch((err) => {
    console.error(...);
    this.exportFailed++;
  });
  this.pendingExports.add(p);
  p.finally(() => this.pendingExports.delete(p));
  ```
- `forceFlush` uses `Promise.allSettled` and surfaces aggregated failures via the existing return contract.
- Expose `exportFailed` via `getMetrics()` or similar so operators can alert.
- Test: configure an exporter that rejects all calls; assert `forceFlush` resolves but the failure counter incremented; the inner-rejection log fired.

### 3.2 `MlflowOtlpExporter` initialization failure must log at the failure point ✅

`packages/framework/src/observer/mlflow-otlp-exporter.ts:103-110`. Today `failedPermanently` is set in the `catch`, the subsequent `export()` short-circuits before any log line — a misconfigured exporter drops all spans with zero log output.

Plan: in the `factory().catch` block, `console.error` with the resolved error and a one-time "[mlflow-otlp] permanent initialization failure, all future exports will be dropped" line. Use a boolean to ensure single-emission.

### 3.3 BullMQ adapter `close()` must surface partial failures ✅ (kept Promise<void>; throws AggregateError)

`packages/framework/src/queue-bullmq/adapter.ts:163-165, 199-201`. Worker/queue close errors are downgraded to `console.warn`; `close()` returns `Promise<void>` even when half the workers failed to drain.

Plan: collect into `const errors: Error[] = []`, `Promise.allSettled`, append each rejection's reason. Return shape change: `Promise<{ ok: true } | { ok: false; errors: Error[] }>`. Update callers (likely few — `index.ts` re-exports it). Test: spawn an adapter, make one worker reject on close (mock); assert structured failure.

### 3.4 DLQ notifier failure must propagate ✅

`packages/framework/src/queue/dead-letter.ts:62-74`. The justification in the comment ("don't propagate notifier failure") is wrong — the job is already dead, the notification *is* the only remaining action.

Plan: rethrow after logging. The caller wires this into the BullMQ failed-job handler; the BullMQ event will already be in a failed state, so rethrowing surfaces it via the worker's `failed` listener rather than swallowing. Add a test: notifier throws → caller sees the throw.

### 3.5 `dispatchEvent` broad catch should error-log with stack and support a strict mode ✅

`packages/framework/src/observer/buffered.ts:66-68`. The current catch swallows any exception with a one-line warn. Programming bugs in observer implementations vanish.

Plan:

- Change the log line to `console.error` with stack: `e instanceof Error ? e.stack : String(e)`.
- Add an env-toggled `OBSERVER_STRICT=1` mode that rethrows; on in tests, off in prod.
- Don't change the prod default (observer failures should never crash a run).

### 3.6 `predicate-malformed` should short-circuit, not fall through to `wave-done` ✅

`packages/framework/src/dag-runtime/executor.ts:474-517`. Observer sequence today: `node-error → wave-done → failed`. That's contradictory from an operator's view.

Plan: when `decideRoute` returns `predicate-malformed`, emit `node-error` and return a `node-failed` `DagEvent` from `runWave` directly (analogous to a real node failure). `handleNodeFailed` already handles the transition. The duplicate `predicate-malformed` re-detection in `handleWaveDone` (transition-helpers.ts:108) can then be deleted. Add a test asserting the new event sequence and removing the test that asserts the old one.

### 3.7 Span attribute JSON parse failures should log ✅

`packages/framework/src/observer/mlflow-otlp-exporter.ts:162, 171`. Bare `catch {}` (no binding). The `{ raw: data }` fallback is indistinguishable from legitimate raw output.

Plan: `catch (e) { console.warn(\`[mlflow-otlp] failed to parse span attr JSON for trace ${traceId}: ${e}\`); spanInputs["raw"] = data; }`. Rate-limit via a per-process counter that emits at 1, 10, 100, 1000 occurrences.

### 3.8 Malformed Redis Stream entry IDs should warn, not silently map to epoch ✅

`packages/framework/src/queue-bullmq/event-log.ts:196-200`. Today: `Number.isFinite(ms) ? ms : 0`. A corrupt entry ID maps to `1970-01-01`, and forensic time-range queries silently include it.

Plan: `console.warn` once per malformed ID (de-dup via a `Set<string>`). Keep the `0` fallback for backward compatibility but document it on the function.

### 3.9 Scheduler timer error path should back off on unexpected failures ✅

`packages/framework/src/scheduler/scheduler.ts:103-114, 130-143`. The outer `.catch` in the timer callback re-arms immediately. If `markers.set` keeps failing, this is a tight loop at cron-interval frequency.

Plan: track per-task `consecutiveFailures`; on `catch`, schedule the next fire at `min(baseInterval, baseInterval * 2^consecutiveFailures, 30 * 60 * 1000)` (capped at 30 minutes). Reset on success. Test: inject a marker store that rejects N times then succeeds; assert intervals follow exponential pattern.

### 3.10 BullMQ `appendEvent` Lua-script atomic dedup ✅

`packages/framework/src/queue-bullmq/job.ts:130-151`. Two-step `XREVRANGE` + `XADD` relies on BullMQ's lock window. Bumped from Wave 1 because it's a Redis script change with non-trivial coverage requirements.

Plan: write a Lua script that:

1. `XREVRANGE key + - COUNT 1` to peek the last entry
2. Compares the last entry's `dedupKey` field to the argument
3. If equal, return `0` (skipped)
4. Otherwise `XADD key * <fields>` and return the entry ID

Load via `defineCommand` on the ioredis client. Test against a real Redis (the existing redis-gated test pattern). Verify behavior in the "lock window expired" simulation: the Lua script must produce the same result regardless of lock-window timing.

---

## 4. Wave 4 — Public-surface + type hygiene ✅ DONE 2026-05-11

D3 = aggressive. Done now while there are no external consumers.

**Status:** complete. Typecheck clean. 576 pass / 0 fail / 29 Redis-gated skips. Customer-summary app's cache adapter updated alongside §4.6 to keep the workspace coherent. §4.7 reverted after implementation — `ToolDef.run` is contravariant in its input, so `unknown` is stricter than the heterogeneous-tools array needs; documented inline.

### 4.1 Strip internal helpers from `src/index.ts` ✅

`packages/framework/src/index.ts`. Remove from the barrel (keep them as internal imports for tests / call-sites that need them, just don't re-export):

- From `dag-runtime/transition-helpers.js`: `handleWaveDone`, `handleNodeFailed`, `handleHumanResponse`, `advanceToNextWave`, `collectHumanReviewQueue`, `computeBackoffMs`, `getRetryLimit`, `waveNodes`, `waveIndexOf`
- From `state-machine/serialize.js`: `serializeValue`, `deserializeValue`
- From `state-machine/mutex.js`: `AsyncMutex`
- From `scheduler/cycle.js`: `hasCycle`
- From `scheduler/diff.js`: `diffRegistry`

These are pure implementation details. Tests can import them via the original paths.

### 4.2 Move internal utility types out of the public types barrel ✅

`packages/framework/src/types/dag.ts` — `ConsistentNodes`, `OutputOf`, `OutputsByNodeId`, `NodesRecord` are implementation details of `defineDag`'s inference machinery. Move them to a new `packages/framework/src/types/dag-internals.ts` and re-export only into `types/dag.ts` (not into `types/index.ts`). Public `types/index.ts` should re-export only: `DagDef`, `DagDefInput`, `EdgeDef`, `EdgeDefInput`, `Predicate`, plus the guard helpers.

### 4.3 `JobLike` gains the event-type generic ✅

`packages/framework/src/state-machine/types.ts:29`. Today:

```ts
export interface JobLike<S, C> {
  appendEvent(event: unknown, dedupKey?: string): Promise<void>;
}
```

Change to:

```ts
export interface JobLike<S, C, E = unknown> {
  appendEvent(event: E, dedupKey?: string): Promise<void>;
}
```

The default `E = unknown` preserves existing two-generic usage. Then thread the third generic through `runStateMachine`, `Machine`, `createInMemoryJob`, `adaptBullMQJob`. The DAG machine becomes `JobLike<DagPhase, DagMachineContext, DagEvent>`.

### 4.4 `LlmClient.sendWithTools` runtime typing ✅ (cast kept, contract documented)

`packages/framework/src/llm/anthropic-client.ts:180`, `packages/framework/src/llm/client.ts`. Today `sendWithTools(req, runtime: LlmRuntime)` and the impl casts `runtime as NodeContext`.

Plan: introduce `LlmRuntimeWithDispatch = LlmRuntime & Pick<NodeContext, "cache" | "logger" | "llm" | "tracer">` (the actual fields the tool-dispatch loop reads). `sendWithTools` accepts `LlmRuntimeWithDispatch`. The cast disappears. Callers that only have a minimal `LlmRuntime` get a compile-time error directing them to the wider context.

Alternative if the actually-required set is smaller than I think: define exactly what's needed and don't reach into `NodeContext` at all. Audit `tool-dispatch.ts` to confirm.

### 4.5 Replace `as unknown as DagDef` cast in `validateDagShape` ✅

`packages/framework/src/executor/validate-dag.ts:196`. The brand-only cast is legitimate; the structural bypass is not.

Plan:

```ts
const validated: Omit<DagDef, typeof __dagValidated> = {
  nodes: ...,
  edges: ...,
  outputNodeId: ...,
  // ...
};
return validated as DagDef;
```

If the second cast still works (it should, since `__dagValidated` is the only added field), structural changes to `DagDef` will now produce compile errors at the construction site.

### 4.6 `ContextCacheAdapter.get` returns a discriminated hit/miss ✅

`packages/framework/src/types/node.ts:63`. Today: `Promise<unknown | null>`. Replace with:

```ts
type CacheLookup = { hit: true; value: unknown } | { hit: false };
get(key: string): Promise<CacheLookup>;
```

Update implementations: `cache/cache.ts`, `cache/redis-cache.ts`, in-memory caches, and all callers (mostly LLM node and prompts registry).

### 4.7 `SendWithToolsRequest.tools` use `ToolDef<unknown, unknown>` ⚠️ REVERTED (variance constraint)

`packages/framework/src/llm/client.ts:55`. Replace `ToolDef<any, any>` with `ToolDef<unknown, unknown>`. Trivial — implementation already widens internally.

### 4.8 `NodeContext.cache` and `llm` revisit

`packages/framework/src/types/node.ts:74-77`. Stays nullable for now; full capability-typed redesign is Wave 7 (§7.5). Add JSDoc explaining that LLM nodes must null-check or use the capability variant once it lands.

### 4.9 Drop `runtime as NodeContext` documentation rot

After §4.4, the comment near `llm/anthropic-client.ts:180` claiming the cast is safe must be replaced with one explaining the wider runtime requirement.

---

## 5. Wave 5 — Architecture cleanups ✅ DONE 2026-05-11

**Status:** complete. §5.4 (namespace move) and §5.5 (SDK citation) shipped earlier 2026-05-11. ADRs §5.1 (0018), §5.2 (0019), §5.3 (0020) shipped, plus the §5.2 no-jobLike routing warning + `opts.suppressRoutingWarnings` toggle and the §5.3 100-shape ordering property test. Typecheck clean. 580 pass / 0 fail / 29 Redis-gated skips. ADR 0002 and ADR 0007 updated with forward-links to ADR 0018 / ADR 0019.

### 5.1 ADR-0018: `onBackground` on the SM path ✅

Write `docs/adr/0018-onbackground-on-state-machine-path.md`. Document:

- The decision to keep `onBackground` supported on both paths
- The invariant that `finalize().catch` must always close the root span and emit `run-end` (enforced by Wave 2 §2.3)
- The implication: eval-judge results computed in the background are *not* persisted in the durable state-machine (they ride on the same eventual-consistency boundary as ADR-0003's run-end event)
- Update ADR-0002 and ADR-0007 with a forward-link: "Superseded by ADR-0018 regarding `onBackground`."

### 5.2 ADR-0019: routing predicate for SM-vs-legacy path ✅

Write `docs/adr/0019-runtime-routing-predicate.md` documenting that the SM path is selected when *any* of these hold:

- `dagDeclaresHITL` (any node with `humanReview` config)
- `dagDeclaresRetries` (any node with `retry` config OR DAG with `defaultRetryLimit`)
- `dagDeclaresConditionalEdges` (any `EdgeDef.when` present)
- `opts.jobLike` provided
- `opts.retryLimits` provided

Supersedes the partial predicate in ADR-0009.

Add a warning in `executor/executor.ts:100-132` when `dagDeclaresRetries || dagDeclaresConditionalEdges` triggers SM-path routing but no `jobLike` was provided: `logger?.warn?.("DAG declares retries/conditional edges but no jobLike provided — durability across crashes is not guaranteed.")`. Configurable to silent via `opts.suppressRoutingWarnings`.

### 5.3 ADR-0020: `onTrace` vs `run-end` ordering ✅

Document the implicit ordering today (`onTrace` fires inside `runStateMachine`, `run-end` fires from `runDagStateful` afterwards). State this as a contract. Add a test that records both event streams and asserts ordering invariants over 100 random runs.

### 5.4 Move `init-tracing.ts` and `mlflow-otlp-exporter.ts` from `observer/` to `tracing/` ✅ (also moved `span-attribute-registry.ts`)

`packages/framework/src/observer/init-tracing.ts` → `packages/framework/src/tracing/init.ts`. `packages/framework/src/observer/mlflow-otlp-exporter.ts` → `packages/framework/src/tracing/mlflow-otlp-exporter.ts`. Update barrel files. Add namespace clarifying comments in both index files:

```ts
// observer/ is the typed *domain event* bus for the framework runtime.
// For OTel SDK setup and span helpers, see tracing/.
```

Update all consumers (run `git grep "observer/init-tracing\|observer/mlflow-otlp-exporter"`).

### 5.5 Span-attribute registry coupling note ✅

`packages/framework/src/observer/span-attribute-registry.ts:4`. Replace the bare "silently drops" claim with a citation: `// See @opentelemetry/sdk-trace-base @ 1.x — Span.setAttribute() validates against AttributeValue and silently drops non-primitive values. This registry is a deliberate side-channel for MLflow-required structured attrs.`

---

## 6. Wave 6 — Test fortification ✅ DONE 2026-05-11

**Status:** complete. 646 pass / 0 fail / 1 skip (SC-003 — pre-existing BullMQ stalled-job race surfaced by the gate fix, see §6.1 note). All 15 items shipped plus a fix to the Redis-test gating that was silently skipping 29 tests (now they actually run when `REDIS_URL` is set). One minor code change to `AsyncMutex` (§6.4) and one to both LLM clients (§6.10 — 429 → transient). Added `fast-check` devDep for property tests.

### 6.1 `RedisCheckpointer` NOSCRIPT recovery

`packages/framework/src/checkpoint/redis-checkpointer.ts:165-180`. Test: open a real-Redis connection, `await this.saveNodeSha`-loaded write, run `SCRIPT FLUSH`, attempt another `saveNode` call. Assert: write succeeds via inline EVAL fallback, `this.saveNodeSha` is set anew. Redis-gated.

### 6.2 `RedisCheckpointer` `checkpoint-expired` and `checkpoint-corrupt` error kinds

Construct a meta row with `createdAt` older than `TTL_SECONDS * 1000`. Call `load()`. Assert `Err({ kind: "checkpoint-expired" })`. Corrupt-row test: write a meta key with malformed JSON; assert `Err({ kind: "checkpoint-corrupt" })`.

### 6.3 BullMQ-layer `appendEvent` dedup (post §3.10)

Redis-gated test: call `appendEvent(e1, "k1")` twice. Assert only one XADD entry in the stream. Then `appendEvent(e2, "k2")` and `appendEvent(e3, "k1")` — assert three entries (the second "k1" is allowed because "k2" was the most recent and the dedup is "last seen only" per ADR-0014).

### 6.4 `AsyncMutex` double-release semantics

`packages/framework/src/state-machine/mutex.ts`. Today calling `release()` twice would hand the lock to the next waiter twice. Decide: throw on double release, or no-op.

- **Plan:** throw. `release()` becomes:
  ```ts
  let released = false;
  return () => {
    if (released) throw new Error("AsyncMutex: release() called twice");
    released = true;
    // ... existing release logic
  };
  ```
- Test: `const r = await m.acquire(); r(); r()` throws.

### 6.5 `runStateMachine` `updateData` throw after `appendEvent` success

Use a fault-injecting `JobLike` that succeeds `appendEvent` but throws on `updateData`. Assert: runner throws (or returns Err in the wrapped path); event log contains the event; next-resume re-derives the same transition and dedups via `lastDedupKey`. Verifies the at-least-once + dedup contract is robust to this specific crash window.

### 6.6 Concurrent `resolveDependents` for the same upstream task

`packages/framework/src/scheduler/scheduler.ts:198-259`. Fire `resolveDependents` twice in parallel via `Promise.all` with a fault-injecting marker store that delays both `exists` calls so they overlap. Assert: dependent enqueue happens exactly once. May reveal a missing atomic guard — if so, implement Lua-script `SET NX` on the fired marker.

### 6.7 `serializeValue`/`deserializeValue` roundtrip property test

`packages/framework/src/state-machine/serialize.ts`. Use `fast-check` (already in deps per the loom:ts-test-agent description, otherwise add it). Generate arbitrary nested `Map<string, Set<unknown> | Map<string, Value>>` structures. Property: `deepEqual(deserializeValue(serializeValue(x)), x)`.

### 6.8 `diffRegistry` completeness property test

Property: for any `active`, `desired`, `\|add\| + \|unchanged\| + \|update\| + \|remove\| = \|active ∪ desired\|`. The disjointness assertion is already tested; completeness is missing.

### 6.9 `topoSort` ordering property test

Generate a random DAG with a known topological order. Property: for the output waves `[w_0, ..., w_n]`, every edge `(u, v)` has `u`'s wave index ≤ `v`'s wave index. 50 random DAGs.

### 6.10 Anthropic + OpenAI `sendWithTools` HTTP 429 mapping

Mock the SDK to throw the relevant rate-limit error class. Assert the client returns `Err({ kind: "transient", ... })` with the rate-limit message.

### 6.11 (Regression for §2.1, §2.2) BullMQ resume across process restart

Set up a BullMQ adapter against a Redis test instance. Enqueue a run that succeeds the first wave, "crash" (close the worker without acking), reopen, assert the resumed run finishes all nodes correctly via `nodeMap.get` (i.e., `dag` is reconstructed via `fromSerializable`).

### 6.12 (Regression for §1.2) DAG-machine retry trace outcome

Run a DAG with `defaultRetryLimit: 2` and a node that fails once. Capture the trace events. Assert: at least one trace has `outcome: "retry"` (not `"success"`).

### 6.13 (Regression for §3.6) `predicate-malformed` event sequence

Construct a DAG with a malformed predicate. Run. Assert the observer event sequence is `node-start → node-error → run-end(status="error")`, with no intervening `wave-done`.

### 6.14 `BufferedObserver` concurrent flush with shared inner

Two concurrent runs, same `BufferedObserver`, same inner `RecordingObserver`. Each emits a different sequence. Assert: events for each run are contiguous in their relative order (no interleaving of within-run events).

### 6.15 `dagFingerprint` byte-stability golden test

Compute `dagFingerprint(dagA)` once, snapshot. Recompute. Assert byte-identical. Adds a golden file at `packages/framework/src/__tests__/__fixtures__/dag-fingerprint.golden`.

---

## 7. Wave 7 — Structural refactors

Bigger changes that pay back over time. Each is its own PR.

### 7.1 Eliminate `runNode` duplication

`packages/framework/src/executor/executor.ts:310-394` and `packages/framework/src/dag-runtime/executor.ts:53-162`.

Plan:

- Extract `packages/framework/src/executor/run-node.ts` exporting `runNodeShared(node, input, ctx, opts: { emit?, ... })`.
- Both call sites use the shared impl.
- Behavioral differences today (legacy emits fewer observer events) become explicit options on `opts`.
- Property test: feed both call sites the same inputs, assert same observer event sequence.

Depends on §7.2 (the cycle break) being done first or in the same PR, because `dag-runtime/executor.ts` already imports from `executor/`.

### 7.2 Break the `executor/ ↔ dag-runtime/` cycle

Today:

- `dag-runtime/executor.ts` → `executor/validate.ts`, `executor/node-span.ts`, `executor/topo.ts`
- `executor/executor.ts` → `dag-runtime/run-dag-stateful.ts`, `dag-runtime/conditional.ts`

Plan:

- Move shared pure utilities (`validate.ts`, `node-span.ts`, `topo.ts`) into a new `packages/framework/src/shared/` folder.
- Update both directions to import from `shared/`.
- The remaining `executor/executor.ts → dag-runtime/run-dag-stateful.ts` import is the legacy-to-SM bridge; that disappears in §7.3.
- Add to `check-imports.ts`: `executor/` and `dag-runtime/` must not import from each other.

### 7.3 Retire the legacy fast path

ADR-0007 documents the back-compat shim and Phase 5 retirement. With `onBackground` on SM path (Wave 5 §5.1) and shared `runNode` (§7.1), there's no behavioral parity gap.

Plan:

- `executor/executor.ts:runDagInner` is deleted.
- `executor/executor.ts:runDag` becomes a thin wrapper that always calls `runDagStateful`, defaulting `jobLike` to `createInMemoryJob` when not provided.
- `opts.resume` (legacy-only) is reinterpreted: pass through to `runDagStateful` via the resume-from-checkpoint path.
- Update ADR-0007 and ADR-0002 status to "Superseded by §7.3 of 2026-05-11 plan."
- Write ADR-0021: "Single-path runtime — legacy fast-path retired."
- Test: every existing test that used the legacy path keeps passing (no opt-in needed; routing predicate is gone).

### 7.4 OpenAI Responses-API typed traversal

`packages/framework/src/llm/openai-client.ts:79, 82, 112, 119, 121, 230, 231, 377`. ~14 `any` traversal sites.

Plan:

- Replace `b: any`, `c: any` etc. with the OpenAI SDK's exported response types. Where the SDK's types don't fit exactly, define local discriminated unions and use type guards (`b.type === "function_call"` against the typed union, not `any`).
- For uncertainty, run `openai`'s own types through `npm ls openai`/the version pinned in `package.json` and read its `.d.ts`.
- Plan a regression: add a test that intentionally mistypes a field name in a test fixture and confirms it fails to compile (catches the previous "any → silent undefined" failure mode).

### 7.5 Capability-typed `NodeContext`

`packages/framework/src/types/node.ts:74-77`. Today `cache`, `llm`, `prompts`, etc. are all nullable — every LLM node null-checks at every call site.

Plan:

- Introduce a `RequiresLlm` capability marker on `NodeDef`. Nodes declaring `requires: ["llm"]` get a `NodeContext` typed with `llm: LlmClient` (non-null).
- The runtime executor validates capabilities at run-start: if a node requires "llm" and the context has no `llm`, fail fast with `Err({ kind: "missing-capability", capability: "llm" })`.
- Mechanism: a separate `TypedNodeContext<R extends readonly Capability[]>` that strengthens nullable fields based on `R`. The framework's built-in nodes (LLM, eval-judge, etc.) declare their requirements.
- Test: a node declaring `requires: ["llm"]` run against a no-llm context fails immediately at run start, before `node.run` is called.

This is the largest item in the plan. Estimate: full week of focused work + downstream test updates.

### 7.6 Extract `applyJitter` to pure form

`packages/framework/src/dag-runtime/executor.ts:288`. `Math.random()` inline.

```ts
export const applyJitter = (delayMs: number, jitterRatio: number, random: () => number): number => {
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.round(delayMs * (1 + jitter));
};
```

Inject `random` from `opts` with a default of `Math.random`. Test deterministically with a seeded RNG.

### 7.7 Rename `replayEventsBetween` for clarity

`packages/framework/src/state-machine/replay.ts:98-119`. The function folds the `[fromMs, toMs)` slice from a *fixed initial state*, not "fast-forward from a checkpoint at `fromMs`". Callers will misread.

Plan: rename to `replayEventSlice`. Keep `replayEventsBetween` as a `@deprecated` re-export pointing to the new name. Drop the deprecation in the next release.

Add a runtime assertion when `fromMs > 0` and `initial` is structurally the zero state: `console.warn` once per process that the caller may have meant `replayEventsUntil(events, machine, fromState, toMs)` instead.

### 7.8 Phase-5 trigger criteria document

ADR-0022: define what makes the framework "production-validated" enough to retire any subsequent legacy path (now obsolete since §7.3 retires the only legacy path, but the framework will accrue more legacy paths over time; the criteria are evergreen). Roughly:

- ≥30 days running in a production-equivalent environment
- A documented rollout strategy (canary, etc.)
- Test coverage threshold for the new path
- No open critical bugs against the new path
- Operator sign-off

---

## 8. Wave 8 — Polish

### 8.1 Run `loom:code-simplifier` over the framework

After Waves 1-7. Scope: `packages/framework/src/**`. Don't allow it to change behavior — flag any non-obvious change for human review.

### 8.2 Sweep narration-comments outside the ADR-0017 set

Already done in Wave 1 §1.4 for ADR-0017. This pass cleans up the rest from the comment-analyzer report:

- `packages/framework/src/queue-bullmq/adapter.ts:73` — remove
- `packages/framework/src/state-machine/runner.ts:151` — remove
- `packages/framework/src/types/node.ts:41, 46` — replace "Optional for back-compat" with the actual semantics (these are brand-new fields)
- `packages/framework/src/dag-runtime/machine.ts:26-27` — replace `retrying-hook = 50` value-equality comment with WHY
- `packages/framework/src/queue-bullmq/job.ts:127-129` — augment dedup race rationale with the "only the runner's crash pattern" constraint
- `packages/framework/src/checkpoint/redis-checkpointer.ts:113-120` — add software-TTL WHY comment
- `packages/framework/src/dag-runtime/executor.ts:63-67` — append the WHY for the 0/1/≥2 input-shape rule
- `packages/framework/src/dag-runtime/executor.ts:219-221` — rewrite the contradictory retry-wave comment

### 8.3 ADR cross-link audit

`git grep "ADR 00"` across the repo. Verify every ADR reference points to a real, current ADR. Specifically resolve the ADR numbering drift mentioned in `2026-05-10-pr-review-remediation.md` Wave 1 to ensure this plan's ADRs (0018-0022) don't collide. Add a `docs/adr/README.md` index if not present.

### 8.4 Public API docs

After §4.1-4.6, write a short `packages/framework/README.md` listing the public exports and what each is for. Not a tutorial — a reference. Helps the next reviewer challenge surface-area additions.

---

## 9. Cross-cutting concerns

### 9.1 Test infrastructure

- Add `fast-check` to `packages/framework/package.json` devDependencies if not present (needed for §6.7, §6.8, §6.9).
- Document the Redis-gated test pattern in `packages/framework/README.md` or a `TESTING.md` (the test files use `process.env.REDIS_URL` to skip cleanly; this is good but undocumented).

### 9.2 CI

- All waves must pass `bun run check-imports` (defined in `scripts/check-imports.ts`).
- Wave 5 §5.4 adds rules; CI will fail if cross-folder imports regress.
- Wave 7 §7.2 adds the `executor/ ↔ dag-runtime/` no-import rule; the cycle must be broken before this rule is enabled.

### 9.3 Risk: scope creep

The plan is large. Suggested guardrails:

- Each wave PR caps at ~800 LOC diff (excluding tests + ADRs).
- If a wave-item grows beyond its initial scope, split rather than expand.
- Wave 7 is the riskiest — §7.5 in particular. If it bogs down, split it into its own multi-PR thread independently of the remediation timeline.

---

## 10. Sequencing and acceptance

### 10.1 Suggested order

- **Week 1**: Waves 1, 2 (durability critical-path) — these block the branch merge.
- **Week 2**: Wave 3 (silent failures), Wave 4 (type hygiene), Wave 6 (test regressions for Waves 1-2).
- **Week 3**: Wave 5 (architecture + ADRs), remainder of Wave 6.
- **Week 4-5**: Wave 7 (structural refactors). §7.5 may extend longer.
- **Week 6**: Wave 8 (polish).

Parallelizable: Waves 3/4/6 across multiple contributors. Wave 7 §7.1 and §7.2 must precede §7.3.

### 10.2 Acceptance criteria (per wave)

Each wave PR must:

1. Pass all existing tests + add the regression tests listed in that wave.
2. Pass `bun run check-imports` (no new boundary violations).
3. Update affected ADRs if behavior changes.
4. Be reviewed against the Machine Summary section of the original review — link the specific finding(s) addressed.
5. Run `/loom:review-pr` against the wave's diff (scoped to the changed files) and pass with zero new critical findings.

### 10.3 Branch strategy

- Each wave is a feature branch off `feat/initial-setup` (or off `main` after that branch merges).
- Squash-merge each wave PR to keep history scannable.
- Final acceptance for the original `feat/initial-setup` branch: Waves 1-4 merged.
- Waves 5-8 may follow on `main` post-merge.

---

## 11. Findings ↔ wave map

For traceability with the original review's Machine Summary:

| Finding (from review) | Wave |
|---|---|
| CRITICAL: onBackground finalize leaks span / no run-end | 2.3 |
| CRITICAL: runDagStateful checkpoint serialization | 2.1 + 2.2 |
| CRITICAL: "retry" trace outcome misclassified | 1.2 |
| CRITICAL: legacy path swallows checkpoint failure | 2.4 |
| CRITICAL: TailSamplingProcessor swallows export rejections | 3.1 |
| CRITICAL: approve-with-edit bypass schema | 2.5 |
| CRITICAL: FRAMEWORK_VERSION not enforced on resume | 1.3 |
| ADVISORY: null-as-number cast (eval-judges) | 1.1 |
| ADVISORY: runtime as NodeContext cast | 4.4 |
| ADVISORY: BullMQ appendEvent dedup race | 3.10 |
| ADVISORY: stale ADR-0017 comments (×5) | 1.4 |
| ADVISORY: onBackground "legacy" comment | 1.4 + 5.1 |
| ADVISORY: check-imports.ts missing scheduler rule | 1.5 |
| ADVISORY: executor/ ↔ dag-runtime/ cycle | 7.2 |
| ADVISORY: runNode duplication | 7.1 |
| ADVISORY: DLQ notifier swallows | 3.4 |
| ADVISORY: MlflowOtlpExporter permanent-failure silent | 3.2 |
| ADVISORY: BullMQ close swallows | 3.3 |
| ADVISORY: public surface over-exports | 4.1 + 4.2 |
| ADVISORY: dagDeclaresRetries undocumented | 5.2 |
| ADVISORY: predicate-malformed event sequence | 3.6 |
| ADVISORY: JobLike.appendEvent loses E | 4.3 |
| ADVISORY: OpenAI client `any` traversal | 7.4 |
| ADVISORY: applyJitter Math.random | 7.6 |
| ADVISORY: test gaps | Wave 6 (full) |
| ADVISORY: cron-parser misleading comment | 1.6 |
| ADVISORY: replayEventsBetween semantics | 7.7 |
| ADVISORY: span attribute JSON parse bare-catch | 3.7 |
| ADVISORY: malformed Redis Stream entry IDs silently 0 | 3.8 |
| TEST-GAP: Redis NOSCRIPT | 6.1 |
| TEST-GAP: checkpoint-expired/corrupt | 6.2 |
| TEST-GAP: BullMQ Redis-layer dedup | 6.3 |
| TEST-GAP: AsyncMutex double-release | 6.4 |
| TEST-GAP: runStateMachine updateData throw | 6.5 |
| TEST-GAP: scheduler concurrent fire | 6.6 |
| TEST-GAP: serialize property | 6.7 |
| TEST-GAP: diffRegistry completeness | 6.8 |
| TEST-GAP: topoSort ordering | 6.9 |
| TEST-GAP: Anthropic/OpenAI 429 | 6.10 |
| ARCH-GAP: onBackground ADR drift | 5.1 |
| ARCH-GAP: routing predicate ADR | 5.2 |
| ARCH-GAP: onTrace vs run-end ordering | 5.3 |
| ARCH-GAP: observer/tracing namespace | 5.4 |
| ARCH-GAP: legacy path retirement | 7.3 |
| ARCH-GAP: Phase-5 trigger criteria | 7.8 |
| ARCH-GAP: NodeContext capability-typed | 7.5 |
| ARCH-GAP: dispatchEvent strict mode | 3.5 |
| ARCH-GAP: scheduler timer backoff | 3.9 |

---
