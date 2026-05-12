---

# Plan: Framework PR-review remediation — pass 3 (`feat/initial-setup`)

**Created:** 2026-05-11
**Status:** Draft
**Goal:** Resolve every finding from the 2026-05-11 multi-agent review of `packages/framework/**` that ran against the post-pass-2 state (`4a99b4e`). Each wave is an independent PR.

**Source review:** 6-agent fan-out (`/loom:review-pr`: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead). Aggregate: **4 critical, 41 advisory**.

**Licence:** Framework still has zero external consumers (README §"Adding to the public surface"). Treat the public surface as freely editable — no semver, no shims, no migration code.

---

## 0. Decisions baked in

These are non-trivial architectural calls the review surfaced as "unresolved questions." They are decided here so subsequent waves are mechanical.

- **D1 — Keep `Checkpointer` + `RedisCheckpointer` + `InMemoryCheckpointer`. (Revised 2026-05-11 during Wave 3 implementation.)** The architecture-agent's review missed that `apps/customer-summary` actively wires `RedisCheckpointer` in `bootstrap.ts` (`cp.saveNode(...)` is called from the `ContextCacheAdapter.writeCheckpoint` hook) and `server.test.ts` uses `InMemoryCheckpointer` to test resume flow. The framework runtime doesn't call Checkpointer itself — that part of the review was correct — but the interface is the documented consumer-side seam for durable per-node checkpoint storage. Keep the interface, the two implementations, and the three `checkpoint-*` error kinds. The `dagFingerprint` + `FRAMEWORK_VERSION` enforcement also stays on `Checkpointer.setMeta` rather than moving. **Net change:** no deletion; revisit only if customer-summary is also being rewritten.
- **D2 — Delete `AsyncMutex` exports.** No production call sites. Library shipping a synchronization primitive nothing internally uses is an attractive nuisance. Wave 3.
- **D3 — `runStateMachine` is public.** Already the documented durability core; consumers who want a non-DAG machine use it directly. Fix typing inconsistencies (Wave 4) and document the executor-determinism + JSON-stringifiable-state requirements; do not hide.
- **D4 — Framework-level `Logger` injected at init.** Parallel to `initTracing`. Default backed by `console`. Replaces every `console.error`/`console.warn` in kernel/queue/scheduler/observer. Nodes still see it via `ctx.logger`. Wave 5.
- **D5 — Framework-level `Tracer` injected at init.** Same shape as D4. Default reads `trace.getTracer("ai-summary-framework")` (current behaviour). Test seam: pass a recording tracer. Wave 5.
- **D6 — `BufferedObserver` and `TailSamplingProcessor` share one `PersistencePolicy` instance per run.** Currently they decide independently; if their policies diverge, events and traces also diverge. Wave 5.
- **D7 — `runDag` is the single recommended public entry.** `runDagStateful` and `runDagAsWorkerJob` are demoted out of the main barrel into an `@ai-summary/framework/advanced` subpath export. README updated. Wave 5.
- **D8 — Keep the `DagDef` brand, add `withRetryLimits(dag, limits): DagDef`** as the only sanctioned derivation. The current `effectiveDag = { ...dag, retryLimits }` spread in `run-dag-stateful.ts:177` is replaced. Wave 3.
- **D9 — Defer `Cache` ↔ `ContextCacheAdapter` collapse. (Revised 2026-05-11.)** `apps/customer-summary/bootstrap.ts` constructs `RedisCache` and wraps it in an inline `ContextCacheAdapter`. Collapsing the two interfaces in the framework requires a coordinated change to the app's adapter code. The dual-interface smell is real but cleanup belongs in a coordinated framework+app pass, not in a framework-only wave. Defer to follow-up.

---

## Scope and triage

| Wave | Theme | Risk if deferred |
|------|-------|------------------|
| 1 | Critical runtime correctness (4 items) | `aborted` cancellation misreported; stale-task scheduler drift; dropped audit-log events; eval-judge quality gates silently disabled |
| 2 | Silent-failure / observability hardening | Span leaks attributed to TTL; rate-limit storms indistinguishable from logic crashes; OTel shutdown noise |
| 3 | Dead-code removal & interface consolidation (D1, D2, D8, D9 + in-memory-job relocate) | Orphan surface ossifies; future contributors reach for `AsyncMutex` or `Checkpointer` without realising nothing uses them |
| 4 | Type-system tightening | Capability narrowing voided at run boundary; `EdgeDef` ambiguity; structured errors lost at event boundary; generic-param order chaos |
| 5 | Architectural refactors (D4–D7 + module splits + boundary lints) | `shared/` keeps leaking OTel; transition-helpers 579 lines / run-dag-stateful 458 lines accrete more concerns |
| 6 | Test coverage gaps (10 missing tests + 3 quality fixes) | Untested critical paths regress invisibly; flaky wall-clock tests false-fail in CI |
| 7 | Comment + doc rot sweep | Temporal references rot the moment plans are archived |

Waves 1–2 are merge blockers. Wave 3 should precede Waves 4–6 to avoid editing code that's about to be deleted. Wave 7 runs last to avoid churn.

---

## 1. Wave 1 — Critical runtime correctness

### 1.1 Fast-fail `aborted` errors in `handleNodeFailed`

`packages/framework/src/dag-runtime/transition-helpers.ts:259-269`. The fast-fail guard already lists `predicate-malformed`, `validation`, `checkpoint-write-failed`, and `node-crash { retriable: false }`, but omits `aborted`. A caller cancelling via `AbortSignal` sees `{ kind: "retry-exhausted" }` instead of `{ kind: "aborted" }` after the budget burns. The test at `__tests__/dag-runtime-stateful.test.ts:645` papers over this with `expect(["aborted","retry-exhausted"]).toContain(...)` — a contradictory dual-outcome assertion that signals the bug.

**Fix:** add `error.kind === "aborted"` to the fast-fail guard list. `transient` stays retriable (it is genuinely transient — rate limits clear).

**Regression test (6.1):** caller-initiated abort during retry budget, assert single `aborted` outcome.

### 1.2 Eliminate stale-task closure capture in scheduler

`packages/framework/src/scheduler/scheduler.ts:107-127, 164-192`. `scheduleTask` captures `task` by closure; the `.then(() => rescheduleTask(task, ...))` callback uses that stale reference even if `reconcile` has since updated `task.id` with a new cron expression or `validForMs`. Same problem on the `.catch` → `rescheduleTaskWithBackoff` path. The scheduler can permanently re-arm with retired config.

**Fix:** inside every timer-completion callback, look the current task up from `activeRegistry` instead of closing over `task`:

```typescript
.then(() => {
  consecutiveFailures.delete(task.id);
  const current = activeRegistry.get(task.id);
  if (current) rescheduleTask(current, triggeredAt);
})
```

Apply to `.then`, `.catch`, `rescheduleTask`, and `rescheduleTaskWithBackoff`. Also: clear `consecutiveFailures.delete(task.id)` inside `disarmTask` so a removed-then-re-added task starts fresh.

**Regression test (6.2):** schedule a task, fire timer, before `.then()` resolves call `reconcile` with an updated cron, assert the re-arm uses the new config.

### 1.3 Stable retry-counter keying in `runStateMachine`

`packages/framework/src/state-machine/runner.ts:121-154`. `retryCounters` only increments on self-loops (`stateKey === prevStateKey`), but the DAG machine transitions `running → retrying → running → retrying` via distinct state keys. Two successive `running → retrying` transitions therefore compute the **same** `dedupKey` (because `retryCounters[running]` is still `0` and `event.type` is identical). The BullMQ Lua dedup script (`XREVRANGE … COUNT 1`) suppresses the second event. The audit stream loses retry history.

**Fix:** count non-self-loop retries too, keyed on `(prevStateKey, event.type)` rather than just `stateKey`. Add the keyer hook from D3 / Wave 4.7 (`Machine.stateKey`) so JSON-stringification isn't load-bearing.

Concrete change to `state-machine/runner.ts`:

```typescript
// Before
const isSelfLoop = stateKey === prevStateKey;
if (isSelfLoop) retryCounters.set(stateKey, (retryCounters.get(stateKey) ?? 0) + 1);

// After
if (machine.isRetryTransition?.(prevState, nextState)) {
  const key = `${prevStateKey}::${event.type}`;
  retryCounters.set(key, (retryCounters.get(key) ?? 0) + 1);
}
```

`computeDedupKey` reads the counter via the same composite key.

**Regression test (6.3):** multi-attempt failure scenario, assert every `node-failed` event appears in the event log.

### 1.4 Surface eval-judge exceptions as `passed: false`

`packages/framework/src/dag-runtime/eval-judges.ts:46-58`. The current fail-open returns `{ passed: true, skipped: true }` on any exception. Consumers filtering on `passed` count broken judges as passing. The OTel span is correctly ERROR-flagged but `evalJudgeFailed` (used by `run-dag-stateful.ts` to flip the run-end span) is never set.

**Fix:** the catch block returns `{ passed: false, skipped: true, error: { kind: "judge-crash", message } }` (extend `EvalJudgeResult` with a `crash` discriminant). `runDagStateful` already aggregates a `evalJudgeFailed` flag from `passed === false`; this restores quality-gate signal.

The current behaviour (caller doesn't crash) is preserved — the judge failure is structurally visible without throwing into the run.

**Regression test (6.4):** judge that always throws; assert run completes, `passed === false`, `skipped === true`, span is ERROR, `evalJudgeFailed` set on run-end.

---

## 2. Wave 2 — Silent-failure / observability hardening

### 2.1 Preserve `transient` kind in `retry-exhausted.lastError`

`packages/framework/src/dag-runtime/transition-helpers.ts:323`. Currently `error.kind === "node-crash" ? error.message : JSON.stringify(error)`. A rate-limit storm exhausts as a JSON blob; operators can't tell it from a logic crash without parsing.

**Fix:** extend to also unwrap `transient`:

```typescript
lastError:
  error.kind === "node-crash" ? error.message :
  error.kind === "transient"  ? error.message :
  JSON.stringify(error),
```

Better: add a `rootErrorKind: FrameworkError["kind"]` field to the `retry-exhausted` variant so consumers can pattern-match without string parsing. This is a richer fix — adopt it.

### 2.2 Log inside background-finalize error-recovery `catch` blocks

`packages/framework/src/dag-runtime/run-dag-stateful.ts:335-355`. Three empty `catch {}` blocks inside the `finalize().catch(...)` handler. If `rootSpan.end()` or `emitRunEnd("error")` throws during cleanup, the span leaks until the 1-hour `BufferedObserver` TTL eviction and the eviction log misattributes the cause.

**Fix:** replace each `catch { }` with `catch (err) { fwLogger.error("[runDagStateful] X threw during error cleanup:", err) }`. Uses the framework logger from D4 / Wave 5.1 — until D4 lands, use `console.error` with the same prefixes.

### 2.3 Wrap exporter `forceFlush` in `TailSamplingProcessor`

`packages/framework/src/observer/tail-sampling-processor.ts:202`. After `Promise.allSettled([...this.pendingExports])` the code does `await this.exporter.forceFlush?.()` unguarded. If the exporter rejects, the rejection escapes into the OTel SDK shutdown sequence and looks like an application crash in process supervisors.

**Fix:**

```typescript
if (this.exporter.forceFlush) {
  await Promise.resolve(this.exporter.forceFlush()).catch((err) => {
    fwLogger.error("[TailSamplingProcessor] exporter.forceFlush failed:", err);
  });
}
```

### 2.4 Reshape `warnedMalformedIds` to avoid silent suppression

`packages/framework/src/queue-bullmq/event-log.ts:194`. Module-level `Set<string>` capped at 1000. Persists across test files (Bun module cache is per-process). Under load, the cap silently silences the very signal operators need.

**Fix:** instead of capping the unique-id set, track `totalMalformedCount: number` and log every 100th occurrence after the first 10, plus the count. Reset on test boundaries via an exported `__resetEventLogState()` (test-only; not on the public barrel).

---

## 3. Wave 3 — Dead-code removal & interface consolidation

### 3.1 ~~Delete `Checkpointer` family~~ — DROPPED per revised D1

The Checkpointer interface is live consumer surface (customer-summary `bootstrap.ts` and `server.test.ts`). No change to `checkpoint/**` in this wave.

### 3.2 Delete `AsyncMutex` exports (D2)

- Delete `packages/framework/src/state-machine/mutex.ts` and `__tests__/state-machine-mutex.test.ts`.
- Remove the comment in `packages/framework/README.md` listing `AsyncMutex` as intentionally-not-exported.

### 3.3 ~~Collapse cache surfaces~~ — DEFERRED per revised D9

Requires a coordinated framework+app change (customer-summary's `bootstrap.ts` adapter would simplify by ~25 LOC after collapse). Deferred to a follow-up pass that touches the app.

### 3.4 Move `in-memory-job.ts` consumer-side

- Move `packages/framework/src/state-machine/in-memory-job.ts` → `packages/framework/src/queue/in-memory-job.ts`. The kernel directory should no longer ship an implementation of its own `JobLike` dependency.
- Update the barrel re-exports in `packages/framework/src/index.ts` (lines 25-26) accordingly.
- Update `packages/framework/src/queue/in-memory.ts:adaptInMemoryJob` to import from the new location (one-line change).
- Move `__tests__/in-memory-job-dedup.test.ts` import path.

### 3.5 Add `withRetryLimits` helper (D8)

`packages/framework/src/types/dag.ts` — export:

```typescript
export const withRetryLimits = (
  dag: DagDef,
  retryLimits: Readonly<Record<string, number>>,
): DagDef => brandAsDagDef({ ...unBrand(dag), retryLimits });
```

`packages/framework/src/dag-runtime/run-dag-stateful.ts:177` — replace `{ ...dag, retryLimits: ... }` with `withRetryLimits(dag, ...)`. Any other ad-hoc spread of a `DagDef` falls under the same lint.

Add a regression test: `withRetryLimits` is the only public way to derive a `DagDef`; document inline.

---

## 4. Wave 4 — Type-system tightening

### 4.1 Add `kind: "unconditional"` discriminant to `EdgeDef`

`packages/framework/src/types/dag.ts:64-67`. The three-variant union currently identifies the unconditional case by *absence* of `when` and `kind`. `isUnconditionalEdge` does `!("when" in e) && !("kind" in e)`. Brittle.

**Fix:** add explicit `kind: "unconditional"` to the variant. Update `isUnconditionalEdge` to single-field check `e.kind === "unconditional"`. Update edge-construction sites (`defineDag` / `defineDagFromArray`) to stamp `kind: "unconditional"` when neither `when` nor `kind === "default"` is supplied. Update `EdgeDefInput` to accept the implicit form for ergonomic authoring but materialise the explicit `kind` after validation.

Update serialization/golden fixtures: `__tests__/__fixtures__/dag-fingerprint.golden` — bump `FRAMEWORK_VERSION` in `src/version.ts` (the explicit `kind` field changes the byte-stable hash).

### 4.2 Replace `node-crash.retriable?: boolean` with explicit discriminant

`packages/framework/src/types/errors.ts:30-34`. `undefined` and `true` both mean "retriable" per a comment. Replace with `retriability: "retriable" | "non-retriable"` (no optional, no `undefined`-means-default).

Updates: every `err({ kind: "node-crash", ... })` construction site sets `retriability` explicitly. `handleNodeFailed` fast-fail guard becomes `error.kind === "node-crash" && error.retriability === "non-retriable"` (cleaner than `=== false`).

### 4.3 Add structured error to `NodeErrorEvent`

`packages/framework/src/types/events.ts:44`. `error: string` discards the `FrameworkError.kind`. Add:

```typescript
export interface NodeErrorEvent {
  readonly type: "node-error";
  // ...existing fields
  readonly error: string;                    // keep for human-readable display
  readonly frameworkError: FrameworkError;   // structured; new — required, not optional
}
```

Emit sites (`shared/run-node.ts:140, 207`) populate both. Observer consumers (`BufferedObserver`, `RecordingObserver`) pass through unchanged.

### 4.4 Narrow `NodeSkippedEvent.reason`

`packages/framework/src/types/events.ts:35`. Two producers (`"checkpoint"`, `"already-completed"`); change `reason: string` to `reason: "checkpoint" | "already-completed"`. Matches `NodePrunedEvent.reason`'s narrow style.

### 4.5 Thread a validated capability-context token

`packages/framework/src/shared/run-node.ts:156-159`. The cast from `BaseNodeContext` to `TypedNodeContext<R>` voids the compile-time narrowing. Replace with a phantom-typed token produced by `validateCapabilities`:

```typescript
declare const __capabilitiesValidated: unique symbol;
export type ValidatedNodeContext = NodeContext & { readonly [__capabilitiesValidated]: true };

export const validateCapabilities = (
  dag: DagDef,
  ctx: NodeContext,
): Result<ValidatedNodeContext, FrameworkError> => { /* ... */ };
```

`runNodeShared` accepts `ValidatedNodeContext` and the cast at the run boundary becomes `as TypedNodeContext<R>` against an already-validated input. Any path that bypasses `validateCapabilities` now fails at compile time.

### 4.6 Standardize generic-parameter order to `<S, E, C>`

Audit and rewrite the kernel API surface for consistency:

- `state-machine/types.ts`: `Machine<S, E, C>` (already correct), `JobLike<S, C, E>` → `JobLike<S, E, C>`, `Executor<S, C, E>` → `Executor<S, E, C>`, `RunOptions<S, C, E>` → `RunOptions<S, E, C>`, `RecordedEvent<E>` (unchanged), `TraceEvent<S, E>` (unchanged).
- `state-machine/runner.ts`: `runStateMachine<S, E, C>(job: JobLike<S, E, C>, machine: Machine<S, E, C>, executor: Executor<S, E, C>, opts: RunOptions<S, E, C>)`.
- All call sites in `dag-runtime/run-dag-stateful.ts`, `dag-runtime/machine.ts`, `dag-runtime/executor.ts`, test files.

### 4.7 Add `Machine.stateKey` hook

`packages/framework/src/state-machine/types.ts`. Add optional `stateKey?: (state: S) => string`. `runStateMachine` defaults to `JSON.stringify(state)` when not provided. DAG machine supplies a structural keyer (`compileDagToMachine`). Document in the JSDoc that custom machines storing `Map`/`Set`/`Date` in `S` must implement this.

Used by Wave 1.3's stable retry-counter keying.

### 4.8 Make `RunOptions.errorEventOf` required at the type level

`packages/framework/src/state-machine/runner.ts:96-103` runtime-checks something the type already declares as required. Fix the call-site optionality:

```typescript
// Before
export async function runStateMachine<S, E, C>(
  job, machine, executor, opts?: RunOptions<S, E, C>,
): Promise<void> { /* checks if (!opts?.errorEventOf) */ }

// After
export async function runStateMachine<S, E, C>(
  job, machine, executor, opts: RunOptions<S, E, C>,
): Promise<void> { /* no runtime check needed */ }
```

Drop the runtime guard. Update callers (just `runDagStateful` and tests).

### 4.9 Tighten `LlmRequest.nodeId` and `SendWithToolsRequest.nodeId`

`packages/framework/src/llm/client.ts:44, 87`. Make `nodeId: string` required (was optional). The only caller in production is `runNodeShared`, which always supplies it. Drops the silent `"<llm>"` fallback in error attribution.

### 4.10 Tighten `DeadLetterOpts` error param consistency

`packages/framework/src/queue/types.ts:153-158`. `getRecipients(id, err: unknown)` vs `formatMessage(id, err: string)`. Both should take `err: unknown`; let each implementation decide how to format. One-line change to the type, update the BullMQ adapter's default `formatMessage` to stringify internally.

---

## 5. Wave 5 — Architectural refactors

### 5.1 Inject framework `Logger` at init (D4)

New module: `packages/framework/src/logger.ts`:

```typescript
export interface FrameworkLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

let _logger: FrameworkLogger = consoleLogger;
export const setFrameworkLogger = (l: FrameworkLogger) => { _logger = l; };
export const fwLogger = (): FrameworkLogger => _logger;
```

Add `logger?: FrameworkLogger` to `TracingConfig` (or a new `initFramework({ logger, tracing })` umbrella). Default behaviour unchanged — `consoleLogger` is the existing implementation in `shared/defaults.ts`.

Replace `console.error`/`console.warn` call sites in:

- `state-machine/runner.ts:71-84, 161-173`
- `dag-runtime/run-dag-stateful.ts:336, 344-354`
- `queue-bullmq/adapter.ts:68-70, 163`
- `queue-bullmq/event-log.ts:155, 215`
- `queue/in-memory.ts:140, 150, 158`
- `scheduler/scheduler.ts` (every `console.*` site)
- `observer/buffered.ts:80, 191, 244`
- `observer/tail-sampling-processor.ts:106, 116, 132`

Note: observer/tracing exception isolation (the *swallowing*) is preserved — only the logging mechanism changes.

### 5.2 Inject framework `Tracer` at init (D5)

New module: `packages/framework/src/tracing/global-tracer.ts`:

```typescript
let _tracer: Tracer = defaultTracer();
export const setFrameworkTracer = (t: Tracer) => { _tracer = t; };
export const fwTracer = (): Tracer => _tracer;
```

Replace `trace.getTracer("ai-summary-framework")` call sites at `shared/node-span.ts:79`, `dag-runtime/run-dag-stateful.ts:30, 210`, `dag-runtime/eval-judges.ts:13, 28`, `llm/spans.ts:*`. `initTracing` populates `_tracer`.

Test seam: `RecordingTracer` in `__tests__/_recording-tracer.ts` lets tests assert on span trees without OTel SDK setup.

### 5.3 Share one `PersistencePolicy` per run between observer + tail sampler (D6)

`packages/framework/src/observer/buffered.ts` and `packages/framework/src/observer/tail-sampling-processor.ts`. Today each holds its own policy reference. Plumb a single `PersistencePolicy` into both at construction; one decision per run.

Update `initTracing` (or the framework-init umbrella from 5.1/5.2) to accept `persistencePolicy?: PersistencePolicy` and wire it into both. Default to `alwaysOn`.

### 5.4 Demote `runDagStateful` + `runDagAsWorkerJob` from main barrel (D7)

`packages/framework/src/index.ts:38-49` — remove the `dag-runtime/*` re-exports of `runDagStateful`, `runDagAsWorkerJob`, `compileDagToMachine`, `buildDagExecutor`, `dagTransition`. They move to a new `packages/framework/src/advanced.ts` barrel (kernel-mode entrypoints + transition primitives for callers building custom machines).

Update `packages/framework/package.json` to expose the subpath:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./advanced": "./src/advanced.ts"
  }
}
```

Update README to describe the two surfaces; `runDag` becomes the single sanctioned public entry.

### 5.5 Relocate `shared/run-node.ts` + `shared/node-span.ts` and add boundary lint

`packages/framework/src/shared/run-node.ts` and `packages/framework/src/shared/node-span.ts` import `@opentelemetry/api` and mint spans. Move:

- `shared/run-node.ts` → `dag-runtime/run-node.ts`
- `shared/node-span.ts` → `dag-runtime/node-span.ts`

Update all imports (call sites in `dag-runtime/executor.ts`, tests).

`packages/framework/src/scripts/check-imports.ts` — add a rule: `shared/**` must not import from `@opentelemetry/api`, `observer/**`, `tracing/**`. Add corresponding cases to `__tests__/boundary-imports.test.ts`.

### 5.6 Split `dag-runtime/transition-helpers.ts`

579 lines, 6 independent concerns. Split into:

- `packages/framework/src/dag-runtime/retry-policy.ts` — `computeBackoffMs`, `getRetryLimit`, `handleNodeFailed`, `handleHookCrash`
- `packages/framework/src/dag-runtime/wave-resolution.ts` — `handleWaveDone`, `advanceToNextWave`, `collectHumanReviewQueue`, `waveNodes`, `activeWaveNodes`, `waveIndexOf`
- `packages/framework/src/dag-runtime/human-resolution.ts` — `handleHumanResponse`, `resolveHumanApproved`

`dag-runtime/transition.ts` imports from all three. Tests in `__tests__/dag-transition.test.ts` continue to test the composed function; add focused unit-test files alongside the new modules.

### 5.7 Split `dag-runtime/run-dag-stateful.ts`

458 lines doing 4 jobs. Split into:

- `dag-runtime/persistence.ts` — `wrapDagJobLike`, `stripNonPersistable`, the `PersistableDagMachineContext` type
- `dag-runtime/run-telemetry.ts` — OTel root-span + observer run-start/run-end emission
- `dag-runtime/run-dag-stateful.ts` (slim) — orchestration only: builds the executor, calls `runStateMachine`, returns the result
- `dag-runtime/eval-judge-runner.ts` — already exists at `eval-judges.ts`; move the background-mode plumbing here

### 5.8 Single `decideRoute` evaluation per wave

`packages/framework/src/dag-runtime/executor.ts:419-465` and `dag-runtime/transition-helpers.ts:103-122` both compute `decideRoute` for the same wave. Hoist the decision into `handleWaveDone` and return it as part of the wave-done event:

- Add `routingDecision?: ReadonlyMap<string, RouteDecision>` to `wave-done` event variant.
- `runWave` reads the decision from the transition output to emit observer events; no re-evaluation.

### 5.9 Honour `WorkerOpts.concurrency` in the in-memory backend

`packages/framework/src/queue/in-memory.ts:187`. Validates the option, then ignores it. Two choices:

- **Honour it.** Run `n` concurrent `processFn` calls via `Promise.all` and reshift on completion. Aligns in-memory behaviour with BullMQ; concurrency bugs surface in fast unit tests.
- **Forbid `> 1`.** Throw `RangeError("InMemoryQueue does not support concurrency > 1")` if a caller sets it.

**Pick honour-it.** The test-environment gap (BullMQ tests run on opt-in `REDIS_URL`) means concurrency bugs are otherwise invisible.

### 5.10 Universalize `now: () => number` injection

Audit and add `now?: () => number` (with `Date.now` default) to:

- `dag-runtime/executor.ts:147`
- `dag-runtime/run-dag-stateful.ts:179`
- `observer/buffered.ts:185, 200`
- `observer/tail-sampling-processor.ts:81, 93`
- `queue-bullmq/job.ts:126`

Convert `CronSchedulerOpts.now?: () => Date` to `now?: () => number`; convert call sites to `new Date(opts.now())` where a `Date` was needed. One time-injection convention across the framework.

### 5.11 Update README boundary claim

`packages/framework/README.md` — the line:

> `executor/**` and `dag-runtime/**` must not import from each other (shared utilities live in `shared/`).

is wrong (`executor/` → `dag-runtime/` is allowed and used). Rewrite:

> `dag-runtime/**` must not import from `executor/**`. The reverse direction is allowed: `executor/` is the public-API wrapper around `dag-runtime/`.

Add to the README's "Boundary rules" section the new rules from 5.5 (`shared/` cannot import OTel / observer / tracing).

---

## 6. Wave 6 — Test coverage gaps

Test files live under `packages/framework/src/__tests__/`. Each item below is one focused regression test file or test block.

### 6.1 `aborted` fast-fail (paired with 1.1)

`__tests__/abort-fast-fail.test.ts`. Caller-initiated abort during retry budget; assert single `aborted` outcome, no retry-budget consumption. Removes the misleading `expect(["aborted","retry-exhausted"]).toContain(...)` at `dag-runtime-stateful.test.ts:645`.

### 6.2 Scheduler stale-task closure (paired with 1.2)

`__tests__/scheduler-reconcile-mid-fire.test.ts`. Schedule task with cron A; fire timer; before `.then()` resolves, `reconcile` with cron B; assert the next re-arm uses cron B.

### 6.3 Multi-attempt event log (paired with 1.3)

`__tests__/event-log-retry-history.test.ts`. Failing node with retry budget 3; assert all 3 `node-failed` events appear in the BullMQ stream (using `EventLogReader`).

### 6.4 Eval-judge crash (paired with 1.4)

`__tests__/eval-judge-crash.test.ts`. Throwing judge; assert run completes, `passed === false`, `skipped === true`, span is ERROR, `evalJudgeFailed` set.

### 6.5 `runStateMachine` missing-errorEventOf — DELETED

Removed by Wave 4.8 — `errorEventOf` is now required at the type level; the runtime guard is gone.

### 6.6 `BufferedObserver` policy-throw cleanup

`__tests__/buffered-observer-policy-throw.test.ts`. `policy.shouldFlush` throws; assert buffer map is empty afterward (the `try/finally` purpose). This is a regression-prone hot spot — currently any implementation that drops the `finally` passes existing tests.

### 6.7 `BufferedObserver.evictStale`

`__tests__/buffered-observer-eviction.test.ts`. Open a buffer with short TTL; call `evictStale` directly with a controllable clock; assert `evicted === 1`, buffer map is empty, framework logger received the warn line.

### 6.8 `advanceToNextWave` multi-wave fallback

`__tests__/advance-multi-wave-fallback.test.ts`. 3-wave DAG `[["a"],["b"],["c"]]`; nodes `b` and `c` pruned from `activeNodeIds`; only `a` produced output. `advanceToNextWave(2, ctx)` must traverse backward past two empty waves and return `a`'s output.

### 6.9 `partialOutputs` merge on retry

`__tests__/handle-node-failed-partial-outputs.test.ts`. `handleNodeFailed(0, "a", err, ctx, partials={"b" → "b-out"})`; assert `result.context.outputs.get("b") === "b-out"`.

### 6.10 `computeBackoffMs` monotonicity property test

`__tests__/compute-backoff-property.test.ts`. `fast-check` property: for any backoff array and attempt index, `computeBackoffMs(attempt+1) >= computeBackoffMs(attempt)`. Guards against off-by-one in the `Math.min` clamp.

### 6.11 Scheduler exponential backoff growth

`__tests__/scheduler-backoff-growth.test.ts`. Drive `rescheduleTaskWithBackoff` with 1, 2, 3, 4 consecutive failures; assert backoff times are `BACKOFF_BASE_MS`, `2× base`, `4× base`, `8× base`, capped at `BACKOFF_CAP_MS`.

### 6.12 `callHumanReviewHook` no-hook path

`__tests__/executor-no-human-hook.test.ts`. DAG reaches `awaiting-human`, no `onHumanReview` supplied; assert the resulting event is `node-failed` with the exact message `"awaiting-human: no onHumanReview hook supplied"`.

### 6.13 `isRetryTransition` direct unit test

`__tests__/state-machine-is-retry-transition.test.ts`. Pass a custom `Machine` with an `isRetryTransition` that flags non-self-loop transitions; assert the trace outcome is `"retry"` on the flagged transition.

### 6.14 Fix non-deterministic concurrent-dependents race test

`__tests__/scheduler-concurrent-dependents.test.ts:68-101`. Today the test passes because of async scheduling luck. Either:

- Use a deterministic approach (mock the marker store to force the TOCTOU overlap), or
- Assert the race *would* fail without the guard and document what the guard is.

Pick deterministic — the guard becomes visible in the test.

### 6.15 Replace wall-clock test with `opts.now` seam

`__tests__/state-machine-runner.test.ts:385-401` ("durationMs reflects executor wall time within tolerance"). Replace `setTimeout(r, 50)` + `>= 40` floor with a fake clock via `opts.now`. The seam exists; the test should use it.

### 6.16 `BufferedObserver` + `TailSamplingProcessor` shared policy (paired with 5.3)

`__tests__/shared-persistence-policy.test.ts`. Same policy instance handed to both; assert that when the policy returns `false`, both event buffer and span buffer are dropped.

---

## 7. Wave 7 — Comment + doc rot sweep

### 7.1 Stale/lying comments

- `packages/framework/src/dag-runtime/eval-judges.ts:1` — delete "used by both the legacy executor and the state-machine path" (no second caller exists).
- `packages/framework/src/executor/executor.ts:3-7` — delete the "legacy fast-path / runDagInner retired" migration narrative. Preserve the three named responsibilities at lines 12-17.
- `packages/framework/src/dag-runtime/executor.ts:415-419` — delete the historical "previously produced the confusing observer sequence" preamble. Keep the `predicate-malformed` fast-fail rationale from "`handleNodeFailed` special-cases…" onward.

### 7.2 Temporal references

- `packages/framework/src/dag-runtime/run-dag-stateful.ts:56` — drop "mirroring legacy parity" from the `onBackground` JSDoc.
- `packages/framework/src/dag-runtime/run-dag-stateful.ts:301` — rewrite to `// Background mode: caller resolves before judges finish, so request-bound timeouts don't block on judge I/O.`
- `packages/framework/src/shared/index.ts:4-5` — delete the `breaking the executor/ ↔ dag-runtime/ cycle that previously forced…` clause.
- `packages/framework/src/types/errors.ts:30` — rewrite the `retriable?: boolean` comment as part of Wave 4.2 (the field is gone, so the comment is moot).
- `packages/framework/src/dag-runtime/run-dag-stateful.ts` (`wrapDagJobLike`) — delete the `(from before this wrapper was used)` parenthetical.
- `packages/framework/src/state-machine/runner.ts:157` — rewrite `// CRITICAL-3:` comment per Wave 1.3 result (the dedup-key change supersedes the original CRITICAL-3 rationale).

### 7.3 What-comments

- `packages/framework/src/llm/anthropic-client.ts:144, 148, 158` — delete `// Extract thinking content if present`, `// Extract tool use result`, `// Parse with zod`.
- `packages/framework/src/scheduler/catch-up.ts:32, 38, 43, 47` — delete the four `// Case N:` inline labels (JSDoc above already lists them).
- `packages/framework/src/tracing/mlflow-otlp-exporter.ts:275, 281, 293` — delete the step-2/3/4 numeric labels; keep step-1 and step-5 WHY clauses.

### 7.4 Multi-paragraph docstrings

- `packages/framework/src/types/dag.ts:24-40` — collapse the `Predicate<O>` docstring to two lines (shape + ADR-0016 reference).
- `packages/framework/src/dag-runtime/machine.ts:549-560` — collapse `compileDagToMachine` docstring to two lines.
- `packages/framework/src/types/node.ts:88-107` — reduce the Capability design block to two condensed WHY sentences; drop the runtime-validation bullet (validation is documented by `validateCapabilities` itself).

### 7.5 Dead parameters and redundant casts

- `packages/framework/src/scheduler/scheduler.ts:192` — delete the `after` parameter on `rescheduleTaskWithBackoff` and the `void after` comment. Update call sites.
- `packages/framework/src/nodes/llm.ts:60` and `packages/framework/src/nodes/llm-with-tools.ts:79` — remove the redundant `as O` casts; the discriminated union already narrows.

### 7.6 README rewrites

- `packages/framework/README.md` — the layer-rule fix from Wave 5.11 above.
- Drop the `### checkpoint/` references to `Checkpointer` (Wave 3.1).
- Drop `AsyncMutex` reference (Wave 3.2).
- Add the `@ai-summary/framework/advanced` subpath description (Wave 5.4).
- Add the `setFrameworkLogger` / `setFrameworkTracer` init pattern (Waves 5.1, 5.2).

### 7.7 Test file comment cleanup

- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts` — the `it.skip` comment block. Drop "Wave 6 §6.1 gate fix" / "was never executed before the gate fix" references. Keep the mechanical race description.

---

## Sequencing summary

```
PR-A (Wave 1)            : 4 critical correctness fixes + tests 6.1–6.4
PR-B (Wave 2)            : 4 silent-failure hardening fixes
PR-C (Wave 3)            : Delete Checkpointer + AsyncMutex; collapse Cache;
                           relocate in-memory-job; add withRetryLimits
PR-D (Wave 4)            : Type-system tightening (10 sub-items)
PR-E (Wave 5)            : Architectural refactors (11 sub-items)
PR-F (Wave 6 — remainder): Tests 6.6–6.16
PR-G (Wave 7)            : Comment + doc sweep
```

PRs A and B are merge blockers; C runs before D/E to avoid editing soon-deleted code; D and E can interleave but D first reduces churn in E; F lands after the code it tests is in; G runs last.

**Estimate:** ~7 PRs over ~3 days of focused work for a single contributor; parallelisable to ~1 day with 3 contributors if PRs A/B/C land first.

---

## Out of scope (followups)

- **Branded ID types (`RunId`, `DagId`, `NodeId`).** Touches every error-construction site and every observer event. Defensive benefit (preventing argument swap) is real but blast radius is wide. Capture as a separate pass-4 plan.
- **Threading `outputNodeId` through `DagDef` to narrow `runDagStateful`'s return type.** Already deferred from pass-2 D3; still deferred.
- **Replacing handrolled `Result` with a third-party Either library.** No motivating need; current `result.ts` scored 5/5 across all type-design dimensions.
- **`apps/customer-summary/**`.** Out of scope for this pass per the original review brief.

### Deferred from this pass to a follow-up (2026-05-12) — landed 2026-05-12

The three Wave 5 items below were deferred from the main pass-3 sequence and landed in a single follow-up commit on the same day. All three were implemented as designed; full framework suite remains green (666 pass / 0 fail).

- **W5.6 — Split `dag-runtime/transition-helpers.ts` (596 LOC)** → `retry-policy.ts` (computeBackoffMs, getRetryLimit, handleNodeFailed, handleHookCrash), `wave-resolution.ts` (handleWaveDone, advanceToNextWave, waveNodes/activeWaveNodes/waveIndexOf, collectHumanReviewQueue, WaveDoneResult), `human-resolution.ts` (handleHumanResponse + extracted handleReroute). `handleHumanResponse` was rewritten using `ts-pattern` (`match(action).with(...)` over the `HumanAction` discriminated union) — replaces the manual switch + `_exhaustive: never` guard. Boundary check (`scripts/check-imports.ts`) updated to scope the OTel-forbidden rule to all three new files. Test imports refreshed across `dag-transition.test.ts`, `pass-2-remediation.test.ts`, `pass-3-remediation.test.ts`.
- **W5.7 — Split `dag-runtime/run-dag-stateful.ts` (480 LOC)** → `persistence.ts` (`wrapDagJobLike` + `stripNonPersistable` + `PersistableDagMachineContext`), `run-telemetry.ts` (`beginRunTelemetry`, `startRunSpan`, `closeRootSpan` with a `RootSpanOutcome` discriminated union, plus `outcomeFromMeta`), `eval-judges.ts` extended with `finalizeRunWithJudges` and `runFinalizeInBackground` (the defensive cleanup wrapper for `onBackground` mode). The slim orchestrator is now ~280 LOC and reads as control flow only. The unexpected-non-terminal branches collapse into a single `unexpectedNonTerminal` helper.
- **W5.8 — Single `decideRoute` evaluation per wave.** Added `routingDecisions?: ReadonlyMap<string, Decision>` to the `wave-done` event variant in `dag-runtime/types.ts`. `runWave` now computes decisions exactly once per source node, attaches them to the event, and emits `route-decided`/`node-pruned` observer events from the same decisions. `handleWaveDone` accepts an optional fourth parameter and prefers the precomputed map; the inline `decideRoute` fallback path is preserved for hand-crafted/replayed events that lack the field. The reroute path in `human-resolution.ts` still re-evaluates predicates (different use case — rebuilding active set after a backward jump, not a wave-done).
