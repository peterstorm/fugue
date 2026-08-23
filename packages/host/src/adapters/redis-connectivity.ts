/**
 * ioredis-backed Redis connectivity adapter — SHARED by both binaries.
 *
 * The single-tenant binary (`main.ts`) and the per-tenant worker (`worker-main.ts`)
 * need the SAME `RedisConnectivityPort` + `RedisPort` over ioredis; the only
 * worker-specific delta is an optional per-tenant ACL credential (ADR-0067) that
 * overrides the inherited `REDIS_URL` auth. This module is that one
 * implementation, so a fix or a new `RedisPort` method lands in ONE place and both
 * binaries inherit it — no drift between two hand-maintained copies.
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

    // WATCH state is connection-scoped, so every optimistic transaction shares
    // one turnstile. Ordinary Redis commands remain concurrent; only the small
    // ownership/gate transactions need this client-local serialization.
    let watchTail: Promise<void> = Promise.resolve();
    const serializeWatch = async <T,>(work: () => Promise<Result<T, HostError>>): Promise<Result<T, HostError>> => {
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

    /**
     * Own the WATCH failure contract for every optimistic-locking method: on a
     * throw, release the watch before converting to a typed failure.
     *
     * ONE definition instead of the identical catch-and-unwatch tail repeated on
     * each method. The UNWATCH is the load-bearing part: `serializeWatch` runs
     * these turns on a SHARED connection, so a watch left dangling by a throwing
     * turn would still be armed when the next turn's MULTI executes, silently
     * aborting an unrelated caller's transaction. The unwatch is itself guarded
     * because the primary error must stay authoritative.
     */
    const watchGuarded = <T>(
      operation: string,
      body: () => Promise<Result<T, HostError>>,
    ): Promise<Result<T, HostError>> =>
      serializeWatch(async () => {
        try {
          return await body();
        } catch (e) {
          try { await client.unwatch(); } catch { /* primary error is authoritative */ }
          return err(redisErr(operation, e));
        }
      });

    /**
     * The compare-and-X protocol: WATCH the key, re-read it, abort unless it still
     * holds `expectedValue`, then run `stage`'s single command inside a MULTI that
     * Redis discards if the key changed underneath.
     *
     * Shared by `compareAndDelete` and `compareAndExpire`, which are the same
     * protocol differing only in the queued command — and both fence LEASE
     * ownership, so a divergence here would let one worker act on a lease another
     * already holds. A `null` exec means the WATCH tripped (report `false`, someone
     * else won); a queued command's own error is thrown so it becomes a typed
     * failure rather than a silent `false`.
     */
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

    const compareAndDelete: RedisPort["compareAndDelete"] = (key, expectedValue) =>
      compareAndRun("COMPARE-AND-DELETE", key, expectedValue, (multi) => multi.del(key));

    const compareAndExpire: RedisPort["compareAndExpire"] = (key, expectedValue, expiresInSec) =>
      compareAndRun("COMPARE-AND-EXPIRE", key, expectedValue, (multi) => multi.expire(key, expiresInSec));

    const setIfValue: RedisPort["setIfValue"] = (guardKey, expectedValue, key, value, opts) =>
      watchGuarded(`SET-IF-VALUE ${guardKey} -> ${key}`, async () => {
        for (;;) {
          await client.watch(guardKey);
          if (await client.get(guardKey) !== expectedValue) {
            await client.unwatch();
            return ok(false);
          }
          const executed = await client.multi().set(key, value, "EX", opts.expiresInSec).exec();
          // The renewal transaction may touch the watched lease key without
          // changing its owner token. Re-read and retry instead of reporting a
          // false ownership loss on that benign WATCH conflict.
          if (executed === null) continue;
          const [commandError, written] = executed[0] ?? [];
          if (commandError !== null) throw commandError;
          return ok(written === "OK");
        }
      });

    const setNxIfPresent: RedisPort["setNxIfPresent"] = (guardKey, key, value, opts) =>
      watchGuarded(`SETNX-IF-PRESENT ${guardKey} -> ${key}`, async () => {
        // EXEC retries when a concurrent clear changes the watched pending
        // marker between verification and decision publication.
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
      });

    const redis: RedisPort = {
      get: async (key) => {
        try {
          return ok(await client.get(key));
        } catch (e) {
          return err(redisErr(`GET ${key}`, e));
        }
      },
      set: async (key, value, opts) => {
        try {
          const result = opts?.expiresInSec !== undefined
            ? await client.set(key, value, "EX", opts.expiresInSec)
            : await client.set(key, value);
          return ok(result);
        } catch (e) {
          return err(redisErr(`SET ${key}`, e));
        }
      },
      del: async (key, ...additionalKeys) => {
        const keys = [key, ...additionalKeys];
        try {
          return ok(await client.del(...keys));
        } catch (e) {
          return err(redisErr(`DEL ${keys.join(" ")}`, e));
        }
      },
      scan: async (pattern, cursor = "0") => {
        try {
          const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
          return ok({ cursor: nextCursor, keys });
        } catch (e) {
          return err(redisErr(`SCAN ${pattern}`, e));
        }
      },
      setNx: async (key, value, opts) => {
        try {
          if (opts?.expiresInSec !== undefined) {
            // Atomic acquire-with-TTL: the key can never exist without an expiry,
            // so a crash after acquisition still self-heals after the TTL.
            const result = await client.set(key, value, "EX", opts.expiresInSec, "NX");
            return ok(result === "OK");
          }
          const result = await client.setnx(key, value);
          return ok(result === 1);
        } catch (e) {
          return err(redisErr(`SETNX ${key}`, e));
        }
      },
      compareAndDelete,
      compareAndExpire,
      setIfValue,
      setNxIfPresent,
      sAdd: async (key, member) => {
        try {
          return ok(await client.sadd(key, member));
        } catch (e) {
          return err(redisErr(`SADD ${key}`, e));
        }
      },
      sRem: async (key, member) => {
        try {
          return ok(await client.srem(key, member));
        } catch (e) {
          return err(redisErr(`SREM ${key}`, e));
        }
      },
      sMembers: async (key) => {
        try {
          return ok(await client.smembers(key));
        } catch (e) {
          return err(redisErr(`SMEMBERS ${key}`, e));
        }
      },
    };

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
  await disconnect().catch((disconnectErr: unknown) => {
    console.error(JSON.stringify({
      level: "error",
      msg: "Failed to disconnect Redis during error cleanup",
      error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
      ts: new Date().toISOString(),
    }));
  });
};
