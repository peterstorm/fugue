import { describe, it, expect } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { RedisConnectivityPort, LogPort } from "../../ports.js";
import { startRedisProbe } from "../../lifecycle/redis-probe.js";

const noopLogger: LogPort = { info: () => {}, warn: () => {}, error: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pingErr = { kind: "redis-unavailable", operation: "ping" } as HostError;

describe("startRedisProbe", () => {
  it("invokes onDead while ping fails and onAlive once it recovers", async () => {
    let alive = false;
    const redis: RedisConnectivityPort = {
      ping: async () => (alive ? ok(undefined) : err(pingErr)),
    };
    let deadCount = 0;
    let aliveCount = 0;
    const handle = startRedisProbe(
      redis,
      5,
      { onDead: () => { deadCount++; }, onAlive: () => { aliveCount++; } },
      noopLogger,
    );

    await wait(40);
    expect(deadCount).toBeGreaterThan(0);
    expect(aliveCount).toBe(0);

    alive = true;
    await wait(40);
    expect(aliveCount).toBeGreaterThan(0);

    handle.stop();
  });

  it("stops ticking after stop()", async () => {
    const redis: RedisConnectivityPort = { ping: async () => err(pingErr) };
    let ticks = 0;
    const handle = startRedisProbe(redis, 5, { onDead: () => { ticks++; }, onAlive: () => {} }, noopLogger);
    await wait(30);
    handle.stop();
    const snapshot = ticks;
    await wait(30);
    expect(ticks).toBe(snapshot);
  });

  it("suppresses overlapping ticks while a ping is in flight (one PING at a time)", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const redis: RedisConnectivityPort = {
      ping: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await wait(30); // outlives the 5ms interval
        active--;
        return ok(undefined);
      },
    };
    const handle = startRedisProbe(redis, 5, { onAlive: () => {}, onDead: () => {} }, noopLogger);
    await wait(60);
    handle.stop();
    expect(calls).toBeGreaterThan(0);
    expect(maxActive).toBe(1); // the inFlight guard prevents concurrent pings
  });

  it("treats a thrown ping as a dead connection", async () => {
    const redis: RedisConnectivityPort = {
      ping: async () => { throw new Error("connection reset"); },
    };
    let dead = 0;
    const handle = startRedisProbe(redis, 5, { onDead: () => { dead++; }, onAlive: () => {} }, noopLogger);
    await wait(30);
    handle.stop();
    expect(dead).toBeGreaterThan(0);
  });
});
