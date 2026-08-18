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

import type { RedisConnectivityPort, RedisPort } from "../ports.js";
import type { HostError } from "../domain/host-error.js";
import { ok, err } from "@fuguejs/framework";
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
  operation: `${operation}: ${e instanceof Error ? e.message : String(e)}`,
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
      del: async (key) => {
        try {
          return ok(await client.del(key));
        } catch (e) {
          return err(redisErr(`DEL ${key}`, e));
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
