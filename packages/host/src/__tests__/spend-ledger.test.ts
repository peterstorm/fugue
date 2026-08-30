/**
 * The `SpendLedgerPort` contract, run against EVERY adapter.
 *
 * One suite, parameterised over the backends, because the whole point of the
 * port is that a run's spend means the same thing whichever one stored it. A
 * per-adapter suite would let them drift into disagreeing about the case that
 * matters most — what a resumed slice reads.
 *
 * The Redis adapter is exercised over an in-memory fake of the Redis
 * primitives, not a live server: what is under test is the ENCODING (three
 * sums and a set union) and the read-back, and a fake proves that with the
 * command semantics Redis guarantees.
 */

import { afterAll, describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runId as makeRunId, dagId as makeDagId, ok, err } from "@fuguejs/framework";
import type { MicroUsd, RunId, Spend } from "@fuguejs/framework";
import { NO_SPEND, addSpend, pricedCall, unpricedCall } from "@fuguejs/framework";
import type { RedisPort, SpendLedgerPort } from "../ports.js";
import { createInMemorySpendLedger } from "../adapters/spend-ledger-memory.js";
import { createRedisSpendLedger, spendLedgerRedis } from "../adapters/spend-ledger-redis.js";
import { createFileSpendLedger } from "../adapters/spend-ledger-file.js";
import { tenantId } from "../domain/tenant.js";

const micros = (n: number): MicroUsd => n as MicroUsd;
const runA = makeRunId("run-a");
const runB = makeRunId("run-b");

/**
 * A capturing logger, so the TTL-refresh warn path can be asserted rather than
 * assumed. `RedisSpendLedgerDeps.logger` is REQUIRED — the field exists so an
 * `EXPIRE` failure is never silently lost — and every construction below
 * supplies one. It was previously omitted at all four sites, which typechecked
 * only because this package excludes `src/__tests__` from `tsc`.
 */
const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const record = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    logs.push({ level, msg, ...(data !== undefined ? { data } : {}) });
  };
  return { logger: { info: record("info"), warn: record("warn"), error: record("error") }, logs };
};

const mkTenant = (raw: string) => {
  const parsed = tenantId(raw);
  if (!parsed.ok) throw new Error("bad tenant fixture");
  return parsed.value;
};

/**
 * A fake of exactly the Redis commands the ledger uses, with the semantics
 * Redis guarantees: `HINCRBY` creates-then-adds, `SADD` is a set union,
 * `HGETALL`/`SMEMBERS` read an absent key as empty.
 */
const fakeRedis = (): { redis: RedisPort; hashes: Map<string, Map<string, number>>; sets: Map<string, Set<string>>; expiries: Map<string, number> } => {
  const hashes = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const expiries = new Map<string, number>();
  const redis = {
    hIncrBy: async (key: string, field: string, by: number) => {
      const hash = hashes.get(key) ?? new Map<string, number>();
      const next = (hash.get(field) ?? 0) + by;
      hash.set(field, next);
      hashes.set(key, hash);
      return ok(next);
    },
    hGetAll: async (key: string) =>
      ok(Object.fromEntries([...(hashes.get(key) ?? new Map())].map(([f, v]) => [f, String(v)]))),
    expire: async (key: string, seconds: number) => {
      expiries.set(key, seconds);
      return ok(hashes.has(key) || sets.has(key));
    },
    sAdd: async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      const added = set.has(member) ? 0 : 1;
      set.add(member);
      sets.set(key, set);
      return ok(added);
    },
    sMembers: async (key: string) => ok([...(sets.get(key) ?? new Set<string>())]),
  } as unknown as RedisPort;
  return { redis, hashes, sets, expiries };
};

const redisLedger = (): SpendLedgerPort => {
  const parsed = spendLedgerRedis(fakeRedis().redis);
  if (!parsed.ok) throw new Error("fake redis should satisfy the ledger surface");
  return createRedisSpendLedger({
    redis: parsed.value,
    logger: collectLogs().logger,
    tenant: mkTenant("acme"),
    dagId: makeDagId("test-dag"),
    ttlSec: 3600,
  });
};

const fileRoots: string[] = [];
afterAll(() => {
  for (const root of fileRoots) rmSync(root, { recursive: true, force: true });
});
const fileLedger = (): SpendLedgerPort => {
  const root = mkdtempSync(join(tmpdir(), "fugue-host-spend-"));
  fileRoots.push(root);
  const created = createFileSpendLedger(root);
  if (!created.ok) throw new Error("temp directory should construct a file ledger");
  return created.value;
};

const BACKENDS: readonly (readonly [string, () => SpendLedgerPort])[] = [
  ["in-memory", () => createInMemorySpendLedger()],
  ["redis", redisLedger],
  ["file", fileLedger],
];

const readOrThrow = async (ledger: SpendLedgerPort, runId: RunId): Promise<Spend> => {
  const read = await ledger.read(runId);
  if (!read.ok) throw new Error("expected a readable ledger");
  return read.value;
};

for (const [name, build] of BACKENDS) {
  describe(`SpendLedgerPort contract — ${name}`, () => {
    it("reads an unknown run as NO_SPEND, not an error", async () => {
      // "Never seen" and "seen, spent nothing" are the same fact. An error here
      // would make every caller distinguish two states that mean one thing.
      expect(await readOrThrow(build(), runA)).toEqual(NO_SPEND);
    });

    it("reads back exactly what was appended", async () => {
      const ledger = build();
      const call = pricedCall(150, micros(2_000));
      expect((await ledger.add(runA, call)).ok).toBe(true);
      expect(await readOrThrow(ledger, runA)).toEqual(call);
    });

    it("accumulates across appends", async () => {
      const ledger = build();
      for (const _ of [1, 2, 3]) await ledger.add(runA, pricedCall(100, micros(500)));
      expect(await readOrThrow(ledger, runA)).toEqual({
        tokens: 300,
        calls: 3,
        usd: { kind: "priced", micros: micros(1_500) },
      });
    });

    it("keeps runs isolated", async () => {
      const ledger = build();
      await ledger.add(runA, pricedCall(100, micros(1)));
      await ledger.add(runB, pricedCall(7, micros(2)));
      expect((await readOrThrow(ledger, runA)).tokens).toBe(100);
      expect((await readOrThrow(ledger, runB)).tokens).toBe(7);
    });

    it("carries an unpriced model through the round trip, absorbing", async () => {
      // The durable record has to preserve "this run's cost is unknowable",
      // or a resumed slice would read a trustworthy-looking total and a usd
      // ceiling would stop failing closed.
      const ledger = build();
      await ledger.add(runA, pricedCall(10, micros(999)));
      await ledger.add(runA, unpricedCall(5, "mystery"));
      const spend = await readOrThrow(ledger, runA);
      expect(spend.usd.kind).toBe("unpriced");
      if (spend.usd.kind !== "unpriced") return;
      expect([...spend.usd.models]).toEqual(["mystery"]);
      expect(spend.usd.knownMicros).toBe(micros(999));
    });

    it("unions unpriced model names rather than keeping the last", async () => {
      const ledger = build();
      await ledger.add(runA, unpricedCall(1, "model-z"));
      await ledger.add(runA, unpricedCall(1, "model-a"));
      await ledger.add(runA, unpricedCall(1, "model-z")); // repeat is a no-op
      const spend = await readOrThrow(ledger, runA);
      if (spend.usd.kind !== "unpriced") throw new Error("expected unpriced");
      expect([...spend.usd.models]).toEqual(["model-a", "model-z"]);
    });

    it("is order-independent — appends commute, as the monoid does", async () => {
      // The property that makes the append lock-free. If the stored encoding
      // ever stopped being (sum, sum, sum, union), concurrent writers could
      // produce a total depending on arrival order and this would fail.
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.tuple(fc.nat({ max: 500 }), fc.nat({ max: 500 })).map(([t, m]) => pricedCall(t, micros(m))),
              fc.constantFrom("m1", "m2").map((model) => unpricedCall(3, model)),
            ),
            { minLength: 1, maxLength: 8 },
          ),
          async (calls) => {
            const forward = build();
            for (const c of calls) await forward.add(runA, c);
            const backward = build();
            for (const c of [...calls].reverse()) await backward.add(runA, c);
            expect(await readOrThrow(forward, runA)).toEqual(await readOrThrow(backward, runA));
          },
        ),
        { numRuns: 25 },
      );
    });

    it("concurrent appends preserve every delta", async () => {
      const ledger = build();
      const deltas = Array.from({ length: 12 }, (_, index) => pricedCall(index + 1, micros(index + 2)));
      const results = await Promise.all(deltas.map((delta) => ledger.add(runA, delta)));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await readOrThrow(ledger, runA)).toEqual(deltas.reduce(addSpend, NO_SPEND));
    });

    it("agrees with addSpend — the ledger cannot disagree with the in-process meter", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(fc.nat({ max: 400 }), fc.nat({ max: 400 })).map(([t, m]) => pricedCall(t, micros(m))),
            { maxLength: 10 },
          ),
          async (calls) => {
            const ledger = build();
            for (const c of calls) await ledger.add(runA, c);
            expect(await readOrThrow(ledger, runA)).toEqual(calls.reduce(addSpend, NO_SPEND));
          },
        ),
        { numRuns: 25 },
      );
    });
  });
}

describe("in-memory ledger defensive snapshots", () => {
  it("isolates seeded, stored, and returned Spend values from caller mutation", async () => {
    const sourceModels = ["seed-model"];
    const seeded: Spend = {
      tokens: 5,
      calls: 1,
      usd: {
        kind: "unpriced",
        models: sourceModels,
        knownMicros: micros(7),
      },
    };
    const ledger = createInMemorySpendLedger(new Map([[runA, seeded]]));

    sourceModels.push("source-poison");
    const first = await readOrThrow(ledger, runA);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.usd)).toBe(true);
    if (first.usd.kind !== "unpriced") throw new Error("expected unpriced seed");
    expect(Object.isFrozen(first.usd.models)).toBe(true);
    expect([...first.usd.models]).toEqual(["seed-model"]);
    expect(() => (first.usd.models as unknown as string[]).push("read-poison")).toThrow();

    const later = await readOrThrow(ledger, runA);
    if (later.usd.kind !== "unpriced") throw new Error("expected unpriced seed");
    expect([...later.usd.models]).toEqual(["seed-model"]);
    expect(later).not.toBe(first);
  });
});

describe("spendLedgerRedis: the construction-time surface check", () => {
  it.each(["sAdd", "sMembers", "hIncrBy", "hGetAll", "expire"] as const)(
    "refuses an adapter missing %s and names that primitive",
    (primitive) => {
      // Parse once at construction: malformed JavaScript adapters cannot defer
      // a missing set/hash primitive until the first budgeted provider call.
      const malformed = { ...fakeRedis().redis, [primitive]: undefined } as unknown as RedisPort;
      const parsed = spendLedgerRedis(malformed);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.kind).toBe("config-invalid");
      const message = "message" in parsed.error ? parsed.error.message : "";
      expect(message).toContain(primitive);
    },
  );

  it("accepts an adapter that offers all five required primitives", () => {
    expect(spendLedgerRedis(fakeRedis().redis).ok).toBe(true);
  });
});

describe("Redis ledger: key layout and TTL", () => {
  /**
   * Build a Redis-backed ledger over a controllable fake, returning both so a
   * test can inspect what actually reached Redis. The four cases below each
   * repeated this same narrow-then-construct sequence; only the TTL and the
   * fake's behaviour ever differ.
   */
  const ledgerOver = (redis: RedisPort, ttlSec?: number) => {
    const parsed = spendLedgerRedis(redis);
    if (!parsed.ok) throw new Error("fake redis should satisfy the ledger surface");
    const captured = collectLogs();
    const ledger = createRedisSpendLedger({
      redis: parsed.value,
      logger: captured.logger,
      tenant: mkTenant("acme"),
      dagId: makeDagId("test-dag"),
      ...(ttlSec !== undefined ? { ttlSec } : {}),
    });
    return { ledger, logs: captured.logs };
  };

  const orderedDelta: Spend = {
    tokens: 10,
    calls: 1,
    usd: { kind: "unpriced", models: ["mystery"], knownMicros: micros(7) },
  };

  it("namespaces both keys under the tenant prefix and refreshes their TTL", async () => {
    // The per-tenant Redis ACL is scoped to `~fugue:<tenant>:*`. A spend key
    // that escaped that prefix would be unreachable by the worker that wrote
    // it — and, worse, reachable by one that should not see it.
    const fake = fakeRedis();
    const { ledger } = ledgerOver(fake.redis, 900);

    await ledger.add(runA, unpricedCall(10, "mystery"));

    for (const key of [...fake.hashes.keys(), ...fake.sets.keys()]) {
      expect(key.startsWith("fugue:acme:")).toBe(true);
      expect(fake.expiries.get(key)).toBe(900);
    }
  });

  it("skips the TTL entirely when none is configured, matching the checkpoint writer", async () => {
    // A deployment with no checkpoint TTL keeps durable state. A spend record
    // that expired while its checkpoint survived would resume the run with a
    // refilled budget — the exact bug the ledger closes.
    const fake = fakeRedis();
    const { ledger } = ledgerOver(fake.redis);

    await ledger.add(runA, pricedCall(10, micros(1)));
    expect(fake.expiries.size).toBe(0);
  });

  it("returns Err when unpriced-model markers are unreadable instead of hydrating priced spend", async () => {
    const fake = fakeRedis();
    let modelReads = 0;
    const failing = {
      ...fake.redis,
      sMembers: async () => {
        modelReads += 1;
        return err({ kind: "redis-unavailable" as const, operation: "SMEMBERS" });
      },
    } as RedisPort;
    const { ledger } = ledgerOver(failing);
    expect((await ledger.add(runA, pricedCall(10, micros(7)))).ok).toBe(true);

    const hydrated = await ledger.read(runA);

    expect(hydrated).toEqual({
      ok: false,
      error: { kind: "redis-unavailable", operation: "SMEMBERS" },
    });
    expect(modelReads).toBe(1);
  });

  it("LOGS a TTL-refresh failure instead of discarding it (A1)", async () => {
    // The whole reason `logger` is a required dep. An EXPIRE that quietly stops
    // working lets a live run's spend record expire underneath it — the
    // refill-on-resume bug again, with nothing to grep for. The append itself
    // still succeeds: the spend IS recorded, only its idle TTL was not renewed.
    const fake = fakeRedis();
    const failing = {
      ...fake.redis,
      expire: async () => err({ kind: "redis-unavailable" as const, operation: "EXPIRE" }),
    } as unknown as RedisPort;
    const { ledger, logs } = ledgerOver(failing, 900);

    const appended = await ledger.add(runA, pricedCall(10, micros(1)));
    expect(appended.ok).toBe(true); // the spend is recorded regardless

    const warned = logs.filter((l) => l.msg === "spend-ledger.ttl-refresh-failed");
    expect(warned.length).toBe(2); // both keys
    expect(warned[0]?.level).toBe("warn");
    expect(String(warned[0]?.data?.["key"] ?? "")).toContain("fugue:acme:");
    expect(warned[0]?.data?.["ttlSec"]).toBe(900);
    expect(String(warned[0]?.data?.["consequence"] ?? "")).toContain("expire");
  });

  it("writes unpriced evidence before every numeric axis", async () => {
    const fake = fakeRedis();
    const operations: string[] = [];
    const recording = {
      ...fake.redis,
      hIncrBy: async (key: string, field: string, by: number) => {
        operations.push(`HINCRBY:${field}`);
        return fake.redis.hIncrBy!(key, field, by);
      },
      sAdd: async (key: string, member: string) => {
        operations.push("SADD:unpriced");
        return fake.redis.sAdd(key, member);
      },
    } as RedisPort;
    const { ledger } = ledgerOver(recording);

    expect((await ledger.add(runA, orderedDelta)).ok).toBe(true);
    expect(operations).toEqual([
      "SADD:unpriced",
      "HINCRBY:micros",
      "HINCRBY:tokens",
      "HINCRBY:calls",
    ]);
  });

  it("fails before numeric writes when SADD loses acknowledgement and rehydrates unpriced", async () => {
    const fake = fakeRedis();
    const operations: string[] = [];
    const failing = {
      ...fake.redis,
      hIncrBy: async (key: string, field: string, by: number) => {
        operations.push(`HINCRBY:${field}`);
        return fake.redis.hIncrBy!(key, field, by);
      },
      sAdd: async (key: string, member: string) => {
        operations.push("SADD:unpriced");
        // Model Redis committing the marker while its acknowledgement is lost.
        await fake.redis.sAdd(key, member);
        return err({ kind: "redis-unavailable" as const, operation: "SADD acknowledgement" });
      },
    } as RedisPort;
    const { ledger } = ledgerOver(failing);

    expect((await ledger.add(runA, orderedDelta)).ok).toBe(false);
    expect(operations).toEqual(["SADD:unpriced"]);
    expect(fake.hashes.size).toBe(0);

    const hydrated = await readOrThrow(ledger, runA);
    expect(hydrated.tokens).toBe(0);
    expect(hydrated.calls).toBe(0);
    expect(hydrated.usd.kind).toBe("unpriced");
    if (hydrated.usd.kind === "unpriced") {
      expect([...hydrated.usd.models]).toEqual(["mystery"]);
      expect(hydrated.usd.knownMicros).toBe(micros(0));
    }
  });

  it("stops at the first failed increment after preserving the unpriced marker", async () => {
    const fake = fakeRedis();
    const operations: string[] = [];
    const failing = {
      ...fake.redis,
      hIncrBy: async (key: string, field: string, by: number) => {
        operations.push(`HINCRBY:${field}`);
        return field === "tokens"
          ? err({ kind: "redis-unavailable" as const, operation: "HINCRBY tokens" })
          : fake.redis.hIncrBy!(key, field, by);
      },
      sAdd: async (key: string, member: string) => {
        operations.push("SADD:unpriced");
        return fake.redis.sAdd(key, member);
      },
    } as RedisPort;
    const { ledger } = ledgerOver(failing);

    expect((await ledger.add(runA, orderedDelta)).ok).toBe(false);
    expect(operations).toEqual(["SADD:unpriced", "HINCRBY:micros", "HINCRBY:tokens"]);
    const stored = [...fake.hashes.values()][0];
    expect(stored?.get("micros")).toBe(7);
    expect(stored?.has("tokens")).toBe(false);
    expect(stored?.has("calls")).toBe(false);
    expect([...fake.sets.values()][0]).toEqual(new Set(["mystery"]));
  });

  it("does not spend a round trip on a zero increment", async () => {
    const fake = fakeRedis();
    const { ledger } = ledgerOver(fake.redis);

    // A free call still counts one CALL, but writes no tokens or micros field.
    await ledger.add(runA, pricedCall(0, micros(0)));
    const hash = [...fake.hashes.values()][0];
    expect(hash?.has("calls")).toBe(true);
    expect(hash?.has("tokens")).toBe(false);
    expect(hash?.has("micros")).toBe(false);
  });
});
