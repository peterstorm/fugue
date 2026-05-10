// @ai-summary/framework — barrel export
export * from "./types/index.js";
export * from "./executor/index.js";
export * from "./nodes/index.js";
export * from "./observer/index.js";
export * from "./checkpoint/index.js";
export * from "./cache/index.js";
export * from "./prompts/index.js";
export * from "./llm/index.js";
export * from "./tracing/index.js";

// ---------------------------------------------------------------------------
// State-machine kernel (NFR-021)
// ---------------------------------------------------------------------------
export type { Machine, Executor, JobLike, RecordedEvent, RunOptions, TraceEvent } from "./state-machine/types.js";
export { runStateMachine } from "./state-machine/runner.js";
export { createInMemoryJob } from "./state-machine/in-memory-job.js";
export type { InMemoryJob, InMemoryJobOptions } from "./state-machine/in-memory-job.js";
export { replayEvents, replayEventsUntil, replayEventsBetween } from "./state-machine/replay.js";
export { serializeValue, deserializeValue, toJson, fromJson } from "./state-machine/serialize.js";
export { AsyncMutex } from "./state-machine/mutex.js";
export { type Result, type Ok, type Err, ok, err, isOk, isErr, andThen, map, mapErr, unwrap, unwrapOr } from "./types/result.js";

// ---------------------------------------------------------------------------
// DAG runtime (NFR-021)
// ---------------------------------------------------------------------------
export type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./dag-runtime/types.js";
export { dagTransition } from "./dag-runtime/transition.js";
export {
  handleWaveDone,
  handleNodeFailed,
  handleHumanResponse,
  advanceToNextWave,
  collectHumanReviewQueue,
  computeBackoffMs,
  getRetryLimit,
  waveNodes,
  waveIndexOf,
} from "./dag-runtime/transition-helpers.js";
export { compileDagToMachine } from "./dag-runtime/machine.js";
export { topoSort } from "./executor/topo.js";
export { buildDagExecutor } from "./dag-runtime/executor.js";
export { runDagStateful, runDagAsWorkerJob } from "./dag-runtime/run-dag-stateful.js";
export type { DagRunOpts } from "./dag-runtime/run-dag-stateful.js";

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
// Scheduler (NFR-021) — internal marker helpers intentionally omitted
// ---------------------------------------------------------------------------
export type { TaskConfig, TaskRegistry, RegistryDiff, CatchUpDecision } from "./scheduler/types.js";
export { hasCycle } from "./scheduler/cycle.js";
export { diffRegistry } from "./scheduler/diff.js";
export { decideCatchUp } from "./scheduler/catch-up.js";
export type { CronScheduler, CronSchedulerOpts } from "./scheduler/scheduler.js";
export { createCronScheduler } from "./scheduler/scheduler.js";
