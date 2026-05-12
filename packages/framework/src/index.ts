// @ai-summary/framework — barrel export
//
// Public surface: authoring-facing types, runtime entry points, and the
// pluggable seams (Observer, Cache, LLM, JobLike, Scheduler) consumers
// implement. Pure-internal helpers (transition primitives, JSON
// serialization, scheduler internals) are intentionally NOT re-exported
// here. Direct imports from their concrete paths remain available for tests
// and any consumer that genuinely needs them.

export * from "./types/index.js";
export * from "./executor/index.js";
export * from "./nodes/index.js";
export * from "./observer/index.js";
export * from "./checkpoint/index.js";
export * from "./cache/index.js";
export * from "./prompts/index.js";
export * from "./llm/index.js";
export * from "./tracing/index.js";
export { setFrameworkLogger, fwLogger } from "./logger.js";
export type { FrameworkLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// State-machine kernel (NFR-021) — public surface only
// ---------------------------------------------------------------------------
export type { Machine, Executor, JobLike, RecordedEvent, RunOptions, TraceEvent } from "./state-machine/types.js";
export { runStateMachine } from "./state-machine/runner.js";
export { createInMemoryJob } from "./queue/in-memory-job.js";
export type { InMemoryJob, InMemoryJobOptions } from "./queue/in-memory-job.js";
export { replayEvents, replayEventsUntil, replayEventSlice } from "./state-machine/replay.js";
// `toJson` / `fromJson` remain public — they're the documented serialization
// helpers for callers building custom JobLike backends. The lower-level
// `serializeValue` / `deserializeValue` are intentionally internal; import
// from their concrete paths if you genuinely need them.
export { toJson, fromJson } from "./state-machine/serialize.js";
export { type Result, type Ok, type Err, ok, err, isOk, isErr, andThen, map, mapErr, unwrap, unwrapOr } from "./types/result.js";

// ---------------------------------------------------------------------------
// DAG runtime (NFR-021) — public surface only
//
// `runDag` is the single sanctioned public entry. `runDagStateful`,
// `runDagAsWorkerJob`, `compileDagToMachine`, `buildDagExecutor`, and
// `dagTransition` live on the `@ai-summary/framework/advanced` subpath
// for callers building custom machines on the kernel — see `./advanced.ts`.
// Keeping them off the main barrel signals that reaching for them is a
// deliberate choice, not an accident from a wildcard import.
// ---------------------------------------------------------------------------
export type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./dag-runtime/types.js";
export { topoSort } from "./shared/topo.js";

// ---------------------------------------------------------------------------
// Queue layer (NFR-021)
// ---------------------------------------------------------------------------
export type {
  QueueBackend,
  QueueHandle,
  WorkerHandle,
  MarkerStore,
  DeadLetterNotifier,
  DeadLetterOpts,
  EnqueueOpts,
  QueueOpts,
  WorkerOpts,
  EventLogOpts,
} from "./queue/types.js";
export { attachDeadLetterHandler } from "./queue/dead-letter.js";
export {
  createInMemoryBackend,
  adaptInMemoryJob,
  createInMemoryMarkerStore,
  type InMemoryBackend,
} from "./queue/in-memory.js";

// ---------------------------------------------------------------------------
// Queue-BullMQ adapter (NFR-021)
// ---------------------------------------------------------------------------
export { createBullMQBackend } from "./queue-bullmq/adapter.js";
export { defaultStreamKey, adaptBullMQJob } from "./queue-bullmq/job.js";
export type { AdaptBullMQJobOpts } from "./queue-bullmq/job.js";
export { createRedisMarkerStore } from "./queue-bullmq/markers.js";
export { createRedisStreamReader } from "./queue-bullmq/event-log.js";
export type { EventLogReader } from "./queue-bullmq/event-log.js";

// ---------------------------------------------------------------------------
// Scheduler (NFR-021) — public surface only. `hasCycle` and `diffRegistry`
// are scheduler internals; import directly from their files if needed.
// ---------------------------------------------------------------------------
export type { TaskConfig, TaskRegistry, RegistryDiff, CatchUpDecision } from "./scheduler/types.js";
export { decideCatchUp } from "./scheduler/catch-up.js";
export type { CronScheduler, CronSchedulerOpts } from "./scheduler/scheduler.js";
export { createCronScheduler } from "./scheduler/scheduler.js";

// ---------------------------------------------------------------------------
// Capability-typed NodeContext helpers — public surface for constructing
// NodeContexts and the always-present field defaults.
// ---------------------------------------------------------------------------
export { makeNodeContext, consoleLogger, noopTracer, noopObserver } from "./shared/index.js";
export type { Capability, CapabilityFields, BaseNodeContext, TypedNodeContext, NodeContextInit } from "./types/node.js";
