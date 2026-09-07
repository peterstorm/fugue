/**
 * The supervisor's ioredis-backed port bundle — connectivity, data-plane
 * commands, pub/sub, privileged ACL admin, and the append-only audit stream,
 * built over ONE command connection plus ONE subscriber connection.
 *
 * WHY THIS IS AN ADAPTER AND NOT PART OF THE BINARY. It used to live inside
 * `main-supervisor.ts`, whose own header calls it a "Side-effecting; never
 * re-exported" composition root — and a composition root genuinely should not
 * be unit-tested. That is exactly the argument for this code not living there:
 * building five ports over a vendor SDK is adapter work, and it inherited the
 * entry point's untestability by accident of placement. The file's last
 * statement is `main().catch(...)`, so a test that imported it to reach this
 * function would boot the supervisor and call `process.exit`.
 *
 * What that cost was concrete: the two `attachRedisErrorListener` calls below
 * guard the process that owns the single inbound HTTP listener, the admin API,
 * admission, and every tenant's sweep timers, and this binary registers no
 * `uncaughtException` handler — yet a regression dropping either call, or
 * adding a third client without one, could not be caught by any test. Here,
 * with `createClient` injected, it can.
 *
 * Shape mirrors `createRedisConnectivity` in `redis-connectivity.ts`
 * deliberately: same injected `RedisClientFactory` seam, same shared
 * `defaultIoredisFactory` default, same `attachRedisErrorListener` helper — so
 * the package's two client-construction sites cannot drift apart.
 */

import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { LogPort, RedisConnectivityPort, RedisPort, RedisPubSubPort } from "../ports.js";
import type { RedisAclAdminPort } from "../supervisor/secrets/redis-acl-provisioner.js";
import type { AuditStreamPort } from "../supervisor/audit/audit-sink-log-redis.js";
import {
  attachRedisErrorListener,
  createIoredisRedisPort,
  defaultIoredisFactory,
} from "./redis-connectivity.js";
import type { RedisClientFactory } from "./redis-connectivity.js";
import {
  disconnectRedisClients,
  redisOperationFailure,
  redisUrlRedactions,
} from "../entrypoint-wiring.js";

/** Every Redis capability the supervisor binary wires, over two connections. */
export interface RedisBundle {
  readonly connectivity: RedisConnectivityPort;
  readonly redis: RedisPort;
  readonly pubsub: RedisPubSubPort;
  /**
   * Privileged ACL admin port over the supervisor's admin connection — used by
   * the grace-window purge to `ACL DELUSER` a deregistered tenant's scoped user
   * (the per-tenant user cannot revoke itself). Distinct from the data-plane
   * `RedisPort` because ACL ops are privileged.
   */
  readonly aclAdmin: RedisAclAdminPort;
  /** Append-only audit stream (`XADD`) over the supervisor's admin connection. */
  readonly auditStream: AuditStreamPort;
  readonly disconnect: () => Promise<void>;
}

/**
 * Build the supervisor's Redis bundle.
 *
 * @param redisUrl      the connection URL (may carry credentials — every error
 *   raised here is redacted through `redisUrlRedactions`).
 * @param logger        log port for connection-level `error` events.
 * @param createClient  OPTIONAL ioredis client factory (test seam). Defaults to
 *   the shared `defaultIoredisFactory`; a unit test injects a fake and can then
 *   assert the listener wiring, the constructor options, and the exact argv
 *   every port issues — without a live Redis.
 */
export const createRedisBundle = async (
  redisUrl: string,
  logger: LogPort,
  createClient?: RedisClientFactory,
): Promise<Result<RedisBundle, HostError>> => {
  try {
    const makeClient = createClient ?? (await defaultIoredisFactory());
    const clientOptions = { maxRetriesPerRequest: 3, lazyConnect: true } as const;
    const client = makeClient(redisUrl, clientOptions);
    const subClient = makeClient(redisUrl, clientOptions);
    // Both clients, before either can dial. `Redis` is an EventEmitter, so an
    // `error` event with no listener is THROWN — and this process supervises
    // every tenant worker on the host, with no `uncaughtException` handler of
    // its own, so an unlistened connection reset takes all of them down with
    // it. Same one-line defect as `createRedisConnectivity`'s, strictly wider
    // blast radius; closed through the same helper so the two cannot drift.
    attachRedisErrorListener(client, logger, { client: "command" });
    attachRedisErrorListener(subClient, logger, { client: "pubsub" });
    const redisRedactions = redisUrlRedactions(redisUrl);
    const redisFailure = (operation: string, error: unknown): HostError =>
      redisOperationFailure(operation, error, redisRedactions);

    const connectivity: RedisConnectivityPort = {
      ping: async () => {
        try {
          if (client.status === "wait") await client.connect();
          await client.ping();
          return ok(undefined);
        } catch (error) {
          return err(redisFailure("PING", error));
        }
      },
    };

    const redis = createIoredisRedisPort(client, redisFailure);

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

    const pubsub: RedisPubSubPort = {
      publish: (channel, message) =>
        redisCall(() => `PUBLISH ${channel}`, async () => { await client.publish(channel, message); }),
      subscribe: (channel, handler) =>
        redisCall(() => `SUBSCRIBE ${channel}`, async () => {
          if (subClient.status === "wait") await subClient.connect();
          subClient.on("message", (receivedChannel, message) => {
            if (receivedChannel === channel) handler(message);
          });
          await subClient.subscribe(channel);
          return { unsubscribe: async () => { await subClient.unsubscribe(channel); } };
        }),
    };

    // Both ACL ops differ only in their subcommand and trailing rules, so they
    // share one path: the connect guard, the argv shape, and the redacted
    // failure label cannot drift between "create the tenant's user" and "revoke
    // it" — and revocation is the one the grace-window purge depends on.
    const aclCommand = async (
      subcommand: "SETUSER" | "DELUSER",
      username: string,
      rules: readonly string[],
    ): Promise<Result<void, HostError>> => {
      try {
        if (client.status === "wait") await client.connect();
        await client.call("ACL", subcommand, username, ...rules);
        return ok(undefined);
      } catch (error) {
        return err(redisFailure(`ACL ${subcommand} ${username}`, error));
      }
    };

    const aclAdmin: RedisAclAdminPort = {
      setUser: (username, rules) => aclCommand("SETUSER", username, rules),
      delUser: (username) => aclCommand("DELUSER", username, []),
    };

    // No try/catch, and no `Result`, ON PURPOSE — `AuditStreamPort` documents a
    // plain-Promise contract because `createRedisStreamAuditSink` owns the
    // catch: it logs the failure through `logAuditFailureWithoutThrowing` (which
    // falls back to stderr) and lets the tenant op succeed. A catch here could
    // only swallow that log or rethrow it.
    const auditStream: AuditStreamPort = {
      xAdd: async (streamKey, fields) => {
        if (client.status === "wait") await client.connect();
        const args: string[] = [];
        for (const [k, v] of Object.entries(fields)) { args.push(k, v); }
        const id = await client.xadd(streamKey, "*", ...args);
        return String(id);
      },
    };

    return ok({
      connectivity,
      redis,
      pubsub,
      aclAdmin,
      auditStream,
      disconnect: () => disconnectRedisClients([
        { name: "command", quit: () => client.quit() },
        { name: "subscriber", quit: () => subClient.quit() },
      ]),
    });
  } catch (error) {
    return err(redisOperationFailure("Redis init", error, redisUrlRedactions(redisUrl)));
  }
};
