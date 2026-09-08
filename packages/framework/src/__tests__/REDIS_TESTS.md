# Redis/BullMQ Integration Tests

## Focused runs can skip

Redis-gated suites select `describe` or `describe.skip` at module load from `process.env.REDIS_URL`. This keeps package-focused iteration possible without infrastructure, but a skipped suite is not parity evidence.

```typescript
const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
```

## Canonical repository verification

From the repository root, use `bun run verify`, not a package-only Redis helper. Its prerequisite phase fails closed unless:

- Bun exactly matches the production Dockerfile (currently 1.4.2);
- `redis-server` is available in `PATH`;
- `REDIS_URL` is a valid, non-blank `redis://` or `rediss://` URL whose connection is authorized, returns `PONG`, and supports `ACL CAT`.

The executable and URL are separate requirements. A host queue test starts its own isolated Unix-socket `redis-server`, while the URL enables the repository's live Redis suites.

The gate does not start, own, reset, or stop the server named by a contributor's `REDIS_URL`. Redis authentication is optional server policy, but the canonical guide and CI deliberately prove a credentialed default-user connection. The integration tests write fixtures and create/delete ACL users, so the URL must point to an exclusive disposable test server—never production or shared development infrastructure. See [`../../../../CONTRIBUTING.md`](../../../../CONTRIBUTING.md) for the authenticated, loopback-only Bash setup with caller-owned cleanup.

## Focused framework commands

With a disposable server already running:

```bash
REDIS_URL=redis://default:<password>@127.0.0.1:<port> \
  bun test packages/framework/src/queue-bullmq/

REDIS_URL=redis://default:<password>@127.0.0.1:<port> \
  bun test packages/framework/src/__tests__/redis-cache.test.ts \
           packages/framework/src/__tests__/redis-checkpointer.test.ts \
           packages/framework/src/__tests__/map-checkpoint-corruption.test.ts
```

These commands are intentionally narrower than `bun run verify` and do not prove the host Redis suites, all workspaces, root scripts, documentation, or the production-image Oracle smoke.

## What the framework suites cover

- `redis-cache.test.ts` — response caching and TTL behavior.
- `redis-checkpointer.test.ts` — durable checkpoint persistence, corruption handling, and atomicity.
- `map-checkpoint-corruption.test.ts` — mapped-run refusal when persisted fan state is corrupt.
- `queue-bullmq-adapter.test.ts` — BullMQ queue/worker behavior, serialization, deduplication, and Redis Streams event logs.

## CI and release coverage

Both `.github/workflows/ci.yml` and `.github/workflows/release.yaml` call `.github/workflows/verify.yml`. Its `workspace-gate` job installs and starts a disposable Redis service, exports `REDIS_URL`, and then invokes exactly `bun run verify`; the preflight prevents an unavailable or non-ACL server from becoming a silent skip.

The reusable workflow also requires a separate `original-image-oracle-smoke` job. That image-specific control is not part of local `bun run verify` and makes no live-database claim.
