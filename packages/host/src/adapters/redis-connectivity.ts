/**
 * ioredis-backed Redis connectivity adapter — SHARED by Redis-using entrypoints.
 *
 * The single-tenant binary (`main.ts`), per-tenant worker (`worker-main.ts`),
 * and supervisor (`main-supervisor.ts`) need the SAME `RedisPort` over ioredis.
 * The worker's only delta is an optional per-tenant ACL credential (ADR-0067);
 * the supervisor composes privileged pub/sub, ACL, and audit capabilities around
 * the same data-port factory. A command or transaction fix therefore lands once.
 *
 * Side-effectful (it dials Redis), so it lives in `adapters/` (imperative shell),
 * never in `domain/`. The dynamic `import("ioredis")` keeps the driver out of the
 * module graph for tests that never connect.
 */

import type { HitlRedisPort, RedisConnectivityPort, RedisPort } from "../ports.js";
import type { HostError } from "../domain/host-error.js";
import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
// Type-only — erased at compile time, so importing this module loads NO ioredis
// at runtime. The driver is pulled by the dynamic `import("ioredis")` in the
// default factory ONLY, never for a caller that injects its own client factory.
import type { Redis as IoRedis, RedisOptions } from "ioredis";

/**
 * A Redis ACL credential pair. STRUCTURAL on purpose — any `{ username, password }`
 * (e.g. the worker's `AclCredential`, minted from the supervisor's spawn-env
 * handoff) satisfies it, so this adapter need not depend on the worker bootstrap.
 */
interface RedisAclCredential {
  readonly username: string;
  readonly password: string;
}

/** The wired connectivity bundle: a startup probe port, the data port, and teardown. */
interface RedisConnectivityBundle {
  readonly port: RedisConnectivityPort;
  readonly redis: RedisPort;
  /** Teardown — resolves once the client has quit; the result is not meant to be consumed. */
  readonly disconnect: () => Promise<void>;
}

/**
 * Wrap a thrown ioredis error into the `redis-unavailable` HostError at the port
 * boundary, naming the `operation` (the Redis verb + key) without leaking a value.
 * One helper so every `RedisPort` method maps failures identically.
 */
const redisErr = (operation: string, e: unknown): HostError => ({
  kind: "redis-unavailable",
  operation: `${operation}: ${safeErrorMessage(e)}`,
});

type RedisFailure = (operation: string, error: unknown) => HostError;

/**
 * Adapt one ioredis command connection to the complete host `RedisPort`.
 * WATCH state and error conversion live here so every binary shares the same
 * optimistic-transaction, cleanup, and multi-key command contracts.
 */
export const createIoredisRedisPort = (
  client: IoRedis,
  redisFailure: RedisFailure = redisErr,
): RedisPort => {
  let watchTail: Promise<void> = Promise.resolve();
  const serializeWatch = async <T,>(
    work: () => Promise<Result<T, HostError>>,
  ): Promise<Result<T, HostError>> => {
    let releaseTurn: () => void = () => {};
    const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const previous = watchTail;
    watchTail = previous.then(() => turn);
    await previous;
    try {
      return await work();
    } finally {
      releaseTurn();
    }
  };

  const watchGuarded = <T>(
    operation: string,
    body: () => Promise<Result<T, HostError>>,
  ): Promise<Result<T, HostError>> =>
    serializeWatch(async () => {
      try {
        return await body();
      } catch (error) {
        try { await client.unwatch(); } catch { /* primary error is authoritative */ }
        return err(redisFailure(operation, error));
      }
    });

  const compareAndRun = (
    operation: string,
    key: string,
    expectedValue: string,
    stage: (multi: ReturnType<typeof client.multi>) => ReturnType<typeof client.multi>,
  ): Promise<Result<boolean, HostError>> =>
    watchGuarded(`${operation} ${key}`, async () => {
      await client.watch(key);
      if (await client.get(key) !== expectedValue) {
        await client.unwatch();
        return ok(false);
      }
      const executed = await stage(client.multi()).exec();
      if (executed === null) return ok(false);
      const [commandError, applied] = executed[0] ?? [];
      if (commandError !== null) throw commandError;
      return ok(applied === 1);
    });

  const redisCall = async <T>(
    describe: () => string,
    run: () => Promise<T>,
  ): Promise<Result<T, HostError>> => {
    try {
      return ok(await run());
    } catch (error) {
      return err(redisFailure(describe(), error));
    }
  };

  return {
    get: (key) => redisCall(() => `GET ${key}`, () => client.get(key)),
    set: (key, value, opts) =>
      redisCall(() => `SET ${key}`, () =>
        opts?.expiresInSec !== undefined
          ? client.set(key, value, "EX", opts.expiresInSec)
          : client.set(key, value)),
    del: (key, ...additionalKeys) => {
      const keys = [key, ...additionalKeys];
      return redisCall(() => `DEL ${keys.join(" ")}`, () => client.del(...keys));
    },
    scan: (pattern, cursor = "0") =>
      redisCall(() => `SCAN ${pattern}`, async () => {
        const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
        return { cursor: nextCursor, keys };
      }),
    setNx: (key, value, opts) =>
      redisCall(() => `SETNX ${key}`, async () =>
        opts?.expiresInSec !== undefined
          ? (await client.set(key, value, "EX", opts.expiresInSec, "NX")) === "OK"
          : (await client.setnx(key, value)) === 1),
    compareAndDelete: (key, expectedValue) =>
      compareAndRun("COMPARE-AND-DELETE", key, expectedValue, (multi) => multi.del(key)),
    compareAndExpire: (key, expectedValue, expiresInSec) =>
      compareAndRun("COMPARE-AND-EXPIRE", key, expectedValue, (multi) => multi.expire(key, expiresInSec)),
    setIfValue: (guardKey, expectedValue, key, value, opts) =>
      watchGuarded(`SET-IF-VALUE ${guardKey} -> ${key}`, async () => {
        for (;;) {
          await client.watch(guardKey);
          if (await client.get(guardKey) !== expectedValue) {
            await client.unwatch();
            return ok(false);
          }
          const executed = await client.multi().set(key, value, "EX", opts.expiresInSec).exec();
          if (executed === null) continue;
          const [commandError, written] = executed[0] ?? [];
          if (commandError !== null) throw commandError;
          return ok(written === "OK");
        }
      }),
    setNxIfPresent: (guardKey, key, value, opts) =>
      watchGuarded(`SETNX-IF-PRESENT ${guardKey} -> ${key}`, async () => {
        for (;;) {
          await client.watch(guardKey);
          if (await client.get(guardKey) === null) {
            await client.unwatch();
            return ok("not-present");
          }
          const executed = await client.multi().set(key, value, "EX", opts.expiresInSec, "NX").exec();
          if (executed === null) continue;
          const [commandError, created] = executed[0] ?? [];
          if (commandError !== null) throw commandError;
          return ok(created === "OK" ? "created" : "exists");
        }
      }),
    sAdd: (key, member) => redisCall(() => `SADD ${key}`, () => client.sadd(key, member)),
    sRem: (key, member) => redisCall(() => `SREM ${key}`, () => client.srem(key, member)),
    sMembers: (key) => redisCall(() => `SMEMBERS ${key}`, () => client.smembers(key)),
  };
};

/**
 * Factory for the underlying ioredis client. INJECTED so a unit test can supply a
 * fake client — and inspect the options it receives (e.g. the per-tenant ACL
 * credential override) — without a live Redis. Defaults to `defaultIoredisFactory`,
 * which dynamically imports ioredis so the driver is loaded ONLY when no factory is
 * injected. This single seam makes every behavioral invariant of the wired ports
 * (the `status === "wait"` connect guard, the credential override, the atomic
 * `SET … EX … NX` acquire) testable against a fake.
 */
export type RedisClientFactory = (redisUrl: string, options: RedisOptions) => IoRedis;

export const requireHitlRedisPort = (redis: RedisPort): HitlRedisPort => {
  const missing = (["compareAndExpire", "setIfValue", "setNxIfPresent"] as const)
    .filter((capability) => redis[capability] === undefined);
  if (missing.length > 0) {
    throw new Error(`hitl: Redis transaction capabilities unavailable: ${missing.join(", ")}`);
  }
  return redis as HitlRedisPort;
};

const defaultIoredisFactory = async (): Promise<RedisClientFactory> => {
  const { Redis } = await import("ioredis");
  return (redisUrl, options) => new Redis(redisUrl, options);
};

/**
 * Construct the ioredis-backed connectivity bundle.
 *
 * @param redisUrl       the connection URL (may carry inherited credentials).
 * @param aclCredential  OPTIONAL per-tenant ACL credential (ADR-0067). When set,
 *   the explicit username/password OVERRIDE any inherited in `redisUrl`, so the
 *   worker authenticates as its OWN `~fugue:<tenant>:*`-scoped user and a
 *   cross-tenant key access is refused by Redis with NOPERM. Absent ⇒ connect with
 *   the `redisUrl` credential (ACL disabled / single-tenant deployment).
 * @param createClient   OPTIONAL ioredis client factory (test seam). Defaults to
 *   the dynamic-import ioredis factory; a unit test injects a fake.
 */
export const createRedisConnectivity = async (
  redisUrl: string,
  aclCredential?: RedisAclCredential,
  createClient?: RedisClientFactory,
): Promise<Result<RedisConnectivityBundle, HostError>> => {
  try {
    // The client comes from the injected factory (default: ioredis, dynamically
    // imported so the driver stays out of the module graph for a caller that
    // injects its own factory).
    const makeClient = createClient ?? (await defaultIoredisFactory());
    const client = makeClient(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      ...(aclCredential !== undefined
        ? { username: aclCredential.username, password: aclCredential.password }
        : {}),
    });

    const port: RedisConnectivityPort = {
      ping: async () => {
        try {
          // `lazyConnect: true` leaves the client in the "wait" state until the
          // first probe dials it. Guard the connect on that state: after the
          // initial connection ioredis owns reconnection, and calling `connect()`
          // on an already-connected client rejects — which would make every probe
          // tick after the first falsely report Redis dead and flap the host into
          // `degraded:redis-disconnected`.
          if (client.status === "wait") {
            await client.connect();
          }
          await client.ping();
          return ok(undefined);
        } catch (e) {
          return err(redisErr("PING at startup", e));
        }
      },
    };

    const redis = createIoredisRedisPort(client);

    return ok({
      port,
      redis,
      disconnect: async () => {
        await client.quit();
      },
    });
  } catch (e) {
    return err(redisErr("Redis client initialization", e));
  }
};

/**
 * Best-effort Redis disconnect on an entrypoint's error path.
 *
 * ONE encoding (round-38 cs-19) of the cleanup both `main.ts` and
 * `worker-main.ts` need on their startup-failure path. It goes to `console`
 * rather than the structured logger deliberately: the logger may itself be part
 * of the failed bootstrap, and this diagnostic must not be able to displace the
 * original error being rethrown.
 */
export const disconnectRedisQuietly = async (
  disconnect: () => Promise<void>,
): Promise<void> => {
  try {
    await disconnect();
  } catch (disconnectErr) {
    try {
      console.error(JSON.stringify({
        level: "error",
        msg: "Failed to disconnect Redis during error cleanup",
        error: safeErrorMessage(disconnectErr),
        ts: new Date().toISOString(),
      }));
    } catch {
      // Cleanup diagnostics must never replace the authoritative startup error.
    }
  }
};
