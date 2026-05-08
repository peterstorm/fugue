// Queue layer barrel — FR-040..FR-044
// Re-exports all public queue interfaces and helpers.
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-082).

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
} from "./types.js";

export { attachDeadLetterHandler } from "./dead-letter.js";

export {
  createInMemoryBackend,
  adaptInMemoryJob,
  createInMemoryMarkerStore,
  type InMemoryBackend,
} from "./in-memory.js";
