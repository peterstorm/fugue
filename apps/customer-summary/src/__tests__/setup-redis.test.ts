// setup-redis.test.ts — the `setUpRedis` bootstrap shell, driven through its
// seams (`RedisSeams`) with no live Redis: a client that connects without a
// server, and a collaborator factory a test can make throw.

import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { ok } from "@fuguejs/framework";
import type { Checkpointer } from "@fuguejs/framework";
import { setUpRedis, type RedisCollaborators, type RedisSeams } from "../bootstrap.js";
import type { AppLogger } from "../logger.js";

const CONFIG = { REDIS_URL: "redis://redis.test:6379" } as const;

const recordingLogger = () => {
  const warns: string[] = [];
  const errors: string[] = [];
  const log: AppLogger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => { warns.push(msg); },
    error: (msg) => { errors.push(msg); },
  };
  return { log, warns, errors };
};

/**
 * A client whose `connect` resolves without a server. It is the real event
 * surface `setUpRedis` listens on (an EventEmitter, as ioredis is), so a test
 * drives `ready` / `error` / `end` exactly as a live connection would.
 */
const connectingClient = (): { readonly client: Redis; readonly events: EventEmitter } => {
  const events = Object.assign(new EventEmitter(), { connect: async () => {} });
  return { client: events as unknown as Redis, events };
};

/** Opaque collaborators: `setUpRedis` only carries them, never calls them. */
const stubCollaborators = (): RedisCollaborators => ({
  contextCache: { get: async () => ({ hit: false }), set: async () => ok(undefined) },
  checkpointWriter: { write: async () => {} },
  checkpointer: {} as Checkpointer,
});

const seamsFor = (client: Redis, over: Partial<RedisSeams> = {}): RedisSeams => ({
  createClient: () => client,
  buildCollaborators: stubCollaborators,
  ...over,
});

describe("setUpRedis", () => {
  test("a collaborator construction failure after a successful connect is `unavailable`, keeping the client for shutdown", async () => {
    const { client } = connectingClient();
    const { log, warns } = recordingLogger();
    const setup = await setUpRedis(CONFIG, log, seamsFor(client, {
      buildCollaborators: () => { throw new Error("checkpointer construction failed"); },
    }));

    expect(setup.kind).toBe("unavailable");
    expect(setup.redis).toBe(client); // retained, not null: shutdown must still disconnect it
    expect(Object.keys(setup).sort()).toEqual(["kind", "redis"]); // no half-wired collaborators
    expect(warns.some((w) => w.includes("Redis connection failed"))).toBe(true);
  });

  test("a connected setup's health follows the client's error / end / ready events", async () => {
    const { client, events } = connectingClient();
    const { log, errors } = recordingLogger();
    const setup = await setUpRedis(CONFIG, log, seamsFor(client));
    if (setup.kind !== "connected") throw new Error(`expected connected, got ${setup.kind}`);

    expect(setup.redis).toBe(client);
    expect(setup.isHealthy()).toBe(true); // healthy once connected

    events.emit("error", new Error("ECONNRESET"));
    expect(setup.isHealthy()).toBe(false);
    expect(errors.some((e) => e.includes("ECONNRESET"))).toBe(true);

    events.emit("ready");
    expect(setup.isHealthy()).toBe(true);

    events.emit("end");
    expect(setup.isHealthy()).toBe(false);

    events.emit("ready");
    expect(setup.isHealthy()).toBe(true);
  });

  test("the client is constructed from the configured REDIS_URL", async () => {
    const { client } = connectingClient();
    const urls: string[] = [];
    await setUpRedis(CONFIG, recordingLogger().log, seamsFor(client, {
      createClient: (url) => { urls.push(url); return client; },
    }));
    expect(urls).toEqual([CONFIG.REDIS_URL]);
  });
});
