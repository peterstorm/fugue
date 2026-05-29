/**
 * Redis liveness probe — periodic PING that drives the host's
 * redis-disconnected degraded state.
 *
 * Startup validates Redis once (FR-006). After boot, this probe is what keeps the
 * lifecycle state honest about Redis connectivity: a failed PING degrades the host
 * (redisDied), a subsequent successful PING recovers it (redisRecovered). Without it
 * the `degraded:redis-disconnected` state would be unreachable at runtime.
 *
 * The timer is `unref`'d so the probe never keeps the process alive on its own,
 * and overlapping ticks are suppressed (one in-flight PING at a time).
 *
 * @satisfies NFR-012 — Redis loss degrades, it does not crash; recovers automatically.
 */

import type { RedisConnectivityPort, LogPort } from "../ports.js";

/**
 * Callbacks invoked with the result of each probe tick. Implementations are
 * expected to be idempotent — `onAlive`/`onDead` fire on every tick, not just on
 * edges, so the host applies the matching state transition only when valid.
 */
export interface RedisProbeCallbacks {
  /** A PING succeeded. */
  readonly onAlive: () => void;
  /** A PING failed (Result.err or thrown). */
  readonly onDead: () => void;
}

/** Handle for stopping the probe during shutdown. */
export interface RedisProbeHandle {
  readonly stop: () => void;
}

/**
 * Start the Redis liveness probe. Returns a handle whose `stop()` is idempotent
 * and halts further ticks immediately (in-flight ticks are discarded).
 */
export const startRedisProbe = (
  redis: RedisConnectivityPort,
  intervalMs: number,
  callbacks: RedisProbeCallbacks,
  logger: LogPort,
): RedisProbeHandle => {
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await redis.ping();
      if (stopped) return;
      if (result.ok) {
        callbacks.onAlive();
      } else {
        logger.warn("Redis liveness probe failed", { error: result.error.kind });
        callbacks.onDead();
      }
    } catch (e) {
      // ping() is contractually Result-returning; a throw is unexpected but must
      // still be treated as a dead connection rather than swallowed.
      if (!stopped) {
        logger.warn("Redis liveness probe threw unexpectedly — treating as disconnected", {
          error: e instanceof Error ? e.message : String(e),
        });
        callbacks.onDead();
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't let the probe alone keep the runtime alive.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
