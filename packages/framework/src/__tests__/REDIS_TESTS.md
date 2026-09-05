# Redis/BullMQ Integration Tests

## Why they're skipped

~34 Redis-gated tests across these files require a running Redis instance. They
are guarded at module-load time by:

```typescript
const hasRedis = Boolean(process.env.REDIS_URL);
const describeRedis = hasRedis ? describe : describe.skip;

describeRedis("...", () => { ... });
```

This ensures the test suite passes in any environment without Redis, while
still validating Redis-specific behavior when infrastructure is available.

## Running locally

```bash
# Start Redis via Docker Compose
docker compose -f infra/compose.yaml up redis -d

# Run the Redis-gated tests (REDIS_URL un-skips them at module load)
REDIS_URL=redis://localhost:6379 bun test packages/framework/src/queue-bullmq/
REDIS_URL=redis://localhost:6379 bun test packages/framework/src/__tests__/redis-cache.test.ts
REDIS_URL=redis://localhost:6379 bun test packages/framework/src/__tests__/redis-checkpointer.test.ts
```

## What they cover

- `redis-cache.test.ts` — LLM response caching with TTL via Redis
- `redis-checkpointer.test.ts` — Durable checkpoint persistence (HSET/GET, Lua atomicity)
- `queue-bullmq-adapter.test.ts` — BullMQ enqueue/process, Map serialization round-trip
- Redis Streams event log — XADD/XRANGE, envelope format, replay-to-timestamp

## CI Coverage

CI runs them. `.github/workflows/ci.yml`'s `check` job installs `redis-server`,
starts it on `localhost:6379`, waits for a `PONG`, and exports `REDIS_URL` into
`$GITHUB_ENV` before the typecheck+test loop — so every push and PR exercises the
Redis-gated suites rather than skipping them.

The loop asserts `REDIS_URL` is set before running. That guard is the point: the
gating is a module-load `const describeRedis = hasRedis ? describe : describe.skip`,
and a skipped suite reports a *pass*, so a Redis that failed to start would
otherwise turn the suites that prove concurrent spend cannot double-count into a
silent no-op on the merge gate.
