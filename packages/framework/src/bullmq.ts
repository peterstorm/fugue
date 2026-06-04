// @fuguejs/framework/bullmq — BullMQ adapter subpath export.
//
// Consumers that need durable queue/worker/event-log backed by BullMQ + Redis
// import from this subpath. Consumers using only in-memory queues (tests,
// single-process scripts) import from the main barrel and avoid pulling
// bullmq/ioredis into their dependency graph.

export { createBullMQBackend } from "./queue-bullmq/adapter.js";
export { defaultStreamKey, adaptBullMQJob } from "./queue-bullmq/job.js";
export type { AdaptBullMQJobOpts } from "./queue-bullmq/job.js";
export { createRedisMarkerStore } from "./queue-bullmq/markers.js";
export { createRedisStreamReader } from "./queue-bullmq/event-log.js";
