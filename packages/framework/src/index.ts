// @fugue/framework — barrel export
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
export * from "./http/index.js";
export * from "./describe/index.js";
export * from "./tracing/index.js";
export { setFrameworkLogger, fwLogger } from "./logger.js";
export type { FrameworkLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// State-machine kernel — public surface only
// ---------------------------------------------------------------------------
export type { Machine, Executor, JobLike, RecordedEvent, KernelRunOpts, TraceEvent } from "./state-machine/types.js";
export { runStateMachine } from "./state-machine/runner.js";
export { createInMemoryJob } from "./queue/in-memory-job.js";
export type { InMemoryJob, InMemoryJobOptions } from "./queue/in-memory-job.js";
export { replayEvents, replayEventsUntil, replayEventSlice } from "./state-machine/replay.js";
// `toJson` / `fromJson` remain public — they're the documented serialization
// helpers for callers building custom JobLike backends. The lower-level
// `serializeValue` / `deserializeValue` are intentionally internal; import
// from their concrete paths if you genuinely need them.
export { toJson, fromJson, tryFromJson } from "./state-machine/serialize.js";

// ---------------------------------------------------------------------------
// DAG runtime — public surface only
//
// `runDag` and `runDagAsWorkerJob` are the sanctioned public entries.
// `runDagStateful` (deprecated), `compileDagToMachine`, `buildDagExecutor`,
// and `dagTransition` live on the `@fugue/framework/advanced` subpath
// for callers building custom machines on the kernel — see `./advanced.ts`.
// Keeping them off the main barrel signals that reaching for them is a
// deliberate choice, not an accident from a wildcard import.
// ---------------------------------------------------------------------------
export type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanAction, DagTopology, DagRetryState, DagHumanGateConfig, DagRoutingState } from "./dag-runtime/types.js";

// ---------------------------------------------------------------------------
// Queue layer
// ---------------------------------------------------------------------------
export type {
  QueueBackend,
  QueueHandle,
  WorkerHandle,
  MarkerStore,
  DeadLetterNotifier,
  DeadLetterOpts,
  EnqueueOpts,
  EventLogReader,
  QueueOpts,
  WorkerOpts,
  EventLogOpts,
} from "./queue/types.js";
export { attachDeadLetterHandler } from "./queue/dead-letter.js";
export {
  createInMemoryBackend,
  createInMemoryEventLogReader,
  adaptInMemoryJob,
  createInMemoryMarkerStore,
  type InMemoryBackend,
} from "./queue/in-memory.js";

// ---------------------------------------------------------------------------
// Queue-BullMQ adapter — moved to `@fugue/framework/bullmq` subpath.
// Consumers that need durable BullMQ queues import from the subpath to avoid
// pulling bullmq/ioredis into their dependency graph.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scheduler — public surface only. `hasCycle` and `diffRegistry`
// are scheduler internals; import directly from their files if needed.
// ---------------------------------------------------------------------------
export type { TaskConfig, TaskRegistry, TaskRegistryStore, RegistryDiff, CatchUpDecision } from "./scheduler/types.js";
export { decideCatchUp } from "./scheduler/catch-up.js";
export type { CronScheduler, CronSchedulerOpts } from "./scheduler/scheduler.js";
export { createCronScheduler } from "./scheduler/scheduler.js";

// ---------------------------------------------------------------------------
// Capability-typed NodeContext helpers — public surface for constructing
// NodeContexts and the always-present field defaults.
// ---------------------------------------------------------------------------
export { makeNodeContext, consoleLogger, noopTracer, noopObserver } from "./shared/index.js";
export type { Capability, CapabilityRegistry, BaseNodeContext, TypedNodeContext, NodeContextInit, HttpCapability } from "./types/node.js";
export type { CapabilityHandle, AdapterFactory } from "./types/capability-handle.js";
// Built-in capability catalogue — runtime values consumed by `fugue capabilities`
// and any tooling that needs the authoritative built-in set + its metadata.
export { BUILTIN_CAPABILITY_KEYS, BUILTIN_CAPABILITY_INFO } from "./types/node.js";
export type { BuiltinCapabilityKey, CapabilityInfo } from "./types/node.js";

// ---------------------------------------------------------------------------
// DAG authoring CLI — the programmatic API behind the `fugue` binary. Exposed
// so tooling (and the @fugue/examples lint suite) can validate, describe, and
// enumerate capabilities in-process without spawning the bin.
// ---------------------------------------------------------------------------
export { runLint } from "./cli/lint.js";
export { runDescribe } from "./cli/describe.js";
export { runCapabilities } from "./cli/capabilities.js";
export type {
  LintResult,
  LintError,
  DescribeResult,
  CapabilitiesResult,
  CapabilityCatalogEntry,
} from "./cli/types.js";
