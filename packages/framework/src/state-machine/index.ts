// State-machine kernel barrel export

// Types
export type { Machine, Executor, JobLike, RecordedEvent, KernelRunOpts, TraceEvent } from "./types.js";

// Runner
export { runStateMachine } from "./runner.js";

// Replay
export { foldStep, replayEvents, replayEventsUntil, replayEventSlice } from "./replay.js";

// Serialization helpers
export { serializeValue, deserializeValue, toJson, fromJson } from "./serialize.js";

// Re-export Result/ok/err from types
export { type Result, type Ok, type Err, ok, err, isOk, isErr, andThen, map, mapErr, unwrapOr } from "../types/result.js";
