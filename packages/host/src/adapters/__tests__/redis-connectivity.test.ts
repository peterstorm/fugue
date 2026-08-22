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

import { describe, it, expect } from "bun:test";
import { createRedisConnectivity, type RedisClientFactory } from "../redis-connectivity.js";
import { isOk, isErr } from "@fuguejs/framework";
import type { Redis as IoRedis } from "ioredis";

// ── Controllable fake ioredis client ─────────────────────────────────────────
// Only the methods the adapter drives are implemented. Cast to the ioredis type
// at the factory seam (the adapter calls exactly these and nothing else).

interface FakeOverrides {
  readonly initialStatus?: string;
  readonly setResult?: unknown;
  readonly setnxResult?: unknown;
  readonly getResult?: string | null;
  readonly execNullOnce?: boolean;
  readonly throwOn?: readonly string[];
}

class FakeRedis {
  status: string;
  connectCalls = 0;
  readonly calls: Array<{ readonly m: string; readonly args: readonly unknown[] }> = [];
  private readonly throwOn: Set<string>;
  private readonly o: FakeOverrides;
  private readonly values = new Map<string, string>();
  private execNullRemaining: number;

  constructor(o: FakeOverrides = {}) {
    this.status = o.initialStatus ?? "wait";
    this.throwOn = new Set(o.throwOn ?? []);
    this.o = o;
    this.execNullRemaining = o.execNullOnce ? 1 : 0;
  }

  private rec(m: string, args: readonly unknown[]): void {
    this.calls.push({ m, args });
    if (this.throwOn.has(m)) throw new Error(`${m} boom`);
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
  async watch(key: string): Promise<string> {
    this.rec("watch", [key]);
    return "OK";
  }
  async unwatch(): Promise<string> {
    this.rec("unwatch", []);
    return "OK";
  }
  multi() {
    this.rec("multi", []);
    let operation:
      | { readonly kind: "delete"; readonly key: string }
      | { readonly kind: "expire"; readonly key: string }
      | { readonly kind: "set"; readonly key: string; readonly value: string }
      | undefined;
    const chain = {
      del: (key: string) => {
        this.rec("multi.del", [key]);
        operation = { kind: "delete", key };
        return chain;
      },
      expire: (key: string, seconds: number) => {
        this.rec("multi.expire", [key, seconds]);
        operation = { kind: "expire", key };
        return chain;
      },
      set: (key: string, value: string, ...args: unknown[]) => {
        this.rec("multi.set", [key, value, ...args]);
        operation = { kind: "set", key, value };
        return chain;
      },
      exec: async () => {
        this.rec("multi.exec", []);
        if (this.execNullRemaining > 0) {
          this.execNullRemaining -= 1;
          return null;
        }
        if (operation?.kind === "delete") {
          return [[null, this.values.delete(operation.key) ? 1 : 0]] as [Error | null, unknown][];
        }
        if (operation?.kind === "expire") {
          return [[null, this.values.has(operation.key) ? 1 : 0]] as [Error | null, unknown][];
        }
        if (operation?.kind === "set") {
          this.values.set(operation.key, operation.value);
          return [[null, "OK"]] as [Error | null, unknown][];
        }
        return [] as [Error | null, unknown][];
      },
    };
    return chain;
  }
  async del(key: string): Promise<number> {
    this.rec("del", [key]);
    return 1;
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
