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

  it("an onAlive fault is not misclassified as a dead Redis connection", async () => {
    const redis: RedisConnectivityPort = { ping: async () => ok(undefined) };
    let dead = 0;
    let callbackWarnings = 0;
    const logger: LogPort = {
      info: () => {},
      error: () => {},
      warn: (message) => { if (message.includes("onAlive callback threw")) callbackWarnings++; },
    };
    const handle = startRedisProbe(redis, 5, {
      onAlive: () => { throw new Error("state transition failed"); },
      onDead: () => { dead++; },
    }, logger);

    await wait(30);
    handle.stop();

    expect(callbackWarnings).toBeGreaterThan(0);
    expect(dead).toBe(0);
  });

  it("a throwing logger cannot suppress the dead callback", async () => {
    const redis: RedisConnectivityPort = { ping: async () => err(pingErr) };
    let dead = 0;
    const logger: LogPort = {
      info: () => {},
      warn: () => { throw new Error("logger down"); },
      error: () => {},
    };
    const handle = startRedisProbe(redis, 5, {
      onAlive: () => {},
      onDead: () => { dead++; },
    }, logger);

    await wait(30);
    handle.stop();

    expect(dead).toBeGreaterThan(0);
  });

  it("an onDead fault is contained and later ticks continue", async () => {
    const redis: RedisConnectivityPort = { ping: async () => err(pingErr) };
    let deadCalls = 0;
    const handle = startRedisProbe(redis, 5, {
      onAlive: () => {},
      onDead: () => {
        deadCalls++;
        throw new Error("degrade transition failed");
      },
    }, noopLogger);

    await wait(30);
    handle.stop();

    expect(deadCalls).toBeGreaterThan(1);
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
