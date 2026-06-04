// @fuguejs/framework/redis — Redis adapter subpath export.
//
// Consumers that need Redis-backed caching, checkpointing, or cross-process
// freshness detection import from this subpath. Consumers running fully
// in-memory (tests, single-process scripts) import from the main barrel and
// avoid pulling ioredis into their dependency graph.

export { RedisCache } from "./cache/redis-cache.js";
export { RedisCheckpointer } from "./checkpoint/redis-checkpointer.js";
export { RedisFreshnessIndex } from "./checkpoint/redis-freshness-index.js";
