// State-machine kernel barrel export

// Types
export type { Machine, Executor, JobLike, RecordedEvent, RunOptions, TraceEvent } from "./types.js";

// Runner
export { runStateMachine } from "./runner.js";

// Replay
export { replayEvents, replayEventsUntil, replayEventSlice } from "./replay.js";

// Serialization helpers (FR-010)
export { serializeValue, deserializeValue, toJson, fromJson } from "./serialize.js";

// Re-export Result/ok/err from types — Gap-1 fix
export { type Result, type Ok, type Err, ok, err, isOk, isErr, andThen, map, mapErr, unwrap, unwrapOr } from "../types/result.js";
