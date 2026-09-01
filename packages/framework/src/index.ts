// @fuguejs/framework — barrel export
//
// Public surface: authoring-facing types, runtime entry points, and the
// pluggable seams (Observer, Cache, LLM, JobLike, Scheduler) consumers
// implement. Documented JSON wrappers are public for custom durable backends;
// low-level serialization and transition primitives plus scheduler internals
// remain internal. Direct concrete-path imports remain available for tests and
// consumers that genuinely need those internals.

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
// `runDagStateful` (the back-compat flat `Result<O>` entry for block-until-
// decided callers, per ADR-0060 §4), `compileDagToMachine`, `buildDagExecutor`,
// and `dagTransition` live on the `@fuguejs/framework/advanced` subpath
// for callers building custom machines on the kernel — see `./advanced.ts`.
// Keeping them off the main barrel signals that reaching for them is a
// deliberate choice, not an accident from a wildcard import.
// ---------------------------------------------------------------------------
export type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanAction, HumanReviewOutcome, HumanGatePayload, DagTopology, DagRetryState, DagHumanGateConfig, DagRoutingState } from "./dag-runtime/types.js";
// The synthetic node id the kernel attributes executor-level (non-node) crashes
// to. Exported so hosts mapping their own infra failures onto a FrameworkError
// reuse the validated sentinel instead of re-casting the raw string.
export { EXECUTOR_NODE_ID } from "./dag-runtime/types.js";
// Runtime guard + discriminant set for `DagPhase`, kept in lockstep with the
// union by the compiler. Exported so a deserialization boundary (e.g. a host
// reading a persisted checkpoint) can validate `state.kind` before driving an
// exhaustive transition, rather than `as`-casting an unvalidated string in.
export { DAG_PHASE_KINDS, isDagPhaseKind } from "./dag-runtime/types.js";

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
// Queue-BullMQ adapter — moved to `@fuguejs/framework/bullmq` subpath.
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
// Capability helpers not already supplied by the leading types barrel.
// ---------------------------------------------------------------------------
export { makeNodeContext, consoleLogger, noopTracer, noopObserver, createPassthroughBroker } from "./shared/index.js";
// Built-in capability catalogue — runtime values consumed by `fugue capabilities`
// and any tooling that needs the authoritative built-in set + its metadata.
export { BUILTIN_CAPABILITY_KEYS, BUILTIN_CAPABILITY_INFO } from "./types/node.js";
export type { BuiltinCapabilityKey, CapabilityInfo } from "./types/node.js";

// ---------------------------------------------------------------------------
// DAG authoring CLI — the programmatic API behind the `fugue` binary. Exposed
// so tooling (and the @fuguejs/examples lint suite) can validate, describe, and
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
