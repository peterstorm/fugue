# Design: Durable State Machine Runtime

**Created:** 2026-05-08
**Updated:** 2026-05-08
**Status:** Draft
**Goal:** Extract a reusable durable state machine runtime from ai-summary's DAG executor and reclaw's research pipeline. The library provides a pure transition kernel, a checkpoint-aware runner, pluggable queue/storage backends (with a BullMQ+Redis adapter), a cron scheduler with dependency resolution, and a DAG executor built on top.

---

## Problem

Two codebases independently implement the same pattern:

**ai-summary** (`packages/framework/src/executor/executor.ts`):
- One-shot topological DAG walk with `Promise.all` per wave
- No retries, no human-in-the-loop, no durable checkpoint, in-memory only
- If the process dies mid-run, all progress is lost

**reclaw** (`src/core/research-machine.ts` + `src/orchestration/research-handler.ts`):
- Pure `transition(state, event, context)` state machine with per-state retries
- BullMQ worker as imperative shell, `job.updateData()` for checkpointing
- Crash-safe: resumes from last successful state on BullMQ retry
- But: hand-written per pipeline, no DAG parallelism, tightly coupled to BullMQ

Neither is reusable as a library. The goal is to unify both into a single runtime that supports:

1. **Pure transition functions** — functional core, no I/O, fully testable
2. **Durable checkpoint/resume** — survive process crashes, resume from exact state
3. **Per-node/state retries** with configurable backoff
4. **Human-in-the-loop** — pause, approve/edit/reject/reroute, resume
5. **DAG execution** — topological wave scheduling with parallelism
6. **Pluggable backends** — BullMQ+Redis, in-memory (tests), or anything else
7. **Cron scheduling** with dependency resolution and catch-up

---

## Design Principles

1. **Functional core, imperative shell** — transition functions are pure. All I/O happens in the runner/adapters.
2. **Serializable state** — all machine state is JSON-serializable. Persist anywhere.
3. **Backend-agnostic** — core has zero dependencies on Redis, BullMQ, or any queue. Adapters are separate.
4. **Layered** — each layer is independently useful. You can use just the state machine without the DAG, or the DAG without the queue.
5. **Don't checkpoint failures** — critical invariant from reclaw: failed states are NOT persisted, so external retry (BullMQ, manual) resumes from last success.

---

## Package Structure

```
@peterstorm/durable-machine
├── core/              ← zero external deps
│   ├── types.ts       ← Machine<S,E,C>, Result<T,E>, TraceEvent
│   ├── runner.ts      ← runStateMachine() — the imperative shell loop
│   ├── serialize.ts   ← state serialization/deserialization (Map ↔ Object)
│   └── mutex.ts       ← AsyncMutex
│
├── dag/               ← depends on core/
│   ├── types.ts       ← DagDef, NodeDef, EdgeDef, DagPhase, DagEvent
│   ├── topo.ts        ← topoSort → string[][] (waves)
│   ├── transition.ts  ← pure DAG transition function
│   ├── runner.ts      ← runDag() — compiles DagDef into Machine, calls core runner
│   └── validate.ts    ← Zod input/output validation at node boundaries
│
├── queue/             ← depends on core/, zero external deps
│   ├── types.ts       ← QueueBackend, WorkerHandle, MarkerStore, JobLike interfaces
│   └── dead-letter.ts ← generic dead-letter handler pattern
│
├── queue-bullmq/      ← depends on queue/, peer dep on bullmq + ioredis
│   ├── adapter.ts     ← BullMQ implementation of QueueBackend
│   ├── worker.ts      ← BullMQ WorkerHandle + checkpoint via job.updateData()
│   └── markers.ts     ← Redis-backed MarkerStore
│
├── queue-memory/      ← depends on queue/, zero external deps
│   └── adapter.ts     ← in-memory queue for tests
│
├── scheduler/         ← depends on queue/, zero external deps
│   ├── types.ts       ← TaskConfig, TaskRegistry, CatchUpDecision
│   ├── scheduler.ts   ← CronScheduler — reconcile, arm timers, catch-up
│   ├── cycle.ts       ← hasCycle() — pure
│   ├── diff.ts        ← diffRegistry() — pure
│   └── catch-up.ts    ← decideCatchUp() — pure
│
└── index.ts           ← re-exports
```

### Dependency graph

```
queue-bullmq ──► queue ──► core
queue-memory ──► queue ──► core
scheduler ─────► queue ──► core
dag ─────────────────────► core
```

No circular deps. `core` depends on nothing. `dag` depends only on `core`. Queue adapters are optional.

---

## Layer 1: Core — Generic State Machine

### Machine Interface

```ts
/** A state machine definition. All functions are pure. */
interface Machine<S, E, C> {
  /** Pure transition: (state, event, context) → { state, context } */
  readonly transition: (state: S, event: E, context: C) => { state: S; context: C };
  /** Is this a terminal state (done or failed)? */
  readonly isTerminal: (state: S) => boolean;
  /** Progress indicator 0–100 for monitoring. */
  readonly stateProgress: (state: S) => number;
  /** Per-state retry limits. Key = state kind, value = max attempts. */
  readonly maxRetries: Readonly<Record<string, number>>;
}
```

### Executor Interface

```ts
/**
 * Side-effect dispatcher. Given a state and context, performs I/O and returns
 * the event that describes what happened.
 *
 * This is the imperative shell's extension point — callers provide their own
 * executor with their own dependencies (Claude, Telegram, NotebookLM, etc.).
 */
type Executor<S, C, E> = (state: S, context: C) => Promise<E>;
```

### JobLike Interface

```ts
/**
 * Minimal job handle for checkpoint/progress. Abstracts BullMQ, in-memory, or any backend.
 */
interface JobLike<S, C> {
  readonly data: { state: S; context: C };
  readonly updateData: (data: { state: S; context: C }) => Promise<void>;
  readonly updateProgress: (percent: number) => Promise<void>;
}
```

### Runner — The Imperative Shell Loop

Generalized from reclaw's `research-handler.ts`:

```ts
interface RunOptions<S, C> {
  /** Called before each state execution. Return false to abort. */
  readonly beforeExecute?: (state: S, context: C) => boolean;
  /** Classify whether an unexpected error is retriable. Default: all retriable. */
  readonly classifyError?: (error: unknown) => { retriable: boolean; message: string };
  /** Called after each successful transition for observability. */
  readonly onTrace?: (trace: TraceEvent<S>) => void;
}

interface TraceEvent<S> {
  readonly state: S;
  readonly timestamp: Date;
  readonly durationMs: number;
  readonly outcome: "success" | "retry" | "skipped" | "failed";
  readonly detail?: string;
}

/**
 * Run a state machine to completion with durable checkpointing.
 *
 * Critical invariant: failed states are NOT checkpointed. If the runner
 * throws (or the process crashes), external retry mechanisms (BullMQ, manual)
 * resume from the last successfully checkpointed state.
 */
const runStateMachine = async <S, E, C>(
  job: JobLike<S, C>,
  machine: Machine<S, E, C>,
  executor: Executor<S, C, E>,
  opts?: RunOptions<S, C>,
): Promise<{ state: S; context: C }> => {
  let { state, context } = job.data;

  // Reset retry counters for current state on each BullMQ attempt.
  // This prevents stale retry counts from a previous attempt bleeding in.

  while (!machine.isTerminal(state)) {
    if (opts?.beforeExecute?.(state, context) === false) {
      throw new Error("Aborted by beforeExecute hook");
    }

    const startTime = Date.now();
    let event: E;

    try {
      event = await executor(state, context);
    } catch (err) {
      // Unexpected error — classify and wrap as error event
      const classified = opts?.classifyError?.(err)
        ?? { retriable: true, message: err instanceof Error ? err.message : String(err) };

      // Create ERROR event — the machine's transition function handles retry logic
      event = { type: "ERROR", retriable: classified.retriable, error: classified.message } as E;
    }

    const prev = state;
    const result = machine.transition(state, event, context);
    state = result.state;
    context = result.context;

    // Trace
    const durationMs = Date.now() - startTime;
    opts?.onTrace?.({
      state: prev,
      timestamp: new Date(startTime),
      durationMs,
      outcome: machine.isTerminal(state) && isFailed(state) ? "failed"
        : state === prev ? "retry"
        : "success",
    });

    // Checkpoint — but NOT if we just entered a failed state.
    // This is the critical invariant: external retry resumes from last success.
    if (!machine.isTerminal(state) || !isFailed(state)) {
      await job.updateData({ state, context });
    }

    await job.updateProgress(machine.stateProgress(state));
  }

  // If terminal and failed, throw so the queue backend can retry
  if (isFailed(state)) {
    throw new Error(extractErrorMessage(state));
  }

  return { state, context };
};
```

### Result Type

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

### AsyncMutex

Direct extraction from reclaw — FIFO async mutex using promise chaining:

```ts
interface Mutex {
  acquire(): Promise<() => void>;
}
```

---

## Layer 2: DAG — Topological State Machine

The DAG executor is a specific `Machine<DagPhase, DagEvent, DagMachineContext>` built on the core.

### DagDef — Declarative Graph Definition

```ts
interface DagDef {
  readonly id: string;
  readonly nodes: readonly NodeDef<any, any, any>[];
  readonly edges: readonly EdgeDef[];
  readonly outputNodeId?: string;
  /** Per-node retry limits. Key = nodeId, value = max attempts. */
  readonly retryLimits?: Record<string, number>;
  /** Default retry limit for all nodes (default: 0). */
  readonly defaultRetryLimit?: number;
}

interface NodeDef<I, O, E> {
  readonly id: string;
  readonly kind: NodeKind;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];
  readonly run: (input: I, ctx: NodeContext) => Promise<Result<O, E>>;
  /** Skip this node if predicate returns true. */
  readonly skipWhen?: (input: I) => boolean;
  /** If set, pause for human review after this node completes. */
  readonly humanReview?: {
    readonly prompt: string;
    readonly allowEdit?: boolean;
    readonly allowReroute?: readonly string[];
  };
}
```

### DagPhase — The State

```ts
type DagPhase =
  | { kind: "pending" }
  | { kind: "running"; wave: number; completed: Set<string> }
  | { kind: "awaiting-human"; nodeId: string; output: unknown; prompt: string }
  | { kind: "retrying"; wave: number; nodeId: string; attempt: number }
  | { kind: "succeeded"; output: unknown }
  | { kind: "failed"; error: FrameworkError; failedState?: string };
```

State diagram:

```
pending ──start──► running(0)
                      │
                      ├─wave-done──► running(1) ──► ... ──► succeeded
                      │
                      ├─node-failed──► retrying ──wave-done──► running(same wave)
                      │                    │
                      │                    └─retry-exhausted──► failed
                      │
                      └─(human-review node)──► awaiting-human
                                                    │
                                                    ├─approve──► running(next)
                                                    ├─approve-with-edit──► running(next)
                                                    ├─reject──► failed
                                                    └─reroute──► running(target wave)
```

### DagEvent — The Input

```ts
type DagEvent =
  | { type: "start" }
  | { type: "wave-done"; wave: number; outputs: Map<string, unknown> }
  | { type: "node-failed"; nodeId: string; error: FrameworkError }
  | { type: "retry-exhausted"; nodeId: string; error: FrameworkError }
  | { type: "human-responded"; nodeId: string; action: HumanAction }
  | { type: "abort"; reason: string }
  | { type: "ERROR"; retriable: boolean; error: string };

type HumanAction =
  | { type: "approve" }
  | { type: "approve-with-edit"; edited: unknown }
  | { type: "reject"; reason: string }
  | { type: "reroute"; toNodeId: string };
```

### DagMachineContext — Immutable Accumulator

```ts
interface DagMachineContext {
  readonly dag: DagDef;
  readonly waves: string[][];
  readonly outputs: Map<string, unknown>;
  readonly checkpoint: Map<string, unknown>;
  readonly retries: Map<string, number>;
}
```

### Pure Transition Function

```ts
const transition = (
  phase: DagPhase,
  event: DagEvent,
  ctx: DagMachineContext,
): { state: DagPhase; context: DagMachineContext } => {

  // Abort from any non-terminal state
  if (event.type === "abort" && !isTerminal(phase)) {
    return {
      state: { kind: "failed", error: { kind: "aborted", message: event.reason } },
      context: ctx,
    };
  }

  switch (phase.kind) {
    case "pending": {
      if (event.type !== "start") return noop(phase, ctx);
      return {
        state: { kind: "running", wave: 0, completed: new Set() },
        context: ctx,
      };
    }

    case "running": {
      if (event.type === "wave-done") return handleWaveDone(phase, event, ctx);
      if (event.type === "node-failed") return handleNodeFailed(phase, event, ctx);
      return noop(phase, ctx);
    }

    case "retrying": {
      if (event.type === "wave-done") {
        return handleWaveDone(
          { kind: "running", wave: phase.wave, completed: new Set() },
          event, ctx,
        );
      }
      if (event.type === "node-failed") {
        return handleNodeFailed(
          { kind: "running", wave: phase.wave, completed: new Set() },
          event, ctx,
        );
      }
      return noop(phase, ctx);
    }

    case "awaiting-human": {
      if (event.type !== "human-responded") return noop(phase, ctx);
      return handleHumanResponse(phase, event, ctx);
    }

    default:
      return noop(phase, ctx);
  }
};
```

### Transition Helpers

```ts
const handleWaveDone = (
  phase: { kind: "running"; wave: number; completed: Set<string> },
  event: { type: "wave-done"; wave: number; outputs: Map<string, unknown> },
  ctx: DagMachineContext,
) => {
  const merged = new Map([...ctx.outputs, ...event.outputs]);
  const newCtx = { ...ctx, outputs: merged };

  // Check for human review gate
  const reviewNode = findHumanReviewNode(ctx.dag, ctx.waves[phase.wave]);
  if (reviewNode) {
    const output = merged.get(reviewNode.id);
    return {
      state: { kind: "awaiting-human" as const, nodeId: reviewNode.id, output, prompt: reviewNode.humanReview!.prompt },
      context: newCtx,
    };
  }

  const nextWave = phase.wave + 1;
  if (nextWave >= ctx.waves.length) {
    const outputNodeId = ctx.dag.outputNodeId ?? lastOf(ctx.waves);
    return { state: { kind: "succeeded" as const, output: merged.get(outputNodeId) }, context: newCtx };
  }

  return {
    state: { kind: "running" as const, wave: nextWave, completed: new Set<string>() },
    context: newCtx,
  };
};

const handleNodeFailed = (
  phase: { kind: "running"; wave: number },
  event: { type: "node-failed"; nodeId: string; error: FrameworkError },
  ctx: DagMachineContext,
) => {
  const attempts = (ctx.retries.get(event.nodeId) ?? 0) + 1;
  const limit = ctx.dag.retryLimits?.[event.nodeId] ?? ctx.dag.defaultRetryLimit ?? 0;

  if (attempts <= limit) {
    return {
      state: { kind: "retrying" as const, wave: phase.wave, nodeId: event.nodeId, attempt: attempts },
      context: { ...ctx, retries: new Map([...ctx.retries, [event.nodeId, attempts]]) },
    };
  }

  return {
    state: { kind: "failed" as const, error: event.error },
    context: ctx,
  };
};

const handleHumanResponse = (
  phase: { kind: "awaiting-human"; nodeId: string; output: unknown },
  event: { type: "human-responded"; nodeId: string; action: HumanAction },
  ctx: DagMachineContext,
) => {
  switch (event.action.type) {
    case "approve":
      return advanceAfterHuman(phase, ctx);

    case "approve-with-edit": {
      const patched = new Map([...ctx.outputs, [phase.nodeId, event.action.edited]]);
      return advanceAfterHuman(phase, { ...ctx, outputs: patched });
    }

    case "reject":
      return {
        state: { kind: "failed" as const, error: { kind: "rejected" as const, nodeId: phase.nodeId, message: event.action.reason } },
        context: ctx,
      };

    case "reroute": {
      const targetWave = ctx.waves.findIndex(w => w.includes(event.action.toNodeId));
      if (targetWave === -1) {
        return {
          state: { kind: "failed" as const, error: { kind: "invalid-reroute" as const, message: `Node ${event.action.toNodeId} not in DAG` } },
          context: ctx,
        };
      }
      return {
        state: { kind: "running" as const, wave: targetWave, completed: new Set<string>() },
        context: ctx,
      };
    }
  }
};
```

### DAG Runner — Compiles DagDef into Machine

```ts
/**
 * Compile a DagDef into a Machine and run it via the core runner.
 * This is the high-level entry point for DAG execution.
 */
const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  nodeCtx: NodeContext,
  hooks?: DagHooks,
): Promise<Result<O, FrameworkError>> => {
  const sortResult = topoSort(dag);
  if (!sortResult.ok) return sortResult;

  const machine: Machine<DagPhase, DagEvent, DagMachineContext> = {
    transition: dagTransition,
    isTerminal: (s) => s.kind === "succeeded" || s.kind === "failed",
    stateProgress: (s) => s.kind === "running" ? Math.round((s.wave / sortResult.value.length) * 100) : s.kind === "succeeded" ? 100 : 0,
    maxRetries: dag.retryLimits ?? {},
  };

  const executor: Executor<DagPhase, DagMachineContext, DagEvent> = async (state, ctx) => {
    // ... execute wave or single node, handle human review ...
  };

  const job = hooks?.jobLike ?? createInMemoryJob(/* initial state */);
  const result = await runStateMachine(job, machine, executor);

  if (result.state.kind === "succeeded") return ok(result.state.output as O);
  if (result.state.kind === "failed") return err(result.state.error);
  throw new Error("unreachable");
};
```

### Backwards Compatibility

The existing `runDag(dag, input, ctx)` API keeps working. Internally it creates an in-memory `JobLike` (no checkpointing) and runs with no hooks. The state machine is invisible to existing callers:

```ts
// Existing callers — unchanged
const result = await runDag(summaryDag, customerData, ctx);

// New callers — full durability
const result = await runDag(summaryDag, customerData, ctx, {
  jobLike: bullmqJobAdapter(job),  // checkpoint to Redis
  onHumanReview: telegramReviewHandler,
});
```

---

## Layer 3: Queue — Pluggable Backend

### Interfaces

```ts
/** Queue backend adapter — abstracts BullMQ, SQS, Postgres SKIP LOCKED, etc. */
interface QueueBackend {
  createQueue<J>(name: string, opts: QueueOpts): QueueHandle<J>;
  createWorker<J>(name: string, processor: (job: JobLike<any, any>) => Promise<void>, opts: WorkerOpts): WorkerHandle;
}

interface QueueHandle<J> {
  enqueue(id: string, data: J, opts?: EnqueueOpts): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

interface EnqueueOpts {
  /** Delay before job becomes eligible for processing. */
  readonly delayMs?: number;
  /** Dedup key — if a job with this key is already enqueued, skip. */
  readonly dedupId?: string;
}

interface WorkerHandle {
  onFailed(handler: (jobId: string, error: Error, attempts: number, maxAttempts: number) => Promise<void>): void;
  onError(handler: (error: Error) => void): void;
  close(): Promise<void>;
}

interface QueueOpts {
  readonly retry: {
    readonly attempts: number;
    readonly backoff: { readonly type: "exponential"; readonly delay: number };
  };
  readonly retention?: {
    readonly completedAgeSec: number;
    readonly completedCount: number;
    readonly failedAgeSec: number;
    readonly failedCount: number;
  };
}

interface WorkerOpts {
  readonly concurrency: number;
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
}

/** Durable markers for dedup and dependency resolution. */
interface MarkerStore {
  set(key: string, ttlSeconds: number): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** Dead-letter notification channel. */
interface DeadLetterNotifier {
  notify(recipients: readonly string[], message: string): Promise<void>;
}
```

### Dead-Letter Handler

Generic pattern extracted from reclaw's `attachDeadLetterHandler`:

```ts
const attachDeadLetterHandler = (
  worker: WorkerHandle,
  notifier: DeadLetterNotifier,
  opts: {
    getRecipients: (jobData: unknown) => readonly string[];
    formatMessage: (jobId: string, error: string) => string;
  },
) => {
  worker.onFailed(async (jobId, error, attempts, maxAttempts) => {
    if (attempts >= maxAttempts) {
      const recipients = opts.getRecipients(/* job data */);
      const message = opts.formatMessage(jobId, error.message);
      await notifier.notify(recipients, message);
    }
  });
};
```

### BullMQ Adapter (`queue-bullmq/`)

Thin wrapper — almost 1:1 mapping:

```ts
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

const createBullMQBackend = (connection: { host: string; port: number }): QueueBackend => ({
  createQueue: <J>(name: string, opts: QueueOpts) => {
    const queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: opts.retry.attempts,
        backoff: opts.retry.backoff,
        removeOnComplete: opts.retention
          ? { age: opts.retention.completedAgeSec, count: opts.retention.completedCount }
          : undefined,
        removeOnFail: opts.retention
          ? { age: opts.retention.failedAgeSec, count: opts.retention.failedCount }
          : undefined,
      },
    });
    return {
      enqueue: async (id, data, enqueueOpts) => {
        await queue.add(id, data, {
          jobId: id,
          delay: enqueueOpts?.delayMs,
          ...(enqueueOpts?.dedupId ? { deduplication: { id: enqueueOpts.dedupId } } : {}),
        });
      },
      drain: () => queue.drain(),
      close: () => queue.close(),
    };
  },

  createWorker: <J>(name: string, processor: (job: JobLike<any, any>) => Promise<void>, opts: WorkerOpts) => {
    const worker = new Worker(name, async (bullJob) => {
      // Adapt BullMQ Job to JobLike
      const jobLike: JobLike<any, any> = {
        data: bullJob.data,
        updateData: (d) => bullJob.updateData(d),
        updateProgress: (p) => bullJob.updateProgress(p),
      };
      await processor(jobLike);
    }, {
      connection,
      concurrency: opts.concurrency,
      lockDuration: opts.lockDurationMs,
      stalledInterval: opts.stalledIntervalMs,
    });
    return {
      onFailed: (handler) => {
        worker.on("failed", async (job, err) => {
          if (job) await handler(job.id ?? "unknown", err, job.attemptsMade, job.opts?.attempts ?? 1);
        });
      },
      onError: (handler) => { worker.on("error", handler); },
      close: () => worker.close(),
    };
  },
});

/** Redis-backed marker store for dedup and dependency resolution. */
const createRedisMarkerStore = (redis: Redis): MarkerStore => ({
  set: async (key, ttl) => { await redis.set(key, "1", "EX", ttl); },
  exists: async (key) => (await redis.exists(key)) === 1,
  delete: async (key) => { await redis.del(key); },
});
```

### In-Memory Adapter (`queue-memory/`)

For tests — no Redis needed:

```ts
const createInMemoryBackend = (): QueueBackend => {
  // Simple Map-backed queues with synchronous processing
  // ...
};

const createInMemoryJob = <S, C>(initial: { state: S; context: C }): JobLike<S, C> => {
  let current = initial;
  return {
    get data() { return current; },
    updateData: async (d) => { current = d; },
    updateProgress: async () => {},
  };
};
```

---

## Layer 4: Scheduler — Cron with Dependencies

Generalized from reclaw's `scheduler.ts`. Pure decision functions + a timer-based reconciliation loop.

### Types

```ts
interface TaskConfig {
  readonly id: string;
  readonly cron: string;
  /** How long after the scheduled time is the task still valid? */
  readonly validForMs: number;
  /** Other task IDs that must complete before this one runs. */
  readonly dependsOn?: readonly string[];
}

type TaskRegistry = ReadonlyMap<string, TaskConfig>;

type CatchUpDecision =
  | { kind: "skip"; reason: string }
  | { kind: "enqueue-standalone" }
  | { kind: "enqueue-dependents"; dependentIds: readonly string[] };
```

### Pure Decision Functions

Extracted directly from reclaw:

```ts
/** Detect cycles in task dependency graph. */
const hasCycle = (taskId: string, registry: TaskRegistry): boolean => { /* ... */ };

/** Diff active timers vs desired registry → { add, remove, update }. */
const diffRegistry = (
  active: ReadonlyMap<string, TaskConfig>,
  desired: TaskRegistry,
): { add: TaskConfig[]; remove: string[]; update: TaskConfig[] } => { /* ... */ };

/**
 * Decide what to do on catch-up after restart.
 * - Not fired → enqueue standalone
 * - Fired but not completed → skip (in-flight worker will handle)
 * - Fired and completed but dependents unfired → enqueue dependents
 */
const decideCatchUp = (
  taskId: string,
  firedMarker: boolean,
  completedMarker: boolean,
  withinValidityWindow: boolean,
  hasDependents: boolean,
): CatchUpDecision => { /* ... */ };
```

### CronScheduler

```ts
interface CronScheduler {
  /** Reconcile against a new registry. Arms/disarms timers as needed. */
  reconcile(registry: TaskRegistry): void;
  /** Resolve dependents after a task completes. */
  resolveDependents(taskId: string, triggeredAt: Date): Promise<void>;
  /** Stop all timers. */
  stop(): void;
}

const createCronScheduler = (
  queue: QueueHandle<ScheduledJob>,
  markers: MarkerStore,
  opts: { enqueue: (task: TaskConfig, triggeredAt: Date) => Promise<void> },
): CronScheduler => { /* ... */ };
```

---

## Integration with Reclaw

### Current reclaw architecture (before)

```
reclaw/
  core/research-machine.ts    ← hand-written transition() for research pipeline
  core/research-types.ts      ← 10 states, 13 events, research context
  orchestration/
    research-handler.ts       ← imperative shell loop (while !terminal → execute → transition → checkpoint)
    research-states.ts        ← executeState() dispatcher → I/O
    scheduler.ts              ← cron + dependency resolution (tightly coupled)
    worker.ts                 ← BullMQ workers (tightly coupled)
  infra/queue.ts              ← BullMQ queue creation (tightly coupled)
```

### After extraction (reclaw depends on library)

```
@peterstorm/durable-machine/
  core/runner.ts              ← generic runStateMachine() loop
  queue/types.ts              ← QueueBackend, WorkerHandle, MarkerStore
  queue-bullmq/adapter.ts     ← BullMQ adapter
  scheduler/                  ← generic cron + deps

reclaw/
  core/research-machine.ts    ← KEPT: domain-specific transition() (implements Machine<S,E,C>)
  core/research-types.ts      ← KEPT: domain-specific states/events/context
  orchestration/
    research-handler.ts       ← SIMPLIFIED: calls library's runStateMachine() instead of hand-written loop
    research-states.ts        ← KEPT: domain-specific executeState() (implements Executor<S,C,E>)
    scheduler.ts              ← SIMPLIFIED: wraps library's CronScheduler
    worker.ts                 ← SIMPLIFIED: wraps library's WorkerHandle
  infra/queue.ts              ← SIMPLIFIED: calls library's createBullMQBackend()
```

### What reclaw keeps (domain-specific)

| Concern | Why it stays in reclaw |
|---|---|
| Research state machine (10 states, 13 events) | Domain pipeline — the library provides the kernel, not the graph |
| State executors (NotebookLM, Claude, vault writer) | Domain-specific I/O |
| Telegram adapter (messages, inline keyboards) | App-specific notification channel |
| Skill YAML format + watcher | App-specific task config format |
| Claude subprocess management | App-specific AI backend |
| Session store, quota tracker, cortex | App-specific state |
| Concrete job types (ChatJob, ReminderJob, etc.) | App-specific schemas |
| Error classification patterns (`NON_RETRIABLE_PATTERNS`) | Passed as `classifyError` option to runner |

### What moves to the library

| Concern | From reclaw file | To library module |
|---|---|---|
| State machine loop (while→execute→transition→checkpoint) | `research-handler.ts` | `core/runner.ts` |
| `JobLike` abstraction (`updateData`, `updateProgress`) | `research-handler.ts` | `core/types.ts` |
| BullMQ queue creation + default opts | `infra/queue.ts` | `queue-bullmq/adapter.ts` |
| Worker factory + lifecycle | `orchestration/worker.ts` | `queue-bullmq/worker.ts` |
| Dead-letter handler pattern | `orchestration/worker.ts` | `queue/dead-letter.ts` |
| Redis markers (fired/completed) | `infra/queue.ts` | `queue-bullmq/markers.ts` |
| `hasCycle`, `decideCatchUp`, `diffRegistry` | `orchestration/scheduler.ts` | `scheduler/*.ts` |
| Cron reconciliation loop | `orchestration/scheduler.ts` | `scheduler/scheduler.ts` |
| `AsyncMutex` | `core/async-mutex.ts` | `core/mutex.ts` |
| `Result<T, E>` | `core/types.ts` | `core/types.ts` |
| `TraceEvent` | `core/research-types.ts` | `core/types.ts` |

### Concrete migration: research-handler.ts

Before (reclaw, ~80 lines of loop logic):

```ts
// research-handler.ts — current
export async function handleResearchJob(job: ResearchJobLike, deps: ResearchDeps) {
  let { state, context } = job.data;
  context = { ...context, retries: { ...context.retries, [state.kind]: 0 } };

  while (!isTerminal(state)) {
    const startTime = Date.now();
    let event: ResearchEvent;
    try {
      event = await executeState(state, context, deps);
    } catch (err) {
      const { retriable, message } = classifyResearchError(err);
      event = { type: "ERROR", retriable, error: message };
    }

    const prev = state;
    const result = transition(state, event, context);
    state = result.state;
    context = result.context;

    // ... trace, checkpoint (skip failed), progress ...
  }

  if (state.kind === "failed") {
    await deps.telegram.sendMessage(deps.chatId, `Research failed: ${state.error}`);
    throw new Error(state.error);
  }
  return { hubPath: context.hubPath, topic: context.topic };
}
```

After (reclaw, ~10 lines — delegates to library):

```ts
// research-handler.ts — after migration
import { runStateMachine } from "@peterstorm/durable-machine";
import { researchMachine } from "../core/research-machine.js";
import { executeState } from "./research-states.js";

export async function handleResearchJob(job: JobLike<ResearchState, ResearchContext>, deps: ResearchDeps) {
  const executor = (state: ResearchState, ctx: ResearchContext) => executeState(state, ctx, deps);

  const result = await runStateMachine(job, researchMachine, executor, {
    classifyError: classifyResearchError,
    onTrace: (trace) => { /* append to context.trace */ },
  });

  if (result.state.kind === "failed") {
    await deps.telegram.sendMessage(deps.chatId, `Research failed: ${result.state.error}`);
    throw new Error(result.state.error);
  }
  return { hubPath: result.context.hubPath, topic: result.context.topic };
}
```

### Concrete migration: worker.ts

Before (reclaw — hand-wired BullMQ workers with custom processor per queue):

```ts
// Each worker manually creates BullMQ Worker, attaches dead-letter handler, etc.
const researchWorker = workerFactory("reclaw-research", async (job) => {
  const parsed = parseResearchJobData(job.data);
  if (!parsed.ok) throw new Error(parsed.error);
  const wrappedJob = { data: parsed.value, updateData: (d) => job.updateData(d), updateProgress: (p) => job.updateProgress(p) };
  const result = await researchHandler(wrappedJob, deps);
  if (!result.ok) throw new Error(result.error);
}, { connection, concurrency: 1, lockDuration: 60 * 60 * 1000 });
```

After (reclaw — uses library's queue backend):

```ts
import { createBullMQBackend, attachDeadLetterHandler } from "@peterstorm/durable-machine/queue-bullmq";

const backend = createBullMQBackend({ host: config.redisHost, port: config.redisPort });

const researchWorker = backend.createWorker("reclaw-research", async (job) => {
  const parsed = parseResearchJobData(job.data);
  if (!parsed.ok) throw new Error(parsed.error);
  await researchHandler(job, deps);
}, { concurrency: 1, lockDurationMs: 60 * 60 * 1000 });

attachDeadLetterHandler(researchWorker, telegramNotifier, {
  getRecipients: (data) => data.chatId ? [data.chatId] : config.authorizedUserIds,
  formatMessage: (id, err) => `[reclaw] Research job ${id} permanently failed: ${err}`,
});
```

---

## Integration with ai-summary

### Current ai-summary DAG executor

```ts
// executor.ts — current: one-shot, in-memory
for (const wave of waves) {
  await Promise.all(wave.map(nodeId => runNode(...)));
}
```

### After: DAG as a state machine

```ts
// executor.ts — after: state machine with optional durability
import { runDag } from "@peterstorm/durable-machine/dag";

export const runDag = async <I, O>(
  dag: DagDef,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions,
): Promise<Result<O, FrameworkError>> => {
  return dagRunner(dag, input, ctx, {
    // No hooks = current behavior: in-memory, no retries, no HITL
    // Callers can opt in to durability by providing jobLike + hooks
    jobLike: opts?.jobLike,
    onHumanReview: opts?.onHumanReview,
  });
};
```

---

## Implementation Phases

### Phase 1: Core State Machine Runtime

Extract the generic kernel — zero external dependencies.

1. Define types: `Machine<S,E,C>`, `Executor<S,C,E>`, `JobLike<S,C>`, `Result<T,E>`, `TraceEvent<S>`
2. Implement `runStateMachine()` — the imperative shell loop with checkpoint invariant
3. Implement `createInMemoryJob()` — for tests and non-durable use
4. Implement state serialization helpers (Map ↔ Object)
5. Extract `AsyncMutex` from reclaw
6. Unit tests for runner (mock machine + mock executor)

**Files:**
- `core/types.ts`
- `core/runner.ts`
- `core/serialize.ts`
- `core/mutex.ts`
- `core/__tests__/runner.test.ts`
- `core/__tests__/serialize.test.ts`

### Phase 2: DAG Layer

Build the DAG executor on top of the core.

1. Define DAG types: `DagDef`, `NodeDef`, `DagPhase`, `DagEvent`, `DagMachineContext`
2. Extract `topoSort()` from ai-summary
3. Implement pure DAG `transition()` function
4. Implement `runDag()` that compiles DagDef → Machine and calls `runStateMachine`
5. Port existing ai-summary executor tests to verify backwards compatibility
6. Add new tests: retries, human review, abort

**Files:**
- `dag/types.ts`
- `dag/topo.ts`
- `dag/transition.ts`
- `dag/runner.ts`
- `dag/validate.ts`
- `dag/__tests__/transition.test.ts`
- `dag/__tests__/runner.test.ts`

### Phase 3: Queue Interfaces + BullMQ Adapter

Extract queue abstractions and provide the BullMQ implementation.

1. Define interfaces: `QueueBackend`, `QueueHandle`, `WorkerHandle`, `MarkerStore`, `DeadLetterNotifier`
2. Implement generic `attachDeadLetterHandler()`
3. Implement BullMQ adapter (thin wrapper)
4. Implement Redis `MarkerStore`
5. Implement in-memory adapter for tests
6. Integration tests with BullMQ (requires Redis in CI)

**Files:**
- `queue/types.ts`
- `queue/dead-letter.ts`
- `queue-bullmq/adapter.ts`
- `queue-bullmq/worker.ts`
- `queue-bullmq/markers.ts`
- `queue-memory/adapter.ts`
- `queue/__tests__/dead-letter.test.ts`
- `queue-bullmq/__tests__/adapter.test.ts`

### Phase 4: Scheduler

Extract cron scheduling with dependency resolution.

1. Define types: `TaskConfig`, `TaskRegistry`, `CatchUpDecision`
2. Extract pure functions: `hasCycle`, `diffRegistry`, `decideCatchUp`
3. Implement `CronScheduler` with timer reconciliation
4. Port reclaw's scheduler tests
5. Add dependency chain tests (A → B → C catch-up scenarios)

**Files:**
- `scheduler/types.ts`
- `scheduler/cycle.ts`
- `scheduler/diff.ts`
- `scheduler/catch-up.ts`
- `scheduler/scheduler.ts`
- `scheduler/__tests__/cycle.test.ts`
- `scheduler/__tests__/catch-up.test.ts`
- `scheduler/__tests__/scheduler.test.ts`

### Phase 5: Migrate Consumers

1. Wire ai-summary's `executor.ts` to use `runDag` from the library
2. Wire reclaw's `research-handler.ts` to use `runStateMachine` from the library
3. Wire reclaw's workers/queues to use BullMQ adapter
4. Wire reclaw's scheduler to use `CronScheduler`
5. Verify all existing tests pass in both repos

### Phase 6: Conditional Branching (Future)

Deferred until concrete use case emerges.

1. `skipWhen` predicate on `NodeDef`
2. `branchOn` for runtime path selection
3. Dynamic DAG restructuring

---

## Testing Strategy

### Pure transition tests (no I/O, no mocks)

```ts
it("retries on node failure within limit", () => {
  const ctx = makeCtx({ retryLimits: { "llm-call": 2 } });
  const result = dagTransition(
    { kind: "running", wave: 1, completed: new Set() },
    { type: "node-failed", nodeId: "llm-call", error: { kind: "node-crash", message: "timeout" } },
    ctx,
  );
  expect(result.state).toEqual({ kind: "retrying", wave: 1, nodeId: "llm-call", attempt: 1 });
});

it("fails after retry exhaustion", () => {
  const ctx = makeCtx({ retryLimits: { "llm-call": 1 }, retries: new Map([["llm-call", 1]]) });
  const result = dagTransition(
    { kind: "running", wave: 1, completed: new Set() },
    { type: "node-failed", nodeId: "llm-call", error: { kind: "node-crash", message: "timeout" } },
    ctx,
  );
  expect(result.state.kind).toBe("failed");
});

it("pauses for human review", () => {
  const dag = makeDag({ nodes: [{ id: "summary", humanReview: { prompt: "Check this" } }] });
  const ctx = makeCtx({ dag });
  const result = dagTransition(
    { kind: "running", wave: 0, completed: new Set() },
    { type: "wave-done", wave: 0, outputs: new Map([["summary", "text"]]) },
    ctx,
  );
  expect(result.state.kind).toBe("awaiting-human");
});
```

### Runner tests (mock machine + mock executor)

```ts
it("does not checkpoint failed states", async () => {
  const checkpoints: any[] = [];
  const job = createInMemoryJob({ state: { kind: "running" }, context: {} });
  const origUpdateData = job.updateData;
  job.updateData = async (d) => { checkpoints.push(d); await origUpdateData(d); };

  const machine = {
    transition: (s, e, c) => ({ state: { kind: "failed", error: "boom" }, context: c }),
    isTerminal: (s) => s.kind === "failed",
    stateProgress: () => 0,
    maxRetries: {},
  };

  await expect(runStateMachine(job, machine, async () => ({ type: "ERROR" }))).rejects.toThrow();
  expect(checkpoints).toHaveLength(0); // Failed state was NOT checkpointed
});
```

### Integration tests (real BullMQ + Redis)

```ts
it("resumes from checkpoint after simulated crash", async () => {
  const backend = createBullMQBackend({ host: "localhost", port: 6379 });
  // Enqueue job, process first 2 states, kill worker, restart, verify resumes from state 3
});
```

---

## Open Questions

1. **Package name** — `@peterstorm/durable-machine`? `@peterstorm/machina`? Something else?
2. **Monorepo or single package?** — The layers could be separate npm packages (`core`, `dag`, `queue-bullmq`, `scheduler`) or a single package with subpath exports (`durable-machine/core`, `durable-machine/dag`, etc.).
3. **Backoff strategy for DAG retries** — exponential with jitter? Configurable per-node? The core runner doesn't need to know (the machine's transition function can encode delays as context), but it might be convenient.
4. **Multiple human review nodes in one wave** — sequential or parallel review? Current design: first one found wins.
5. **Reroute validation** — backward-only (re-run with different context) or also forward (skip nodes)?
6. **Timeout on human review** — configurable timeout that auto-rejects or auto-approves?
7. **Event sourcing** — store full event log for replay/debugging, or just latest checkpoint?
8. **Reclaw migration order** — start with research pipeline or simpler handlers first?
9. **Where does the repo live?** — New standalone repo (`peterstorm/durable-machine`)? Inside ai-summary monorepo as a package? Inside reclaw?
