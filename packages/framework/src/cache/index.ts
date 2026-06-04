export { type Cache, InMemoryCache } from "./cache.js";
export { stableHash } from "../shared/hash.js";
// RedisCache is exported from `@fuguejs/framework/redis` — importing it
// here would pull ioredis into every consumer's bundle.
