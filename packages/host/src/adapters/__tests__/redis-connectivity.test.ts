/**
 * Unit tests for the SHARED ioredis connectivity adapter (`adapters/redis-connectivity.ts`).
 *
 * The adapter dials a real Redis, so its behavioral invariants were previously
 * pinned ONLY by the `REDIS_URL`-gated integration suites (which CI may skip).
 * These tests inject a FAKE client through the `RedisClientFactory` seam — no live
 * server, runs everywhere — and lock the three subtle, comment-documented invariants
 * that now live in this one place:
 *   - the `status === "wait"` connect guard (connect ONCE, never flap afterwards),
 *   - the per-tenant ACL credential OVERRIDE (username/password reach the client),
 *   - the ATOMIC `SET … EX … NX` acquire for `setNx` with a TTL (vs bare `setnx`),
 * plus the typed-`Result` error wrapping every method does, and init failure.
 */

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  createRedisConnectivity,
  disconnectRedisQuietly,
  type RedisClientFactory,
} from "../redis-connectivity.js";
import {
  isOk,
  isErr,
  makeSpend,
  unpricedModels,
} from "@fuguejs/framework";
import type { RedisSpendAppend } from "../../ports.js";
import type { Redis as IoRedis } from "ioredis";
import { unpricedModelHashField } from "../../domain/spend-record.js";

// ── Controllable fake ioredis client ─────────────────────────────────────────
// Only the methods the adapter drives are implemented. Cast to the ioredis type
// at the factory seam (the adapter calls exactly these and nothing else).

interface FakeOverrides {
  readonly initialStatus?: string;
  readonly setResult?: unknown;
  readonly setnxResult?: unknown;
  readonly getResult?: string | null;
  readonly execNullOnce?: boolean;
  readonly execCommandError?: Error;
  readonly execCommandErrorAt?: number;
  readonly throwOn?: readonly string[];
  readonly thrownValue?: unknown;
}

class FakeRedis {
  status: string;
  connectCalls = 0;
  readonly calls: Array<{ readonly m: string; readonly args: readonly unknown[] }> = [];
  private readonly throwOn: Set<string>;
  private readonly o: FakeOverrides;
  private readonly values = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private execNullRemaining: number;

  constructor(o: FakeOverrides = {}) {
    this.status = o.initialStatus ?? "wait";
    this.throwOn = new Set(o.throwOn ?? []);
    this.o = o;
    this.execNullRemaining = o.execNullOnce ? 1 : 0;
  }

  private rec(m: string, args: readonly unknown[]): void {
    this.calls.push({ m, args });
    if (this.throwOn.has(m)) {
      throw "thrownValue" in this.o ? this.o.thrownValue : new Error(`${m} boom`);
    }
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.throwOn.has("connect")) throw new Error("connect boom");
    this.status = "ready";
  }
  async ping(): Promise<string> {
    this.rec("ping", []);
    return "PONG";
  }
  seed(key: string, value: string): void { this.values.set(key, value); }
  seedHash(key: string, values: Readonly<Record<string, string>>): void {
    this.hashes.set(key, new Map(Object.entries(values)));
  }
  async get(key: string): Promise<string | null> {
    this.rec("get", [key]);
    return "getResult" in this.o ? this.o.getResult ?? null : this.values.get(key) ?? null;
  }
  async set(...args: unknown[]): Promise<unknown> {
    this.rec("set", args);
    // `null` is a MEANINGFUL SET-NX result (key already exists), so distinguish
    // "no override" from "override is null" — `??` would coalesce null to "OK".
    return "setResult" in this.o ? this.o.setResult : "OK";
  }
  async setnx(...args: unknown[]): Promise<unknown> {
    this.rec("setnx", args);
    return "setnxResult" in this.o ? this.o.setnxResult : 1;
  }
  async watch(...keys: string[]): Promise<string> {
    this.rec("watch", keys);
    return "OK";
  }
  async unwatch(): Promise<string> {
    this.rec("unwatch", []);
    return "OK";
  }
  multi() {
    this.rec("multi", []);
    const operations: Array<
      | { readonly kind: "delete"; readonly key: string }
      | { readonly kind: "expire"; readonly key: string }
      | { readonly kind: "hash-increment" }
      | { readonly kind: "hash-set"; readonly key: string; readonly field: string; readonly value: string }
      | { readonly kind: "set"; readonly key: string; readonly value: string; readonly onlyIfAbsent: boolean }
    > = [];
    const chain = {
      del: (key: string) => {
        this.rec("multi.del", [key]);
        operations.push({ kind: "delete", key });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        this.rec("multi.expire", [key, seconds]);
        operations.push({ kind: "expire", key });
        return chain;
      },
      hset: (key: string, field: string, value: string | number) => {
        this.rec("multi.hset", [key, field, value]);
        operations.push({ kind: "hash-set", key, field, value: String(value) });
        return chain;
      },
      hincrby: (key: string, field: string, by: number) => {
        this.rec("multi.hincrby", [key, field, by]);
        operations.push({ kind: "hash-increment" });
        return chain;
      },
      set: (key: string, value: string, ...args: unknown[]) => {
        this.rec("multi.set", [key, value, ...args]);
        operations.push({ kind: "set", key, value, onlyIfAbsent: args.includes("NX") });
        return chain;
      },
      exec: async () => {
        this.rec("multi.exec", []);
        if (this.execNullRemaining > 0) {
          this.execNullRemaining -= 1;
          return null;
        }
        return operations.map((operation, index): [Error | null, unknown] => {
          if (
            this.o.execCommandError !== undefined &&
            index === (this.o.execCommandErrorAt ?? 0)
          ) {
            return [this.o.execCommandError, null];
          }
          if (operation.kind === "delete") {
            return [null, this.values.delete(operation.key) ? 1 : 0];
          }
          if (operation.kind === "expire") {
            return [null, this.values.has(operation.key) ? 1 : 0];
          }
          if (operation.kind === "hash-set") {
            const hash = this.hashes.get(operation.key) ?? new Map<string, string>();
            hash.set(operation.field, operation.value);
            this.hashes.set(operation.key, hash);
            return [null, 1];
          }
          if (operation.kind === "hash-increment") return [null, 7];
          if (operation.onlyIfAbsent && this.values.has(operation.key)) {
            return [null, null];
          }
          this.values.set(operation.key, operation.value);
          return [null, "OK"];
        });
      },
    };
    return chain;
  }
  async del(...keys: string[]): Promise<number> {
    this.rec("del", keys);
    return keys.length;
  }
  async scan(...args: unknown[]): Promise<[string, string[]]> {
    this.rec("scan", args);
    return ["0", ["k1"]];
  }
  async sadd(...args: unknown[]): Promise<number> {
    this.rec("sadd", args);
    return 1;
  }
  async srem(...args: unknown[]): Promise<number> {
    this.rec("srem", args);
    return 1;
  }
  async smembers(key: string): Promise<string[]> {
    this.rec("smembers", [key]);
    return ["a", "b"];
  }
  async hget(key: string, field: string): Promise<string | null> {
    this.rec("hget", [key, field]);
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    this.rec("hgetall", [key]);
    const hash = this.hashes.get(key);
    return hash === undefined ? { tokens: "10", micros: "5" } : Object.fromEntries(hash);
  }
  async quit(): Promise<string> {
    this.rec("quit", []);
    return "OK";
  }
}

/** A factory over a given fake that ALSO records the options the adapter passes. */
const factoryFor = (
  fake: FakeRedis,
): { readonly factory: RedisClientFactory; opts: () => Record<string, unknown> } => {
  let captured: Record<string, unknown> = {};
  return {
    factory: (_url, options) => {
      captured = options as unknown as Record<string, unknown>;
      return fake as unknown as IoRedis;
    },
    opts: () => captured,
  };
};

const wire = async (fake: FakeRedis, acl?: { username: string; password: string }) => {
  const { factory, opts } = factoryFor(fake);
  const r = await createRedisConnectivity("redis://localhost:6379", acl, factory);
  if (!isOk(r)) throw new Error("expected createRedisConnectivity to succeed");
  return { bundle: r.value, opts };
};

// ── status === "wait" connect guard ──────────────────────────────────────────

describe("createRedisConnectivity — startup ping connect guard", () => {
  it("connects exactly ONCE: the first ping dials a 'wait' client, later pings do NOT reconnect", async () => {
    const fake = new FakeRedis({ initialStatus: "wait" });
    const { bundle } = await wire(fake);

    const first = await bundle.port.ping();
    expect(isOk(first)).toBe(true);
    expect(fake.connectCalls).toBe(1);
    expect(fake.status).toBe("ready"); // connect flipped it

    // Subsequent probes: ioredis owns reconnection once connected. Calling
    // connect() again would reject and flap the host to degraded — so the guard
    // must NOT call it.
    await bundle.port.ping();
    await bundle.port.ping();
    expect(fake.connectCalls).toBe(1);
    expect(fake.calls.filter((c) => c.m === "ping").length).toBe(3);
  });

  it("does NOT call connect when the client is already past 'wait'", async () => {
    const fake = new FakeRedis({ initialStatus: "ready" });
    const { bundle } = await wire(fake);
    await bundle.port.ping();
    expect(fake.connectCalls).toBe(0);
  });

  it("a failing ping yields Err(redis-unavailable) naming the PING operation", async () => {
    const fake = new FakeRedis({ initialStatus: "ready", throwOn: ["ping"] });
    const { bundle } = await wire(fake);
    const r = await bundle.port.ping();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("redis-unavailable");
      if (r.error.kind === "redis-unavailable") expect(r.error.operation).toMatch(/PING/i);
    }
  });
});

// ── ACL credential override ──────────────────────────────────────────────────

describe("createRedisConnectivity — per-tenant ACL credential override", () => {
  it("passes username/password to the client when an ACL credential is supplied", async () => {
    const fake = new FakeRedis();
    const { opts } = await wire(fake, { username: "fugue-tenant-acme", password: "s3cret" });
    expect(opts().username).toBe("fugue-tenant-acme");
    expect(opts().password).toBe("s3cret");
    expect(opts().lazyConnect).toBe(true);
    expect(opts().autoResendUnfulfilledCommands).toBe(false);
  });

  it("passes NO username/password when no ACL credential is supplied (inherit REDIS_URL auth)", async () => {
    const fake = new FakeRedis();
    const { opts } = await wire(fake);
    expect("username" in opts()).toBe(false);
    expect("password" in opts()).toBe(false);
  });
});

// ── Atomic setNx-with-TTL ─────────────────────────────────────────────────────

describe("createRedisConnectivity — setNx atomicity", () => {
  it("with a TTL uses an ATOMIC SET … EX … NX (never a bare setnx + separate expire)", async () => {
    const fake = new FakeRedis({ setResult: "OK" });
    const { bundle } = await wire(fake);
    const r = await bundle.redis.setNx("fugue:acme:lock", "1", { expiresInSec: 30 });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(true);
    const setCall = fake.calls.find((c) => c.m === "set");
    expect(setCall?.args).toEqual(["fugue:acme:lock", "1", "EX", 30, "NX"]);
    expect(fake.calls.some((c) => c.m === "setnx")).toBe(false);
  });

  it("with a TTL returns Ok(false) when the key already exists (SET NX returns null)", async () => {
    const fake = new FakeRedis({ setResult: null });
    const { bundle } = await wire(fake);
    const r = await bundle.redis.setNx("k", "v", { expiresInSec: 10 });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(false);
  });

  it("without a TTL uses bare setnx (1 → acquired, 0 → not)", async () => {
    const acquired = new FakeRedis({ setnxResult: 1 });
    const ra = await (await wire(acquired)).bundle.redis.setNx("k", "v");
    expect(isOk(ra) && ra.value).toBe(true);

    const taken = new FakeRedis({ setnxResult: 0 });
    const rt = await (await wire(taken)).bundle.redis.setNx("k", "v");
    expect(isOk(rt) && rt.value).toBe(false);
  });
});

// ── set with TTL + error wrapping + teardown ─────────────────────────────────

describe("createRedisConnectivity — data port", () => {
  it("set with expiresInSec issues SET … EX", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);
    await bundle.redis.set("k", "v", { expiresInSec: 60 });
    const setCall = fake.calls.find((c) => c.m === "set");
    expect(setCall?.args).toEqual(["k", "v", "EX", 60]);
  });

  it("del submits every key in one Redis command", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);

    const result = await bundle.redis.del("pending", "decision");

    expect(isOk(result) && result.value).toBe(2);
    expect(fake.calls.find((call) => call.m === "del")?.args).toEqual(["pending", "decision"]);
  });

  it("get returns the value on success and Err(redis-unavailable) on a thrown client error", async () => {
    const okFake = new FakeRedis({ getResult: "hello" });
    const okR = await (await wire(okFake)).bundle.redis.get("k");
    expect(isOk(okR) && okR.value).toBe("hello");

    const errFake = new FakeRedis({ throwOn: ["get"] });
    const errR = await (await wire(errFake)).bundle.redis.get("k");
    expect(isErr(errR)).toBe(true);
    if (isErr(errR) && errR.error.kind === "redis-unavailable") {
      expect(errR.error.operation).toMatch(/GET k/);
    }
  });

  it("compareAndDelete uses WATCH/MULTI/EXEC and deletes only the matching owner", async () => {
    const matching = new FakeRedis();
    matching.seed("lease", "owner-a");
    const deleted = await (await wire(matching)).bundle.redis.compareAndDelete("lease", "owner-a");
    expect(isOk(deleted) && deleted.value).toBe(true);
    expect(matching.calls.map((c) => c.m)).toEqual(["watch", "get", "multi", "multi.del", "multi.exec"]);

    const successor = new FakeRedis();
    successor.seed("lease", "owner-b");
    const preserved = await (await wire(successor)).bundle.redis.compareAndDelete("lease", "owner-a");
    expect(isOk(preserved) && preserved.value).toBe(false);
    expect(successor.calls.map((c) => c.m)).toEqual(["watch", "get", "unwatch"]);
    expect(await successor.get("lease")).toBe("owner-b");
  });

  it("returns a WATCH conflict as Ok(false)", async () => {
    const conflicted = new FakeRedis({ execNullOnce: true });
    conflicted.seed("lease", "owner-a");

    const result = await (await wire(conflicted)).bundle.redis.compareAndDelete("lease", "owner-a");

    expect(isOk(result) && result.value).toBe(false);
    expect(conflicted.calls.map((call) => call.m)).toEqual([
      "watch", "get", "multi", "multi.del", "multi.exec",
    ]);
  });

  it("converts queued command errors to Err and clears the connection watch", async () => {
    const fake = new FakeRedis({ execCommandError: new Error("queued command failed") });
    fake.seed("lease", "owner-a");

    const result = await (await wire(fake)).bundle.redis.compareAndDelete("lease", "owner-a");

    expect(isErr(result)).toBe(true);
    expect(fake.calls.map((call) => call.m)).toEqual([
      "watch", "get", "multi", "multi.del", "multi.exec", "unwatch",
    ]);
  });

  it("surfaces primary + UNWATCH cleanup failures and poisons later WATCH transactions", async () => {
    const fake = new FakeRedis({ throwOn: ["get", "unwatch"] });
    const { bundle } = await wire(fake);

    const first = await bundle.redis.compareAndDelete("lease", "owner-a");
    const callsAfterFailure = [...fake.calls];
    const second = await bundle.redis.compareAndDelete("another-lease", "owner-b");

    expect(isErr(first)).toBe(true);
    if (isErr(first) && first.error.kind === "redis-unavailable") {
      expect(first.error.operation).toContain("primary failure: get boom");
      expect(first.error.operation).toContain("UNWATCH cleanup failure: unwatch boom");
      expect(first.error.operation).toContain("optimistic transactions disabled");
    }
    expect(second).toEqual(first);
    expect(fake.calls).toEqual(callsAfterFailure);
    expect(fake.calls.map((call) => call.m)).toEqual(["watch", "get", "unwatch"]);
  });

  it("serializes optimistic transactions on the shared command connection", async () => {
    const fake = new FakeRedis();
    fake.seed("lease-a", "owner-a");
    fake.seed("lease-b", "owner-b");
    let releaseFirstWatch!: () => void;
    const firstWatchBlocked = new Promise<void>((resolve) => { releaseFirstWatch = resolve; });
    const originalWatch = fake.watch.bind(fake);
    let first = true;
    fake.watch = async (key: string) => {
      const result = await originalWatch(key);
      if (first) {
        first = false;
        await firstWatchBlocked;
      }
      return result;
    };
    const { bundle } = await wire(fake);

    const firstResult = bundle.redis.compareAndDelete("lease-a", "owner-a");
    const secondResult = bundle.redis.compareAndDelete("lease-b", "owner-b");
    await Bun.sleep(0);
    expect(fake.calls.filter((call) => call.m === "watch")).toHaveLength(1);

    releaseFirstWatch();
    const results = await Promise.all([firstResult, secondResult]);
    expect(results.every((result) => isOk(result) && result.value)).toBe(true);
    expect(fake.calls.filter((call) => call.m === "watch")).toHaveLength(2);
  });

  it("setIfValue atomically fences a target write with the matching owner token", async () => {
    const matching = new FakeRedis();
    matching.seed("lease", "owner-a");
    const written = await (await wire(matching)).bundle.redis.setIfValue?.(
      "lease", "owner-a", "checkpoint", "next", { expiresInSec: 60 },
    );
    expect(written && isOk(written) && written.value).toBe(true);
    expect(await matching.get("checkpoint")).toBe("next");
    expect(matching.calls.some((c) => c.m === "multi.set")).toBe(true);

    const renewedDuringWrite = new FakeRedis({ execNullOnce: true });
    renewedDuringWrite.seed("lease", "owner-a");
    const retried = await (await wire(renewedDuringWrite)).bundle.redis.setIfValue?.(
      "lease", "owner-a", "checkpoint", "after-renewal", { expiresInSec: 60 },
    );
    expect(retried && isOk(retried) && retried.value).toBe(true);
    expect(renewedDuringWrite.calls.filter((c) => c.m === "multi.exec")).toHaveLength(2);

    const successor = new FakeRedis();
    successor.seed("lease", "owner-b");
    const rejected = await (await wire(successor)).bundle.redis.setIfValue?.(
      "lease", "owner-a", "checkpoint", "stale", { expiresInSec: 60 },
    );
    expect(rejected && isOk(rejected) && rejected.value).toBe(false);
    expect(await successor.get("checkpoint")).toBeNull();
    expect(successor.calls.some((c) => c.m === "multi.set")).toBe(false);
  });

  it("setIfValues requires every guard and supports millisecond execution-fence expiry", async () => {
    const matching = new FakeRedis();
    matching.seed("lease", "owner-a");
    matching.seed("execution", "generation-1");
    const written = await (await wire(matching)).bundle.redis.setIfValues?.(
      [
        { key: "lease", expectedValue: "owner-a" },
        { key: "execution", expectedValue: "generation-1" },
      ],
      "checkpoint",
      "next",
      { expiresInMs: 5 },
    );

    expect(written && isOk(written) && written.value).toBe(true);
    expect(matching.calls.find((call) => call.m === "watch")?.args).toEqual(["lease", "execution"]);
    expect(matching.calls.find((call) => call.m === "multi.set")?.args).toEqual([
      "checkpoint", "next", "PX", 5,
    ]);

    const expired = new FakeRedis();
    expired.seed("lease", "owner-a");
    const rejected = await (await wire(expired)).bundle.redis.setIfValues?.(
      [
        { key: "lease", expectedValue: "owner-a" },
        { key: "execution", expectedValue: "generation-1" },
      ],
      "checkpoint",
      "late",
      { expiresInSec: 60 },
    );
    expect(rejected && isOk(rejected) && rejected.value).toBe(false);
    expect(expired.calls.some((call) => call.m === "multi")).toBe(false);
  });

  it("setNxIfPresent distinguishes missing guards, creation, existing targets, and WATCH retries", async () => {
    const missing = new FakeRedis();
    const missingResult = await (await wire(missing)).bundle.redis.setNxIfPresent?.(
      "pending", "decision", "approve", { expiresInSec: 60 },
    );
    expect(missingResult && isOk(missingResult) && missingResult.value).toBe("not-present");
    expect(missing.calls.map((call) => call.m)).toEqual(["watch", "get", "unwatch"]);

    const created = new FakeRedis();
    created.seed("pending", "marker");
    const createdResult = await (await wire(created)).bundle.redis.setNxIfPresent?.(
      "pending", "decision", "approve", { expiresInSec: 60 },
    );
    expect(createdResult && isOk(createdResult) && createdResult.value).toBe("created");
    expect(await created.get("decision")).toBe("approve");
    expect(created.calls.find((call) => call.m === "multi.set")?.args).toEqual([
      "decision", "approve", "EX", 60, "NX",
    ]);

    const existing = new FakeRedis();
    existing.seed("pending", "marker");
    existing.seed("decision", "reject");
    const existingResult = await (await wire(existing)).bundle.redis.setNxIfPresent?.(
      "pending", "decision", "approve", { expiresInSec: 60 },
    );
    expect(existingResult && isOk(existingResult) && existingResult.value).toBe("exists");
    expect(await existing.get("decision")).toBe("reject");

    const conflicted = new FakeRedis({ execNullOnce: true });
    conflicted.seed("pending", "marker");
    const retried = await (await wire(conflicted)).bundle.redis.setNxIfPresent?.(
      "pending", "decision", "approve", { expiresInSec: 60 },
    );
    expect(retried && isOk(retried) && retried.value).toBe("created");
    expect(conflicted.calls.filter((call) => call.m === "multi.exec")).toHaveLength(2);
  });

  it("a revoked proxy thrown by the client stays inside redisErr's typed boundary", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const fake = new FakeRedis({ throwOn: ["get"], thrownValue: revoked.proxy });

    const result = await (await wire(fake)).bundle.redis.get("hostile-key");

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === "redis-unavailable") {
      expect(result.error.operation).toContain("GET hostile-key");
      expect(typeof result.error.operation).toBe("string");
    }
  });

  it("a throwing message accessor cannot escape redisErr", async () => {
    const hostile = Object.defineProperty({}, "message", {
      get: () => { throw new Error("message accessor failed"); },
    });
    const fake = new FakeRedis({ throwOn: ["ping"], thrownValue: hostile, initialStatus: "ready" });

    const result = await (await wire(fake)).bundle.port.ping();

    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === "redis-unavailable") {
      expect(result.error.operation).toContain("PING at startup");
      expect(typeof result.error.operation).toBe("string");
    }
  });

  it("sMembers wraps a thrown error as Err(redis-unavailable)", async () => {
    const fake = new FakeRedis({ throwOn: ["smembers"] });
    const r = await (await wire(fake)).bundle.redis.sMembers("k");
    expect(isErr(r)).toBe(true);
  });

  it("disconnect quits the client", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);
    await bundle.disconnect();
    expect(fake.calls.some((c) => c.m === "quit")).toBe(true);
  });

  it("quiet disconnect contains hostile cleanup failures and fallback logger throws", async () => {
    const originalConsoleError = console.error;
    console.error = () => { throw new Error("console unavailable"); };
    try {
      await expect(disconnectRedisQuietly((() => {
        throw Object.create(null);
      }) as () => Promise<void>)).resolves.toBeUndefined();
    } finally {
      console.error = originalConsoleError;
    }
  });
});

// ── Client construction failure ───────────────────────────────────────────────

describe("createRedisConnectivity — initialization failure", () => {
  it("a throwing client factory yields Err(redis-unavailable) naming initialization", async () => {
    const factory: RedisClientFactory = () => {
      throw new Error("cannot construct");
    };
    const r = await createRedisConnectivity("redis://localhost:6379", undefined, factory);
    expect(isErr(r)).toBe(true);
    if (isErr(r) && r.error.kind === "redis-unavailable") {
      expect(r.error.operation).toMatch(/initialization/i);
    }
  });
});

describe("createRedisConnectivity — spend-ledger capability", () => {
  const completeAppend: RedisSpendAppend = {
    key: "run:spend",
    delta: makeSpend({
      usage: "known",
      tokens: 10,
      calls: 1,
      usd: {
        kind: "unpriced",
        models: unpricedModels(["model-a", "model-z"])!,
        knownMicros: 7 as never,
      },
    }),
    ttlSec: 900,
  };

  it("hGetAll issues HGETALL and returns every field", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);
    const result = await bundle.redis.hGetAll?.("run:spend");
    expect(result !== undefined && isOk(result) && result.value).toEqual({ tokens: "10", micros: "5" });
    expect(fake.calls.find((call) => call.m === "hgetall")?.args).toEqual(["run:spend"]);
  });

  it("wraps a thrown hGetAll as Err(redis-unavailable)", async () => {
    const { bundle } = await wire(new FakeRedis({ throwOn: ["hgetall"] }));
    const result = await bundle.redis.hGetAll?.("k");
    expect(result !== undefined && isErr(result)).toBe(true);
  });

  it("atomically writes a checkpoint and refreshes spend retention", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);

    const result = await bundle.redis.commitCheckpointAndRetainSpend?.({
      checkpointKey: "run:node",
      checkpointValue: "checkpoint",
      spendKey: "run:spend",
      checkpointTtlSec: 300,
      spendTtlSec: 900,
    });

    expect(result !== undefined && isOk(result)).toBe(true);
    expect(fake.calls).toEqual([
      { m: "multi", args: [] },
      { m: "multi.set", args: ["run:node", "checkpoint", "EX", 300] },
      { m: "multi.expire", args: ["run:spend", 900] },
      { m: "multi.exec", args: [] },
    ]);
  });

  it("fails the atomic checkpoint when spend retention reports a command error", async () => {
    const fake = new FakeRedis({
      execCommandError: new Error("spend retention failed"),
      execCommandErrorAt: 1,
    });
    const { bundle } = await wire(fake);

    const result = await bundle.redis.commitCheckpointAndRetainSpend?.({
      checkpointKey: "run:node",
      checkpointValue: "checkpoint",
      spendKey: "run:spend",
      checkpointTtlSec: 300,
      spendTtlSec: 900,
    });

    expect(result !== undefined && isErr(result)).toBe(true);
  });

  it("atomically reads, saturates, and writes markers -> micros -> tokens -> calls -> expiry", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);

    const result = await bundle.redis.appendSpend?.(completeAppend);

    expect(result !== undefined && isOk(result)).toBe(true);
    expect(fake.calls).toEqual([
      { m: "watch", args: ["run:spend"] },
      { m: "hget", args: ["run:spend", "micros"] },
      { m: "hget", args: ["run:spend", "tokens"] },
      { m: "hget", args: ["run:spend", "calls"] },
      { m: "multi", args: [] },
      { m: "multi.hset", args: ["run:spend", unpricedModelHashField("model-a"), "1"] },
      { m: "multi.hset", args: ["run:spend", unpricedModelHashField("model-z"), "1"] },
      { m: "multi.hset", args: ["run:spend", "micros", 7] },
      { m: "multi.hset", args: ["run:spend", "tokens", 10] },
      { m: "multi.hset", args: ["run:spend", "calls", 1] },
      { m: "multi.expire", args: ["run:spend", 900] },
      { m: "multi.exec", args: [] },
    ]);
    expect(fake.calls.some((call) => ["hset", "hincrby", "expire"].includes(call.m))).toBe(false);
    expect(fake.calls.some((call) => call.m.toLowerCase().includes("eval"))).toBe(false);
  });

  it("omits zero numeric writes and expiry while retaining one optimistic transaction", async () => {
    const fake = new FakeRedis();
    const { bundle } = await wire(fake);

    const result = await bundle.redis.appendSpend?.({
      key: "run:spend",
      delta: makeSpend({
        usage: "known",
        tokens: 0,
        calls: 1,
        usd: { kind: "priced", micros: 0 as never },
      }),
    });

    expect(result !== undefined && isOk(result)).toBe(true);
    expect(fake.calls).toEqual([
      { m: "watch", args: ["run:spend"] },
      { m: "hget", args: ["run:spend", "micros"] },
      { m: "hget", args: ["run:spend", "tokens"] },
      { m: "hget", args: ["run:spend", "calls"] },
      { m: "multi", args: [] },
      { m: "multi.hset", args: ["run:spend", "calls", 1] },
      { m: "multi.exec", args: [] },
    ]);
  });

  it("saturates every cumulative axis at the safe-integer ceiling", async () => {
    const fake = new FakeRedis();
    const almostMax = String(Number.MAX_SAFE_INTEGER - 5);
    fake.seedHash("run:spend", {
      micros: almostMax,
      tokens: almostMax,
      calls: almostMax,
    });
    const { bundle } = await wire(fake);

    const result = await bundle.redis.appendSpend?.({
      key: "run:spend",
      delta: makeSpend({
        usage: "known",
        tokens: 10,
        calls: 10,
        usd: { kind: "priced", micros: 10 as never },
      }),
    });

    expect(result !== undefined && isOk(result)).toBe(true);
    expect(await fake.hgetall("run:spend")).toEqual({
      micros: String(Number.MAX_SAFE_INTEGER),
      tokens: String(Number.MAX_SAFE_INTEGER),
      calls: String(Number.MAX_SAFE_INTEGER),
    });
    expect(fake.calls.filter((call) => call.m === "multi.hset").map((call) => call.args))
      .toEqual([
        ["run:spend", "micros", Number.MAX_SAFE_INTEGER],
        ["run:spend", "tokens", Number.MAX_SAFE_INTEGER],
        ["run:spend", "calls", Number.MAX_SAFE_INTEGER],
      ]);
  });

  it("inspects every EXEC result and returns a typed failure from the final EXPIRE", async () => {
    const fake = new FakeRedis({
      execCommandError: new Error("second EXPIRE failed"),
      execCommandErrorAt: 5,
    });
    const { bundle } = await wire(fake);

    const result = await bundle.redis.appendSpend?.(completeAppend);

    expect(result !== undefined && isErr(result)).toBe(true);
    if (result !== undefined && isErr(result) && result.error.kind === "redis-unavailable") {
      expect(result.error.operation).toContain("second EXPIRE failed");
    }
  });

  it("retries definite WATCH conflicts but returns typed failures for thrown acknowledgements", async () => {
    const conflicted = new FakeRedis({ execNullOnce: true });
    const retried = await (await wire(conflicted)).bundle.redis.appendSpend?.(completeAppend);
    expect(retried !== undefined && isOk(retried)).toBe(true);
    expect(conflicted.calls.filter((call) => call.m === "multi.exec")).toHaveLength(2);

    const thrown = await (await wire(new FakeRedis({ throwOn: ["multi.exec"] }))).bundle.redis
      .appendSpend?.(completeAppend);
    expect(thrown !== undefined && isErr(thrown)).toBe(true);
    if (thrown !== undefined && isErr(thrown) && thrown.error.kind === "redis-unavailable") {
      expect(thrown.error.operation).toContain("SPEND-APPEND");
    }
  });
});

const liveRedisUrl = process.env.REDIS_URL;

describe.skipIf(liveRedisUrl === undefined)(
  "createIoredisRedisPort — real Redis spend transactions",
  () => {
    let bundle: Extract<
      Awaited<ReturnType<typeof createRedisConnectivity>>,
      { readonly ok: true }
    >["value"];
    let observer: IoRedis;
    const prefix = `fugue:test:spend:${crypto.randomUUID()}`;

    beforeAll(async () => {
      if (liveRedisUrl === undefined) return;
      const connected = await createRedisConnectivity(liveRedisUrl);
      if (!connected.ok) throw new Error(`Redis test connection failed: ${connected.error.kind}`);
      bundle = connected.value;
      const { Redis } = await import("ioredis");
      observer = new Redis(liveRedisUrl);
    });

    afterAll(async () => {
      if (liveRedisUrl === undefined) return;
      await observer.del(`${prefix}:spend`, `${prefix}:saturated`, `${prefix}:checkpoint`);
      await observer.quit();
      await bundle.disconnect();
    });

    it("commits concurrent additive deltas, marker union, and one spend TTL", async () => {
      const key = `${prefix}:spend`;
      const append = bundle.redis.appendSpend;
      if (append === undefined) throw new Error("appendSpend is not wired");
      const models = unpricedModels(["model-a", "model-z"]);
      if (models === undefined) throw new Error("expected canonical models");
      const delta = makeSpend({
        usage: "unknown",
        tokens: 3,
        calls: 1,
        usd: { kind: "unpriced", models, knownMicros: 2 as never },
      });
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => append({ key, delta, ttlSec: 30 })),
      );
      expect(outcomes.every(isOk)).toBe(true);
      expect(await observer.hgetall(key)).toEqual({
        "$unpriced:006d006f00640065006c002d0061": "1",
        "$unpriced:006d006f00640065006c002d007a": "1",
        "$usage:unknown": "1",
        calls: "8",
        micros: "16",
        tokens: "24",
      });
      expect(await observer.ttl(key)).toBeGreaterThan(0);
    });

    it("keeps cumulative overflow readable by saturating all axes", async () => {
      const key = `${prefix}:saturated`;
      const append = bundle.redis.appendSpend;
      if (append === undefined) throw new Error("appendSpend is not wired");
      const amount = (value: number) => makeSpend({
        usage: "known",
        tokens: value,
        calls: value,
        usd: { kind: "priced", micros: value as never },
      });

      expect((await append({ key, delta: amount(Number.MAX_SAFE_INTEGER - 5) })).ok).toBe(true);
      expect((await append({ key, delta: amount(10) })).ok).toBe(true);
      expect(await observer.hgetall(key)).toEqual({
        calls: String(Number.MAX_SAFE_INTEGER),
        micros: String(Number.MAX_SAFE_INTEGER),
        tokens: String(Number.MAX_SAFE_INTEGER),
      });
    });

    it("atomically writes a checkpoint while retaining spend longer", async () => {
      const spendKey = `${prefix}:spend`;
      const checkpointKey = `${prefix}:checkpoint`;
      await observer.del(spendKey, checkpointKey);
      const append = bundle.redis.appendSpend;
      const commit = bundle.redis.commitCheckpointAndRetainSpend;
      if (append === undefined || commit === undefined) {
        throw new Error("checkpoint/spend operations are not wired");
      }
      const seeded = await append({
        key: spendKey,
        delta: makeSpend({
          usage: "known",
          tokens: 1,
          calls: 1,
          usd: { kind: "priced", micros: 1 as never },
        }),
        ttlSec: 5,
      });
      expect(seeded.ok).toBe(true);
      const result = await commit({
        checkpointKey,
        checkpointValue: "checkpoint",
        spendKey,
        checkpointTtlSec: 5,
        spendTtlSec: 30,
      });
      expect(result.ok).toBe(true);
      expect(await observer.get(checkpointKey)).toBe("checkpoint");
      const [checkpointTtl, spendTtl] = await Promise.all([
        observer.ttl(checkpointKey),
        observer.ttl(spendKey),
      ]);
      expect(checkpointTtl).toBeGreaterThan(0);
      expect(spendTtl).toBeGreaterThan(checkpointTtl);
    });
  },
);
