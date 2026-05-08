# Plan: Durable State Machine Runtime

**Spec:** `.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`
**Created:** 2026-05-08

## Summary

Add a layered, event-sourced state-machine runtime inside `packages/framework` (no new package): a pure `Machine`/`Executor` kernel, a DAG layer that recompiles the existing `DagDef` into a machine, a backend-agnostic queue layer with a BullMQ adapter (Redis Streams for the per-job event log) and an in-memory adapter, and a cron scheduler with dependency resolution. The current `runDag(dag, input, ctx)` keeps its signature and observable behavior by becoming a thin shim over the new state-machine runner with a no-op `JobLike`.

---

## Architectural Decisions

### AD-1: Single package, layered modules — no new npm package

**Choice:** All new code lives under `packages/framework/src/{state-machine,dag-runtime,queue,queue-bullmq,queue-memory,scheduler}/`. Existing `executor/`, `checkpoint/`, `types/` stay where they are. Spec out-of-scope explicitly forbids `@peterstorm/durable-machine`.
**Why:** Avoids monorepo plumbing; reuses existing build, test, lint, semver. Layering is enforced by a per-folder import-graph rule (lint check), not separate package.json files.
**Rejected:**
- Separate `@peterstorm/durable-machine` package — explicitly out of scope per spec.
- Putting everything inside existing `executor/` — would conflate one-shot DAG walk with state-machine runtime; review/blame becomes muddier.

### AD-2: Backwards-compat — existing `runDag` becomes a shim, not a rewrite

**Choice:** Keep the current `runDag` exported signature and observable behavior. Internally it constructs an in-memory `JobLike`, compiles the `DagDef` into a `Machine<DagPhase, DagEvent, DagMachineContext>`, and calls `runStateMachine`. The OTel root span, observer events (`run-start`, `run-end`, `node-start`, `node-end`, `node-error`, `node-skipped`), eval-judge background path, and `RunOptions.resume`/`onBackground` semantics MUST be preserved unchanged.
**Why:** SC-001 requires the existing executor test suite to pass with zero source modifications. A "rewrite + flag" path would risk silent semantic drift.
**Rejected:**
- Add a parallel `runDagDurable` and leave `runDag` alone — bloats the surface; we'd never get the new behavior under existing call sites.
- Big-bang rewrite of `runDag` body — too risky for SC-001.

### AD-3: Event sourcing via Redis Streams; opaque event-log handle

**Choice:** `JobLike` exposes `appendEvent(event): Promise<void>`. The BullMQ adapter writes to a Redis Stream keyed `events:{queueName}:{jobId}` with `XADD * type=... payload=...`, capped via `XADD MAXLEN ~ 10000` (configurable). Replay reads `XRANGE` and folds events through the pure `transition`. The in-memory adapter keeps an array. Core/DAG modules MUST NOT import ioredis or know stream semantics.
**Why:** Resolves spec Open Question 1. Redis Streams give append-only ordering, range scans, and bounded retention out of the box. Per-queue-per-job key isolates blast radius and makes deletion/TTL natural. `MAXLEN ~ 10000` default keeps long-lived jobs from unbounded growth while preserving enough history for debugging; tunable via `EventLogOpts`.
**Rejected:**
- Single global stream with job-id label — harder to delete, harder to scan one job, contention on a hot key.
- Redis Lists (`LPUSH`/`LRANGE`) — no consumer-group story if we ever want fan-out replay.
- Postgres / append-only files — adds a new dependency surface; Redis already required for BullMQ.

### AD-4: TraceEvent — single post-transition event, FROM-state semantics

**Choice:** `onTrace` fires once after each transition with `{ state, event, nextState, outcome, durationMs, timestamp }`. `state` is the state we transitioned FROM (matches reclaw's existing convention and design plan), `nextState` is the state we transitioned TO. `outcome` is `"success" | "retry" | "skipped" | "failed"`. No pre-transition event.
**Why:** Resolves spec Open Question 2. One event per transition keeps observers simple; carrying both `state` and `nextState` removes ambiguity and supports both before- and after-style downstream consumers without firing twice. Matches FR-007 / NFR-011 (no extra synchronous I/O).
**Rejected:**
- Pre-only — loses the `nextState` info consumers need to render edges.
- Pre + post pair — doubles observer load and complicates dedup.

### AD-5: Retry layering — machine-level inner loop, queue-level outer crash fallback

**Choice:** Document precedence as: (1) per-state `Machine.maxRetries` and per-node `DagDef.retryLimits` are the *inner* loop — they handle expected transient failures (LLM timeout, API 429) inside one queue attempt without giving the job back to the queue. (2) Queue-level `attempts` (BullMQ `attempts`/`backoff`) is the *outer* fallback — it covers process crashes, lock loss, and exhaustion of the inner loop. (3) When the machine reaches a `failed` terminal state, the runner throws (FR-007) so the queue's outer loop can apply its policy. (4) On a fresh queue attempt, transient retry counters reset (FR-011) so a worker restart does not inherit stale attempt counts; the persisted checkpoint state is the source of truth.
**Why:** Resolves spec Open Question 3. Two policies cleanly composed: in-machine retries are "smart" (typed errors, per-state caps, custom backoff); queue retries are "dumb but durable" (survives crashes). Reclaw uses this layering today.
**Rejected:**
- Machine-only retries — loses crash recovery (process death = lost retry budget).
- Queue-only retries — loses per-state granularity; every transient failure costs a Redis round-trip.
- Cap totals across layers — coupling that's hard to reason about and untestable in pure form.

### AD-6: `JobLike` shape — minimal, append-only event log, no read API in core

**Choice:** `JobLike<S, C>` exposes `data: { state, context }` (snapshot at job start), `updateData({state, context})`, `updateProgress(percent)`, and `appendEvent(event)`. No event-read API on `JobLike` — replay lives in a separate `replay.ts` helper that takes an `EventLogReader` interface (also adapter-implemented). Keeps the kernel loop strictly write-side.
**Why:** Smaller surface = easier to mock in tests. Read-side replay has different access patterns (stream cursoring, batch sizing) that don't belong on the per-attempt write handle.
**Rejected:**
- Put `readEvents()` on `JobLike` — couples the runner to a feature it never uses.
- Skip `appendEvent` and write events implicitly inside `updateData` — harder to test, makes the "did we append?" invariant of FR-006/SC-004 implicit instead of explicit.

### AD-7: `runDag` legacy path stays one-shot; new state-machine path is opt-in via `opts.jobLike`

**Choice:** Phase 5 (full migration of consumers to durable runner) is out of scope. The new `runDag` shim detects whether a `jobLike` (and/or `humanReview` / `retryLimits`) is supplied: if not, take a fast path that's literally the existing `runDagInner` body unchanged (preserves behavior + perf for SC-006 callers). If supplied, take the state-machine path. Both paths share node execution helpers and OTel/observer instrumentation.
**Why:** Minimizes regression surface for SC-001. Keeps the new code reviewable in isolation. Lets a future PR (Phase 5, out of scope here) collapse the two paths once we trust the new one in production.
**Rejected:**
- Always go through state-machine path — would fold a multi-node `Promise.all` wave into one transition, requiring careful work to preserve observer/span ordering. Riskier than a feature flag.

---

## File Structure

All paths absolute under repo root `/home/peterstorm/dev/agentic/ai-summary/`.

### State-machine kernel (Phase 1)

```
packages/framework/src/state-machine/index.ts                          — barrel export
packages/framework/src/state-machine/types.ts                          — Machine, Executor, JobLike, RunOptions, TraceEvent
packages/framework/src/state-machine/runner.ts                         — runStateMachine()
packages/framework/src/state-machine/serialize.ts                      — Map/Set <-> JSON helpers
packages/framework/src/state-machine/mutex.ts                          — AsyncMutex (FIFO acquire)
packages/framework/src/state-machine/in-memory-job.ts                  — createInMemoryJob() for non-durable callers + tests
packages/framework/src/state-machine/replay.ts                         — replayEvents(events, machine, initial) -> {state, context}
packages/framework/src/__tests__/state-machine-runner.test.ts          — runner unit tests (in-memory job, fake executor)
packages/framework/src/__tests__/state-machine-serialize.test.ts       — Map/Set round-trip property tests
packages/framework/src/__tests__/state-machine-mutex.test.ts           — FIFO ordering tests
packages/framework/src/__tests__/state-machine-replay.test.ts          — replay equivalence tests
```

### DAG runtime layer (Phase 2)

```
packages/framework/src/dag-runtime/index.ts                            — barrel export
packages/framework/src/dag-runtime/types.ts                            — DagPhase, DagEvent, DagMachineContext, HumanAction
packages/framework/src/dag-runtime/transition.ts                       — pure dagTransition()
packages/framework/src/dag-runtime/transition-helpers.ts               — handleWaveDone, handleNodeFailed, handleHumanResponse, advanceAfterHuman
packages/framework/src/dag-runtime/machine.ts                          — compileDagToMachine(dag) -> Machine<DagPhase,DagEvent,DagMachineContext>
packages/framework/src/dag-runtime/executor.ts                         — buildDagExecutor(dag, input, ctx, hooks): Executor<DagPhase,...,DagEvent>
packages/framework/src/dag-runtime/run-dag-stateful.ts                 — runDagStateful(dag, input, ctx, opts): runs via runStateMachine
packages/framework/src/types/dag.ts                                    — extend DagDef with optional retryLimits, defaultRetryLimit (back-compat: optional)
packages/framework/src/types/node.ts                                   — extend NodeDef with optional humanReview, retry config (back-compat: optional)
packages/framework/src/types/errors.ts                                 — add new FrameworkError kinds: aborted, rejected, invalid-reroute
packages/framework/src/executor/executor.ts                            — runDag becomes shim: route to legacy fast path OR runDagStateful based on opts.jobLike presence
packages/framework/src/executor/topo.ts                                — UNCHANGED (reused by both paths)
packages/framework/src/executor/validate.ts                            — UNCHANGED (reused)
packages/framework/src/__tests__/dag-transition.test.ts                — pure transition tests (no mocks): retries, HITL, reroute, abort
packages/framework/src/__tests__/dag-runtime-stateful.test.ts          — runDagStateful end-to-end via in-memory job
packages/framework/src/__tests__/executor.test.ts                      — UNCHANGED (back-compat oracle, must pass)
packages/framework/src/__tests__/second-dag.test.ts                    — UNCHANGED (back-compat oracle, must pass)
```

### Queue layer (Phase 3)

```
packages/framework/src/queue/index.ts                                  — barrel export
packages/framework/src/queue/types.ts                                  — QueueBackend, QueueHandle, WorkerHandle, MarkerStore, DeadLetterNotifier, EnqueueOpts, QueueOpts, WorkerOpts, EventLogOpts
packages/framework/src/queue/dead-letter.ts                            — attachDeadLetterHandler(worker, notifier, opts)
packages/framework/src/queue-memory/index.ts                           — createInMemoryBackend(): QueueBackend
packages/framework/src/queue-memory/job.ts                             — adaptInMemoryJob(): JobLike with array event log
packages/framework/src/queue-bullmq/index.ts                           — barrel: createBullMQBackend, createRedisMarkerStore
packages/framework/src/queue-bullmq/adapter.ts                         — createBullMQBackend(connection, eventLogOpts?)
packages/framework/src/queue-bullmq/job.ts                             — adaptBullMQJob(bullJob, redis, queueName): JobLike — appendEvent uses XADD
packages/framework/src/queue-bullmq/markers.ts                         — createRedisMarkerStore(redis): MarkerStore
packages/framework/src/queue-bullmq/event-log.ts                       — createRedisStreamReader(redis): EventLogReader (XRANGE-backed, used by replay.ts)
packages/framework/src/__tests__/queue-dead-letter.test.ts             — fires once at exhaustion, never on success / mid-retry
packages/framework/src/__tests__/queue-memory.test.ts                  — backend conformance: enqueue, drain, worker, markers
packages/framework/src/__tests__/queue-bullmq-adapter.test.ts          — gated integration test (requires REDIS_URL); event-log XADD/XRANGE round-trip
```

### Scheduler (Phase 4)

```
packages/framework/src/scheduler/index.ts                              — barrel export
packages/framework/src/scheduler/types.ts                              — TaskConfig, TaskRegistry, CatchUpDecision, RegistryDiff
packages/framework/src/scheduler/cycle.ts                              — hasCycle(taskId, registry) — pure
packages/framework/src/scheduler/diff.ts                               — diffRegistry(active, desired) — pure
packages/framework/src/scheduler/catch-up.ts                           — decideCatchUp(...) — pure
packages/framework/src/scheduler/scheduler.ts                          — createCronScheduler(queue, markers, opts)
packages/framework/src/__tests__/scheduler-cycle.test.ts               — branch coverage SC-007
packages/framework/src/__tests__/scheduler-diff.test.ts                — disjointness + reconciliation property tests
packages/framework/src/__tests__/scheduler-catch-up.test.ts            — all four CatchUpDecision cases
packages/framework/src/__tests__/scheduler-cron.test.ts                — reconcile arms/disarms timers, dependent enqueue
```

### Top-level wiring

```
packages/framework/src/index.ts                                        — re-export from new layers
```

---

## Component Design

### State-machine kernel

**Responsibility:** Generic durable state-machine runner — pure machine + side-effect executor + checkpoint/event-log writes.
**Files:** `state-machine/types.ts`, `state-machine/runner.ts`, `state-machine/serialize.ts`, `state-machine/mutex.ts`, `state-machine/in-memory-job.ts`, `state-machine/replay.ts`
**Interface:**

```ts
interface Machine<S, E, C> {
  readonly transition: (state: S, event: E, context: C) => { state: S; context: C };
  readonly isTerminal: (state: S) => boolean;
  readonly isFailed: (state: S) => boolean;            // distinct from isTerminal — needed for don't-checkpoint-failed invariant
  readonly stateProgress: (state: S) => number;        // 0..100
  readonly maxRetries: Readonly<Record<string, number>>;
}
type Executor<S, C, E> = (state: S, context: C) => Promise<E>;
interface JobLike<S, C> {
  readonly data: { state: S; context: C };
  updateData(d: { state: S; context: C }): Promise<void>;
  updateProgress(pct: number): Promise<void>;
  appendEvent(event: unknown): Promise<void>;
}
interface RunOptions<S, C, E> {
  beforeExecute?: (state: S, context: C) => boolean;
  classifyError?: (error: unknown) => { retriable: boolean; message: string };
  onTrace?: (t: TraceEvent<S, E>) => void;
  errorEventOf?: (classified: { retriable: boolean; message: string }) => E;  // adapter to typed E
}
interface TraceEvent<S, E> {
  readonly state: S;       // FROM
  readonly event: E;
  readonly nextState: S;   // TO
  readonly outcome: "success" | "retry" | "skipped" | "failed";
  readonly durationMs: number;
  readonly timestamp: Date;
}
declare function runStateMachine<S,E,C>(
  job: JobLike<S, C>, machine: Machine<S, E, C>, executor: Executor<S, C, E>, opts?: RunOptions<S, C, E>,
): Promise<{ state: S; context: C }>;
declare function replayEvents<S,E,C>(
  events: readonly E[], machine: Machine<S, E, C>, initial: { state: S; context: C },
): { state: S; context: C };
```

**Depends on:** none (zero runtime deps).

### DAG runtime layer

**Responsibility:** Compile a `DagDef` into a `Machine` and execute it via the kernel; preserve back-compat shim on legacy `runDag`.
**Files:** `dag-runtime/types.ts`, `dag-runtime/transition.ts`, `dag-runtime/transition-helpers.ts`, `dag-runtime/machine.ts`, `dag-runtime/executor.ts`, `dag-runtime/run-dag-stateful.ts`; modifies `executor/executor.ts`, `types/dag.ts`, `types/node.ts`, `types/errors.ts`.
**Interface:**

```ts
type DagPhase =
  | { kind: "pending" }
  | { kind: "running"; wave: number; completed: ReadonlySet<string> }
  | { kind: "awaiting-human"; nodeId: string; output: unknown; prompt: string }
  | { kind: "retrying"; wave: number; nodeId: string; attempt: number; nextDelayMs: number }
  | { kind: "succeeded"; output: unknown }
  | { kind: "failed"; error: FrameworkError };

type DagEvent =
  | { type: "start" }
  | { type: "wave-done"; wave: number; outputs: ReadonlyMap<string, unknown> }
  | { type: "node-failed"; nodeId: string; error: FrameworkError }
  | { type: "human-responded"; nodeId: string; action: HumanAction }
  | { type: "abort"; reason: string }
  | { type: "ERROR"; retriable: boolean; error: string };

interface DagMachineContext {
  readonly dag: DagDef;
  readonly waves: readonly (readonly string[])[];
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly retries: ReadonlyMap<string, number>;
  readonly initialInput: unknown;
}

declare const dagTransition: (phase: DagPhase, event: DagEvent, ctx: DagMachineContext)
  => { state: DagPhase; context: DagMachineContext };
declare const compileDagToMachine: (dag: DagDef) => Machine<DagPhase, DagEvent, DagMachineContext>;

interface DagRunOpts extends RunOptions<DagPhase, DagMachineContext, DagEvent> {
  jobLike?: JobLike<DagPhase, DagMachineContext>;
  onHumanReview?: (req: { nodeId: string; output: unknown; prompt: string }) => Promise<HumanAction>;
}
declare const runDagStateful: <I, O>(
  dag: DagDef, input: I, ctx: NodeContext, opts?: DagRunOpts,
) => Promise<Result<O, FrameworkError>>;
```

`runDag` (existing) becomes a shim: if `opts.jobLike` is undefined AND no `humanReview` nodes AND no `retryLimits`, dispatch to existing `runDagInner` (legacy fast path); else dispatch to `runDagStateful`. Same signature, same returns.

**Depends on:** state-machine, existing `executor/topo.ts`, `executor/validate.ts`, `types/*`, `nodes/eval-judge.ts`.

### Queue layer (interfaces + memory + bullmq)

**Responsibility:** Pluggable persistence — define `QueueBackend` shape, ship in-memory adapter (zero deps) and BullMQ adapter (BullMQ + ioredis, isolated). Expose generic dead-letter helper.
**Files:** `queue/types.ts`, `queue/dead-letter.ts`, `queue-memory/*`, `queue-bullmq/*`
**Interface:**

```ts
interface QueueBackend {
  createQueue<J>(name: string, opts: QueueOpts): QueueHandle<J>;
  createWorker<S, C>(
    name: string,
    process: (job: JobLike<S, C>) => Promise<void>,
    opts: WorkerOpts,
  ): WorkerHandle;
}
interface QueueHandle<J> { enqueue(id: string, data: J, opts?: EnqueueOpts): Promise<void>; drain(): Promise<void>; close(): Promise<void>; }
interface WorkerHandle { onFailed(h: (id: string, err: Error, attempts: number, max: number) => Promise<void> | void): void; onError(h: (e: Error) => void): void; close(): Promise<void>; }
interface MarkerStore { set(key: string, ttlSec: number): Promise<void>; exists(key: string): Promise<boolean>; delete(key: string): Promise<void>; }
interface DeadLetterNotifier { notify(recipients: readonly string[], message: string): Promise<void>; }
interface EventLogOpts { maxLen?: number /* default 10000 */; approximate?: boolean /* default true -> XADD MAXLEN ~ */; streamKey?: (queueName: string, jobId: string) => string /* default `events:${q}:${id}` */; }
declare const attachDeadLetterHandler: (
  worker: WorkerHandle, notifier: DeadLetterNotifier,
  opts: { getRecipients: (data: unknown) => readonly string[]; formatMessage: (id: string, err: string) => string },
) => void;

// queue-bullmq
declare const createBullMQBackend: (connection: { host: string; port: number }, eventLog?: EventLogOpts) => QueueBackend;
declare const createRedisMarkerStore: (redis: Redis) => MarkerStore;

// queue-memory
declare const createInMemoryBackend: () => QueueBackend & { _events: Map<string, unknown[]> };  // _events exposed for tests
```

The BullMQ `JobLike` adapter calls `redis.xadd(streamKey, "MAXLEN", "~", maxLen, "*", "type", e.type, "payload", JSON.stringify(e))` for `appendEvent`.

**Depends on:** state-machine (for `JobLike`); BullMQ adapter additionally on `bullmq` and `ioredis` peer deps. Core/DAG MUST NOT import this layer — verified by import-graph lint (SC-005).

### Scheduler

**Responsibility:** Cron-driven task firing with cycle detection, registry diffing, and post-restart catch-up; pure decision functions + a thin timer reconcile loop.
**Files:** `scheduler/types.ts`, `scheduler/cycle.ts`, `scheduler/diff.ts`, `scheduler/catch-up.ts`, `scheduler/scheduler.ts`
**Interface:**

```ts
interface TaskConfig { readonly id: string; readonly cron: string; readonly validForMs: number; readonly dependsOn?: readonly string[]; }
type TaskRegistry = ReadonlyMap<string, TaskConfig>;
interface RegistryDiff { add: TaskConfig[]; remove: string[]; update: TaskConfig[]; }
type CatchUpDecision =
  | { kind: "skip"; reason: string }
  | { kind: "enqueue-standalone" }
  | { kind: "enqueue-dependents"; dependentIds: readonly string[] };

declare const hasCycle: (taskId: string, reg: TaskRegistry) => boolean;
declare const diffRegistry: (active: TaskRegistry, desired: TaskRegistry) => RegistryDiff;
declare const decideCatchUp: (
  taskId: string, fired: boolean, completed: boolean, withinValidity: boolean, hasDependents: boolean,
) => CatchUpDecision;
interface CronScheduler {
  reconcile(reg: TaskRegistry): void;
  resolveDependents(taskId: string, triggeredAt: Date): Promise<void>;
  stop(): void;
}
declare const createCronScheduler: (
  queue: QueueHandle<unknown>, markers: MarkerStore,
  opts: { enqueue: (task: TaskConfig, triggeredAt: Date) => Promise<void> },
) => CronScheduler;
```

**Depends on:** queue (for `QueueHandle`, `MarkerStore`).

---

## Data Flow

**Legacy `runDag` (no `jobLike`):**

```
caller -> runDag -> runDagInner (existing) -> topoSort -> Promise.all per wave -> ok(output) | err(FrameworkError)
                                                                                      observer events fire as before
```

**Durable `runDag` / `runDagStateful` (`jobLike` provided):**

```
caller
 └► runDagStateful
     ├► topoSort                                                    (pure)
     ├► compileDagToMachine(dag)                                    (pure)
     ├► buildDagExecutor(dag, input, ctx, hooks)                    (closes over Promise.all per wave + node validation + observer events)
     └► runStateMachine(jobLike, machine, executor)
          loop:
            1. executor(state, ctx) -> DagEvent  (does I/O — runs whole wave)
            2. transition(state, event, ctx)     (pure)
            3. if !failed: jobLike.updateData + jobLike.appendEvent  (Redis: HSET BullMQ data + XADD stream)
            4. jobLike.updateProgress
            5. onTrace fires
            6. if terminal-failed: throw -> queue retries from last checkpoint
            7. if terminal-succeeded: return {state, context}
```

**Replay:**

```
EventLogReader (XRANGE) -> readonly DagEvent[] -> replayEvents(events, machine, lastCheckpoint) -> {state, context}
```

Key transformation: each iteration of the kernel loop is one transition. Wave-level parallelism still happens — it's hidden inside the executor closure (one `Promise.all` produces one `wave-done` event).

---

## Implementation Phases

Maps to decompose waves. Items inside a phase may run in parallel.

### Phase 1: state-machine kernel (no dependencies)

- Define `Machine`, `Executor`, `JobLike`, `RunOptions`, `TraceEvent` in `state-machine/types.ts`.
- Implement `runStateMachine` with the don't-checkpoint-failed invariant, `appendEvent` after every successful transition (FR-005), retry-counter reset (FR-011), `beforeExecute` abort (FR-012), error wrapping via `errorEventOf` + `classifyError` (FR-006).
- Implement `createInMemoryJob` (array event log, in-memory state).
- Implement `replayEvents` (pure fold).
- Implement `serialize.ts` Map/Set <-> JSON helpers (FR-010).
- Implement `mutex.ts` FIFO `AsyncMutex` (FR-009).
- Tests: runner unit (no Redis), serialize property tests, mutex FIFO tests, replay equivalence test against in-memory machine.
- **Files:** `state-machine/types.ts`, `state-machine/runner.ts`, `state-machine/in-memory-job.ts`, `state-machine/replay.ts`, `state-machine/serialize.ts`, `state-machine/mutex.ts`, `state-machine/index.ts`, `__tests__/state-machine-*.test.ts`

### Phase 2: DAG types + pure transition (depends on Phase 1)

Two parallel tracks; both depend only on Phase 1 types.

**2a. DAG types + transition (pure, no executor needed):**
- Add new `FrameworkError` kinds: `aborted`, `rejected`, `invalid-reroute` in `types/errors.ts`.
- Extend `DagDef` with optional `retryLimits`, `defaultRetryLimit` (back-compat: optional).
- Extend `NodeDef` with optional `humanReview`, `retry: { backoffMs?: readonly number[]; jitterRatio?: number }`.
- Implement `dag-runtime/types.ts` (DagPhase, DagEvent, DagMachineContext, HumanAction).
- Implement `dag-runtime/transition.ts` + `transition-helpers.ts` (pure; covers FR-021, FR-026..FR-033).
- Implement `dag-runtime/machine.ts` `compileDagToMachine`.
- Tests: pure transition tests covering retry-within-limit, retry-exhausted, sequential HITL ordering by node-id (FR-028), approve / approve-with-edit / reject / reroute-back / reroute-forward-fails / abort-from-any-non-terminal — target SC-002 (>=95% line coverage).

**2b. Queue interfaces (no impl yet):**
- Define all interfaces in `queue/types.ts` (FR-040..FR-043).
- Implement generic `attachDeadLetterHandler` (FR-044).
- Tests: dead-letter unit tests via a stub `WorkerHandle`.

- **Files (2a):** `types/errors.ts`, `types/dag.ts`, `types/node.ts`, `dag-runtime/types.ts`, `dag-runtime/transition.ts`, `dag-runtime/transition-helpers.ts`, `dag-runtime/machine.ts`, `__tests__/dag-transition.test.ts`
- **Files (2b):** `queue/types.ts`, `queue/dead-letter.ts`, `queue/index.ts`, `__tests__/queue-dead-letter.test.ts`

### Phase 3: DAG executor + runner; in-memory backend (depends on Phase 2)

Three parallel tracks.

**3a. DAG executor closure + runDagStateful:**
- Implement `dag-runtime/executor.ts` `buildDagExecutor` — runs one wave per call via `Promise.all`, validates inputs/outputs (FR-025), emits existing observer events to preserve behavior, returns `{ type: "wave-done", ... }` or `{ type: "node-failed", ... }`. Honors `humanReview` by short-circuiting before transition only via the transition's `awaiting-human` branch (executor never calls `onHumanReview` directly — the kernel re-enters and the executor sees the awaiting-human state and dispatches the hook then).
- Implement `dag-runtime/run-dag-stateful.ts` — initial-state construction (`pending`), runs `runStateMachine`, maps terminal `succeeded` -> `ok`, `failed` -> `err`.
- Apply exponential backoff with jitter (FR-027) inside the executor when state is `retrying` (delay derived from `attempt` and `NodeDef.retry`).
- Tests: end-to-end via in-memory `JobLike`: linear DAG, fan-out/in, diamond, retry, HITL approve, HITL reject, HITL reroute-back, abort. Backwards-compat: existing `__tests__/executor.test.ts` and `second-dag.test.ts` MUST still pass against the shimmed `runDag`.

**3b. In-memory queue backend:**
- Implement `queue-memory/index.ts` `createInMemoryBackend` (Map-backed queue with concurrent worker simulation) and `queue-memory/job.ts` `adaptInMemoryJob`.
- Tests: backend conformance suite — enqueue/drain, worker invocation, `onFailed` semantics, dead-letter via `attachDeadLetterHandler`.

**3c. Back-compat shim in existing executor:**
- Modify `executor/executor.ts` `runDag`: branch on `opts.jobLike` presence — fall through to existing `runDagInner` when absent and no machine-only features (HITL, retryLimits). Keep root span, eval-judge, `onBackground`, `resume` semantics for the legacy path bit-for-bit.
- Add a small adapter for legacy `RunOptions.resume` on the new path (translate `resume.checkpoint` Map into a starting `DagPhase` if/when callers pass `jobLike` + `resume` together — punt with explicit error if both given for now; out of scope to merge resume + state-machine).

- **Files (3a):** `dag-runtime/executor.ts`, `dag-runtime/run-dag-stateful.ts`, `dag-runtime/index.ts`, `__tests__/dag-runtime-stateful.test.ts`
- **Files (3b):** `queue-memory/index.ts`, `queue-memory/job.ts`, `__tests__/queue-memory.test.ts`
- **Files (3c):** `executor/executor.ts`

### Phase 4: BullMQ adapter + scheduler (depends on Phase 3)

Two parallel tracks; both depend on Phase 3 layer-3 interfaces and Phase 1 kernel.

**4a. BullMQ adapter + Redis Streams event log + replay reader:**
- `queue-bullmq/adapter.ts` — `createBullMQBackend` (FR-045, FR-047).
- `queue-bullmq/job.ts` — `adaptBullMQJob`: `appendEvent` does `XADD ... MAXLEN ~ <maxLen> * type=... payload=...` (FR-048; AD-3).
- `queue-bullmq/markers.ts` — Redis `MarkerStore` (FR-043 backed).
- `queue-bullmq/event-log.ts` — `createRedisStreamReader` for `XRANGE`-based replay.
- Tests: gated integration test under `__tests__/queue-bullmq-adapter.test.ts` — requires `REDIS_URL`; test name pattern excluded from default unit test runs (use `vitest --testNamePattern` or env gate). Crash-resume scenario (SC-003) and event-log replay (SC-004 — 5 DAG shapes).

**4b. Scheduler:**
- `scheduler/cycle.ts`, `scheduler/diff.ts`, `scheduler/catch-up.ts` (pure; FR-061..FR-063).
- `scheduler/scheduler.ts` `createCronScheduler` with `cron-parser` (already in monorepo? if not, use `croner` — to be confirmed during impl) for next-fire calculation; timer reconciliation per `diffRegistry` (FR-064).
- Tests: 100% branch coverage on pure decision functions (SC-007); reconcile arms/disarms timers; resolveDependents enqueues when marker says fired+completed.

- **Files (4a):** `queue-bullmq/adapter.ts`, `queue-bullmq/job.ts`, `queue-bullmq/markers.ts`, `queue-bullmq/event-log.ts`, `queue-bullmq/index.ts`, `__tests__/queue-bullmq-adapter.test.ts`
- **Files (4b):** `scheduler/types.ts`, `scheduler/cycle.ts`, `scheduler/diff.ts`, `scheduler/catch-up.ts`, `scheduler/scheduler.ts`, `scheduler/index.ts`, `__tests__/scheduler-*.test.ts`

### Phase 5: Public exports + import-graph lint (depends on Phases 1-4)

- Update `packages/framework/src/index.ts` to re-export from new layers (NFR-021 — list all required public type names).
- Add an import-graph check (script under `packages/framework/scripts/check-imports.ts` invoked from a test or CI step) verifying:
  - `state-machine/**` files import nothing from `bullmq`, `ioredis`, or `queue-bullmq/**`.
  - `dag-runtime/**` files import nothing from `queue/**`, `queue-bullmq/**`, `queue-memory/**`, `scheduler/**`, `bullmq`, `ioredis`.
  - Only `queue-bullmq/**` may import `bullmq` or `ioredis`.
- Run the full pre-existing test suite — SC-001 oracle.
- **Files:** `packages/framework/src/index.ts`, `packages/framework/scripts/check-imports.ts`, `__tests__/boundary-imports.test.ts`

> **!! T9 implementer — read me first !!**
>
> Wave 3 was remediated post-decompose. The plan symbol-lists below may be stale. Do NOT cherry-pick exports from this plan — instead read the *current* state of each module file directly and re-export everything declared public there. New surface added in remediation that you MUST cover:
>
> - `dag-runtime/types.ts`: new `retrying-hook` variant on `DagPhase`; new optional `coFailedNodeIds: ReadonlyArray<string>` field on the `node-failed` `DagEvent`; new optional `partialOutputs: ReadonlyMap<string, unknown>` field on `node-failed`.
> - `dag-runtime/transition-helpers.ts`: new `handleHookCrash` exported helper.
> - `queue/types.ts`: `DeadLetterOpts.getRecipients` signature is `(id: string, err: unknown) => readonly string[]` (not `(data: unknown)`).
> - `queue/in-memory.ts`: `errorHandlers` are now wired up by `worker.onError(...)` and invoked when a `failedHandler` throws — surface the same contract from any new BullMQ adapter you reference.
>
> Spec FR-029a (hook-crash retry) was added during remediation — check it before touching DAG runtime types. ADR 0008 documents the decision.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| state-machine/runner | runStateMachine drives to terminal; does NOT checkpoint failed; resets retry counters per attempt; classifyError wraps to ERROR event; beforeExecute false aborts; appendEvent fires on every successful transition; throws on terminal-failed | none | — |
| state-machine/serialize | round-trip Map/Set/Date/nested; non-string Map keys preserved | none | "round-trip equals original for arbitrary JSON+Map+Set values" |
| state-machine/mutex | FIFO ordering; release allows next | none | "n concurrent acquires resolve in submission order" |
| state-machine/replay | replay(events) on initial yields same as live runtime for known sequences | none | "for any sequence of events, replay equals fold of transition" |
| dag-runtime/transition | retry within/at/over limit; HITL ordering by node-id; approve/edit/reject; reroute-backward succeeds; reroute-forward fails as invalid-reroute; abort from running/retrying/awaiting-human; awaiting-human ignores non-human-responded events | none | "transition is total — every (phase, event, ctx) yields a valid result" |
| dag-runtime/run-dag-stateful | linear, fan-out, fan-in, diamond, with-HITL — end-to-end via in-memory job | none | — |
| executor/executor (shim) | existing executor.test.ts + second-dag.test.ts unchanged (SC-001 oracle) | none | — |
| queue/dead-letter | fires once at attempts==max; never on success; never mid-retry; passes formatted message + recipients | none | "for 100 simulated lifecycles, fires iff exhausted" (SC-008) |
| queue-memory | enqueue/drain; worker invocation; onFailed; appendEvent stored; backend conformance | none | — |
| queue-bullmq/adapter | none (logic mostly delegated) | gated: enqueue, process, updateData persisted, XADD/XRANGE event log round-trip, crash-resume (kill mid-DAG, restart from checkpoint) — SC-003, SC-004 | — |
| queue-bullmq/markers | none | gated: set/exists/delete; TTL expiry within window | — |
| scheduler/cycle | self-cycle, A->B->A, A->B->C->A, no-cycle, missing-dep-treated-as-no-cycle | none | — |
| scheduler/diff | empty active; empty desired; identical; partial overlap; update detection | none | "applying diff transforms active to desired" + disjointness |
| scheduler/catch-up | all 4 cases per FR-063 (SC-007 — 100% branch) | none | — |
| scheduler/scheduler | reconcile with fake timers; resolveDependents enqueues when fired+completed marker; stop clears all | none | — |
| boundary-imports | static import-graph check (SC-005) | none | — |

Microbenchmark for SC-006 (kernel <2ms p95 transition) under `__tests__/state-machine-runner.bench.ts` — run separately from regular tests; not gating in CI but reported.

---

## Security & NFR Notes

- **Security:** No new trust boundaries — Redis is already a trusted dependency. The event log payload is JSON-serialized framework events (no user input); still, `appendEvent` writers must avoid unbounded payload sizes (clamp via `JSON.stringify` length check, default 64 KiB, reject above with explicit error to keep XADD predictable).
- **Performance:** Checkpoint write is one HSET (BullMQ) + one XADD per transition (NFR-011). Both fire-and-forget on the same Redis connection — no extra round trip. The legacy `runDag` fast path keeps zero Redis calls for callers who don't pass `jobLike`. Microbenchmark (SC-006) gates kernel overhead.
- **Observability:** New layer reuses existing OTel root span and observer events — no new tracing surface. `onTrace` is opt-in per call, not a global subscription.
- **Boundary hygiene (FR-080..FR-082):** Enforced both by directory layout and an import-graph test (SC-005). Adding a `bullmq` import under `state-machine/` or `dag-runtime/` MUST fail the test.

---

## Verification

1. `pnpm -C packages/framework typecheck` — full TS build green (no `any` regressions in public types).
2. `pnpm -C packages/framework test` — all pre-existing tests pass unchanged (SC-001) plus new unit/property tests.
3. `pnpm -C packages/framework test --testNamePattern "boundary-imports"` — import-graph check green (SC-005).
4. `pnpm -C packages/framework test --testNamePattern "queue-bullmq|crash-resume"` with `REDIS_URL` set — gated integration tests pass (SC-003, SC-004).
5. Coverage report: `dagTransition` and helpers at >=95% line coverage (SC-002); scheduler decision functions at 100% branch coverage (SC-007).
6. Manual: existing ai-summary CLI run produces unchanged observable behavior (same trace structure, same outputs) — Phase 5 sanity for back-compat.
