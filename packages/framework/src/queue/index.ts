// Queue layer barrel — interfaces, dead-letter, in-memory backend
// Re-exports all public queue interfaces and helpers.
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (enforced by check-imports.ts).

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
} from "./types.js";

export { attachDeadLetterHandler } from "./dead-letter.js";

export {
  createInMemoryBackend,
  createInMemoryEventLogReader,
  adaptInMemoryJob,
  createInMemoryMarkerStore,
  type InMemoryBackend,
} from "./in-memory.js";
