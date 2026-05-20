# Redis/BullMQ Integration Tests

## Why they're skipped

These 34 tests require a running Redis instance. They are guarded by:

```typescript
describe.skipIf(!process.env.REDIS_URL)("...", () => { ... });
```

This ensures the test suite passes in any environment without Redis, while
still validating Redis-specific behavior when infrastructure is available.

## Running locally

```bash
# Start Redis via Docker Compose
docker compose -f infra/compose.yaml up redis -d

# Set the connection URL
export REDIS_URL=redis://localhost:6379

# Run Redis-dependent tests
bun test --filter redis
bun test --filter bullmq
bun test packages/framework/src/queue-bullmq/
```

## What they cover

- `redis-cache.test.ts` — LLM response caching with TTL via Redis
- `redis-checkpointer.test.ts` — Durable checkpoint persistence (HSET/GET, Lua atomicity)
- `redis-freshness-index.test.ts` — Cross-process witness tracking (ZADD/ZRANGEBYSCORE)
- `queue-bullmq-adapter.test.ts` — BullMQ enqueue/process, Map serialization round-trip
- `bullmq-adapter-unit.test.ts` — Worker lifecycle, onFailed/onExhausted, dead-letter
- Redis Streams event log — XADD/XRANGE, envelope format, replay-to-timestamp

## CI Coverage

When CI infrastructure is established, add a Redis service container:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
env:
  REDIS_URL: redis://localhost:6379
```
