/**
 * Tests for the single-flight token cell (adapters/token-cell.ts), at its one
 * entry point `obtain`: reuse while fresh, one acquisition per key at a time,
 * no lost update between keys under any interleaving (I1), and a throwing
 * acquisition surfacing on the Result channel for every waiter.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { ok, err, type Result } from "@fuguejs/framework";
import { createTokenCell, type FreshToken } from "../token-cell.js";

type Failure = { readonly kind: "failed"; readonly why: string };

const thrownFailure = (thrown: unknown): Failure => ({ kind: "failed", why: `threw: ${String(thrown)}` });

const fresh = (token: string, expiresInSec = 3600): Result<FreshToken<string>, Failure> =>
  ok({ token, expiresInSec, witness: `minted:${token}` });

const cellAt = (clock: { now: number }) =>
  createTokenCell<string, Failure>({ now: () => clock.now, onThrow: thrownFailure });

describe("TokenCell.obtain — reuse while fresh", () => {
  it("the first obtain mints (with the witness), a repeat inside the TTL reuses without acquiring", async () => {
    const clock = { now: 0 };
    const cell = cellAt(clock);
    let acquisitions = 0;
    const acquire = async () => {
      acquisitions += 1;
      return fresh(`tok-${acquisitions}`);
    };

    expect(await cell.obtain("k", acquire)).toEqual(
      ok({ acquisition: "minted", token: "tok-1", witness: "minted:tok-1" }),
    );
    clock.now = 1_000;
    expect(await cell.obtain("k", acquire)).toEqual(ok({ acquisition: "cache-reuse", token: "tok-1" }));
    expect(acquisitions).toBe(1);
  });

  it("re-acquires once the early-refresh-adjusted expiry has passed", async () => {
    const clock = { now: 0 };
    const cell = cellAt(clock);
    let acquisitions = 0;
    const acquire = async () => {
      acquisitions += 1;
      return fresh(`tok-${acquisitions}`, 1); // lifetime 1000ms → cached for 500ms
    };

    await cell.obtain("k", acquire);
    clock.now = 500;
    const second = await cell.obtain("k", acquire);
    expect(second.ok && second.value.acquisition).toBe("minted");
    expect(acquisitions).toBe(2);
  });

  it("keys are independent: a token for one key is never served for another", async () => {
    const cell = cellAt({ now: 0 });
    await cell.obtain("a", async () => fresh("tok-a"));
    const b = await cell.obtain("b", async () => fresh("tok-b"));
    expect(b.ok && b.value.token).toBe("tok-b");
  });
});

describe("TokenCell.obtain — a failed acquisition caches nothing", () => {
  it("an err is returned as-is and the next obtain acquires again", async () => {
    const cell = cellAt({ now: 0 });
    const failure: Failure = { kind: "failed", why: "denied" };
    expect(await cell.obtain("k", async () => err(failure))).toEqual(err(failure));
    const retry = await cell.obtain("k", async () => fresh("tok"));
    expect(retry.ok && retry.value.acquisition).toBe("minted");
  });

  it("a THROWING acquisition reaches every waiter as err(onThrow(...)), never as a rejection", async () => {
    const cell = cellAt({ now: 0 });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquisitions = 0;
    const acquire = async (): Promise<Result<FreshToken<string>, Failure>> => {
      acquisitions += 1;
      await gate;
      throw new Error("port contract violated");
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const both = Promise.all([cell.obtain("k", acquire), cell.obtain("k", acquire)]);
      release();
      const expected = err(thrownFailure(new Error("port contract violated")));
      expect(await both).toEqual([expected, expected]);
      expect(acquisitions).toBe(1);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // The failed flight was cleared: the next obtain leads a fresh acquisition.
    const retry = await cell.obtain("k", async () => fresh("tok"));
    expect(retry.ok && retry.value.acquisition).toBe("minted");
  });
});

describe("TokenCell.obtain — single-flight and no lost update under any interleaving (SC-008, I1)", () => {
  it("for any set of concurrent obtains settling in any order: one acquisition per key, one 'minted' per key, every key cached", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 12 }),
        async (s, keys) => {
          const cell = cellAt({ now: 0 });
          const acquiredPerKey = new Map<string, number>();
          const acquireFor = (key: string) => () => {
            acquiredPerKey.set(key, (acquiredPerKey.get(key) ?? 0) + 1);
            return s.schedule(Promise.resolve(fresh(`tok-${key}`)), `acquire ${key}`);
          };

          const pending = keys.map((key) => cell.obtain(key, acquireFor(key)));
          await s.waitAll();
          const results = await Promise.all(pending);

          const distinct = new Set(keys);
          // Single-flight: exactly one acquisition per distinct key.
          expect([...acquiredPerKey.values()].every((n) => n === 1)).toBe(true);
          expect(acquiredPerKey.size).toBe(distinct.size);
          // The audit-facing witness: one 'minted' per key, the rest reuse it.
          const minted = results.filter((r) => r.ok && r.value.acquisition === "minted");
          expect(minted.length).toBe(distinct.size);
          // Every caller got its own key's token.
          results.forEach((r, i) => expect(r.ok && r.value.token).toBe(`tok-${keys[i]}`));

          // I1: whatever order the acquisitions settled in, no store clobbered
          // another — every key is now a cache hit, with no further acquisition.
          for (const key of distinct) {
            const again = await cell.obtain(key, acquireFor(key));
            expect(again.ok && again.value.acquisition).toBe("cache-reuse");
          }
          expect([...acquiredPerKey.values()].every((n) => n === 1)).toBe(true);
        },
      ),
    );
  });
});
