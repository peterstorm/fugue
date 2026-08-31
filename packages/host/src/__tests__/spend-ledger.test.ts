/**
 * The `SpendLedgerPort` contract, run against EVERY adapter.
 *
 * One suite, parameterised over the backends, because the whole point of the
 * port is that a run's spend means the same thing whichever one stored it. A
 * per-adapter suite would let them drift into disagreeing about the case that
 * matters most — what a resumed slice reads.
 *
 * The Redis adapter is exercised over an in-memory fake of the Redis
 * primitives, not a live server: what is under test is the one-HASH encoding
 * (three sums and reserved membership fields) and strict one-read hydration.
 */

import { afterAll, describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runId as makeRunId, dagId as makeDagId, ok, err } from "@fuguejs/framework";
import type { MicroUsd, RunId, Spend } from "@fuguejs/framework";
import { NO_SPEND, addSpend, pricedCall, unpricedCall } from "@fuguejs/framework";
import type { RedisPort, RedisSpendAppend, SpendLedgerPort } from "../ports.js";
import { createInMemorySpendLedger } from "../adapters/spend-ledger-memory.js";
import { createRedisSpendLedger, spendLedgerRedis } from "../adapters/spend-ledger-redis.js";
import { createFileSpendLedger } from "../adapters/spend-ledger-file.js";
import { tenantId } from "../domain/tenant.js";
import {
  recordOf,
  SPEND_HASH_FIELDS,
  SPEND_UNPRICED_MARKER_VALUE,
  unpricedModelHashField,
} from "../domain/spend-record.js";

const micros = (n: number): MicroUsd => n as MicroUsd;
const runA = makeRunId("run-a");
const runB = makeRunId("run-b");

const mkTenant = (raw: string) => {
  const parsed = tenantId(raw);
  if (!parsed.ok) throw new Error("bad tenant fixture");
  return parsed.value;
};

/**
 * A fake of the ledger's one-hash Redis capability. `appendSpend` assigns
 * idempotent marker fields, adds numeric axes, and refreshes retention as one
 * operation; `HGETALL` reads an absent hash as an empty record.
 */
const fakeRedis = (): {
  redis: RedisPort;
  hashes: Map<string, Map<string, string>>;
  expiries: Map<string, number>;
  appends: RedisSpendAppend[];
} => {
  const hashes = new Map<string, Map<string, string>>();
  const expiries = new Map<string, number>();
  const appends: RedisSpendAppend[] = [];
  const redis = {
    hGetAll: async (key: string) => ok(Object.fromEntries(hashes.get(key) ?? new Map())),
    appendSpend: async (append: RedisSpendAppend) => {
      appends.push(append);
      const record = recordOf(append.delta);
      const hash = hashes.get(append.key) ?? new Map<string, string>();
      for (const model of record.unpricedModels) {
        hash.set(unpricedModelHashField(model), SPEND_UNPRICED_MARKER_VALUE);
      }
      for (const [field, by] of [
        [SPEND_HASH_FIELDS.micros, record.micros],
        [SPEND_HASH_FIELDS.tokens, record.tokens],
        [SPEND_HASH_FIELDS.calls, record.calls],
      ] as const) {
        if (by !== 0) hash.set(field, String(Number(hash.get(field) ?? "0") + by));
      }
      if (hash.size > 0) hashes.set(append.key, hash);
      if (append.ttlSec !== undefined && hashes.has(append.key)) {
        expiries.set(append.key, append.ttlSec);
      }
      return ok(undefined);
    },
  } as unknown as RedisPort;
  return { redis, hashes, expiries, appends };
};

const redisLedger = (): SpendLedgerPort => {
  const parsed = spendLedgerRedis(fakeRedis().redis);
  if (!parsed.ok) throw new Error("fake redis should satisfy the ledger surface");
  return createRedisSpendLedger({
    redis: parsed.value,
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
      await ledger.add(runA, unpricedCall(1, "model-z")); // repeat is a no-op for the model-name set
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
  it.each(["hGetAll", "appendSpend"] as const)(
    "refuses an adapter missing %s and names that capability",
    (capability) => {
      const malformed = { ...fakeRedis().redis, [capability]: undefined } as unknown as RedisPort;
      const parsed = spendLedgerRedis(malformed);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.kind).toBe("config-invalid");
      const message = "message" in parsed.error ? parsed.error.message : "";
      expect(message).toContain(capability);
    },
  );

  it("accepts the complete read/append capability", () => {
    expect(spendLedgerRedis(fakeRedis().redis).ok).toBe(true);
  });

  it("receiver-binds every copied method", async () => {
    const state = fakeRedis();
    const receiverDependent = {
      ...state.redis,
      marker: "receiver",
      hGetAll(this: { marker: string }, key: string) {
        if (this.marker !== "receiver") throw new Error("hGetAll lost receiver");
        return state.redis.hGetAll!(key);
      },
      appendSpend(this: { marker: string }, append: RedisSpendAppend) {
        if (this.marker !== "receiver") throw new Error("appendSpend lost receiver");
        return state.redis.appendSpend!(append);
      },
    } as RedisPort & { readonly marker: string };
    const parsed = spendLedgerRedis(receiverDependent);
    if (!parsed.ok) throw new Error("expected receiver-dependent adapter to parse");
    const ledger = createRedisSpendLedger({
      redis: parsed.value,
      tenant: mkTenant("acme"),
      dagId: makeDagId("test-dag"),
      ttlSec: 30,
    });

    expect((await ledger.add(runA, unpricedCall(3, "mystery"))).ok).toBe(true);
    expect((await ledger.read(runA)).ok).toBe(true);
  });
});

describe("Redis ledger: complete transactional append", () => {
  const ledgerOver = (redis: RedisPort, ttlSec?: number) => {
    const parsed = spendLedgerRedis(redis);
    if (!parsed.ok) throw new Error("fake redis should satisfy the ledger surface");
    return createRedisSpendLedger({
      redis: parsed.value,
      tenant: mkTenant("acme"),
      dagId: makeDagId("test-dag"),
      ...(ttlSec !== undefined ? { ttlSec } : {}),
    });
  };

  const orderedDelta: Spend = {
    tokens: 10,
    calls: 1,
    usd: { kind: "unpriced", models: ["model-a", "model-z"], knownMicros: micros(7) },
  };

  it("delegates the complete append once with one namespaced key and one TTL", async () => {
    const fake = fakeRedis();
    const ledger = ledgerOver(fake.redis, 900);

    expect((await ledger.add(runA, orderedDelta)).ok).toBe(true);

    expect(fake.appends).toEqual([{
      key: "fugue:acme:test-dag:run-a:$spend",
      delta: orderedDelta,
      ttlSec: 900,
    }]);
    expect([...fake.expiries.entries()]).toEqual([
      ["fugue:acme:test-dag:run-a:$spend", 900],
    ]);
    expect((await readOrThrow(ledger, runA)).usd.kind).toBe("unpriced");
  });

  it("uses no standalone marker, value, or expiry command path", async () => {
    const fake = fakeRedis();
    let standaloneCalls = 0;
    const redis = {
      ...fake.redis,
      sAdd: async () => { standaloneCalls += 1; return ok(1); },
      hIncrBy: async () => { standaloneCalls += 1; return ok(1); },
      expire: async () => { standaloneCalls += 1; return ok(true); },
    } as unknown as RedisPort;
    const ledger = ledgerOver(redis, 900);

    expect((await ledger.add(runA, orderedDelta)).ok).toBe(true);
    expect(standaloneCalls).toBe(0);
    expect(fake.appends).toHaveLength(1);
  });

  it("omits retention from the atomic append when no TTL is configured", async () => {
    const fake = fakeRedis();
    const ledger = ledgerOver(fake.redis);

    expect((await ledger.add(runA, pricedCall(10, micros(1)))).ok).toBe(true);
    expect(fake.appends[0]).not.toHaveProperty("ttlSec");
    expect(fake.expiries.size).toBe(0);
  });

  it("hydrates with exactly one HGETALL, so expiry cannot split marker and figures", async () => {
    const fake = fakeRedis();
    let reads = 0;
    const redis = {
      ...fake.redis,
      hGetAll: async (key: string) => {
        reads += 1;
        return fake.redis.hGetAll!(key);
      },
      sMembers: async () => {
        throw new Error("a split second read must never occur");
      },
    } as RedisPort;
    const ledger = ledgerOver(redis);
    expect((await ledger.add(runA, orderedDelta)).ok).toBe(true);

    const spend = await ledger.read(runA);
    expect(spend.ok && spend.value.usd.kind).toBe("unpriced");
    expect(reads).toBe(1);
  });

  it.each([
    ["unknown field", { tokens: "10", shadowCalls: "99" }],
    ["negative integer", { tokens: "-1" }],
    ["unsafe integer", { tokens: "9007199254740992" }],
    ["non-canonical integer", { tokens: "01" }],
    ["malformed marker field", { "$unpriced:%ZZ": "1" }],
    ["malformed marker value", { "$unpriced:model-a": "0" }],
  ])("refuses a malformed hash (%s) instead of hydrating undercounted spend", async (_label, stored) => {
    const fake = fakeRedis();
    const ledger = ledgerOver({
      ...fake.redis,
      hGetAll: async () => ok(stored),
    } as RedisPort);

    const result = await ledger.read(runA);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal-invariant-violated");
  });

  it("returns a typed append failure without claiming a committed transaction", async () => {
    const fake = fakeRedis();
    const failing = {
      ...fake.redis,
      appendSpend: async () =>
        err({ kind: "redis-unavailable" as const, operation: "spend append EXEC failed" }),
    } as RedisPort;
    const ledger = ledgerOver(failing, 900);

    expect(await ledger.add(runA, orderedDelta)).toEqual({
      ok: false,
      error: { kind: "redis-unavailable", operation: "spend append EXEC failed" },
    });
    expect(fake.hashes.size).toBe(0);
  });

  it("rehydrates lone-surrogate model spend into a fresh ledger instance", async () => {
    const fake = fakeRedis();
    const firstSlice = ledgerOver(fake.redis, 900);
    const model = `hostile-${String.fromCharCode(0xd800)}-model`;

    expect((await firstSlice.add(runA, unpricedCall(3, model))).ok).toBe(true);

    const resumedSlice = ledgerOver(fake.redis, 900);
    const resumed = await resumedSlice.read(runA);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok || resumed.value.usd.kind !== "unpriced") {
      throw new Error("expected durable unpriced spend");
    }
    expect(resumed.value.usd.models).toEqual([model]);
    expect(resumed.value.calls).toBe(1);
  });

  it("fences a throwing HGETALL implementation as one typed read failure", async () => {
    const fake = fakeRedis();
    const ledger = ledgerOver({
      ...fake.redis,
      hGetAll: async () => { throw new Error("read transport escaped"); },
    } as RedisPort);

    const result = await ledger.read(runA);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("internal-invariant-violated");
    expect("message" in result.error ? result.error.message : "").toContain(
      "hGetAll threw across the port boundary: read transport escaped",
    );
  });

  it("fences a throwing transaction implementation as one typed append failure", async () => {
    const fake = fakeRedis();
    const throwing = {
      ...fake.redis,
      appendSpend: async () => { throw new Error("transaction acknowledgement lost"); },
    } as RedisPort;
    const ledger = ledgerOver(throwing, 900);

    const result = await ledger.add(runA, orderedDelta);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("internal-invariant-violated");
    expect("message" in result.error ? result.error.message : "").toContain(
      "appendSpend threw across the port boundary: transaction acknowledgement lost",
    );
    expect(fake.hashes.size).toBe(0);
  });
});
