import { describe, expect, it } from "bun:test";
import {
  ok, err, isOk, isErr, andThen, map, mapErr,
  unwrap, unwrapOr, fold, tryCatch, tryCatchAsync,
  tap, tapErr,
} from "../types/result.js";
import type { Result } from "../types/result.js";

describe("Result", () => {
  it("ok() creates Ok", () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("err() creates Err", () => {
    const r = err("boom");
    expect(r).toEqual({ ok: false, error: "boom" });
  });

  it("isOk returns true for Ok", () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err("x"))).toBe(false);
  });

  it("isErr returns true for Err", () => {
    expect(isErr(err("x"))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });

  it("andThen chains on Ok", () => {
    const r = andThen(ok(2), (v) => ok(v * 3));
    expect(r).toEqual({ ok: true, value: 6 });
  });

  it("andThen short-circuits on Err", () => {
    const r = andThen(err("fail") as any, (_v: number) => ok(99));
    expect(r).toEqual({ ok: false, error: "fail" });
  });

  it("map transforms value on Ok", () => {
    const r = map(ok(5), (v) => v + 1);
    expect(r).toEqual({ ok: true, value: 6 });
  });

  it("map passes through Err", () => {
    const r = map(err("e") as any, (v: number) => v + 1);
    expect(r).toEqual({ ok: false, error: "e" });
  });

  it("mapErr transforms error on Err", () => {
    const r = mapErr(err("x"), (e) => `wrapped: ${e}`);
    expect(r).toEqual({ ok: false, error: "wrapped: x" });
  });

  it("mapErr passes through Ok", () => {
    const r = mapErr(ok(1), (e) => `wrapped: ${e}`);
    expect(r).toEqual({ ok: true, value: 1 });
  });

  it("unwrap returns value on Ok", () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  it("unwrap throws on Err", () => {
    expect(() => unwrap(err("boom"))).toThrow();
  });

  it("unwrapOr returns value on Ok", () => {
    expect(unwrapOr(ok(42), 0)).toBe(42);
  });

  it("unwrapOr returns fallback on Err", () => {
    expect(unwrapOr(err("x"), 99)).toBe(99);
  });

  it("fold calls onOk for Ok", () => {
    const r = fold(ok(42), (v) => `val:${v}`, (e) => `err:${e}`);
    expect(r).toBe("val:42");
  });

  it("fold calls onErr for Err", () => {
    const r = fold(err("boom"), (v) => `val:${v}`, (e) => `err:${e}`);
    expect(r).toBe("err:boom");
  });
});

describe("tryCatch", () => {
  it("wraps successful computation as Ok", () => {
    const r = tryCatch(() => 42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("catches thrown Error as Err<Error>", () => {
    const r = tryCatch(() => { throw new Error("boom"); });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message).toBe("boom");
    }
  });

  it("catches non-Error throws as wrapped Error", () => {
    const r = tryCatch(() => { throw "string-error"; });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("string-error");
  });

  it("applies mapError when provided", () => {
    const r = tryCatch(
      () => { throw new Error("raw"); },
      (e) => `mapped: ${(e as Error).message}`,
    );
    expect(r).toEqual({ ok: false, error: "mapped: raw" });
  });

  it("returns Ok when mapError provided but no throw", () => {
    const r = tryCatch(() => 5, () => "never");
    expect(r).toEqual({ ok: true, value: 5 });
  });
});

describe("tryCatchAsync", () => {
  it("wraps resolved promise as Ok", async () => {
    const r = await tryCatchAsync(async () => 99);
    expect(r).toEqual({ ok: true, value: 99 });
  });

  it("catches rejected promise as Err", async () => {
    const r = await tryCatchAsync(async () => { throw new Error("async-boom"); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("async-boom");
  });

  it("catches non-Error async throws", async () => {
    const r = await tryCatchAsync(async () => { throw "raw-string"; });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("raw-string");
  });

  it("applies mapError for async failures", async () => {
    const r = await tryCatchAsync(
      async () => { throw new Error("raw"); },
      (e) => ({ code: "FAIL", msg: (e as Error).message }),
    );
    expect(r).toEqual({ ok: false, error: { code: "FAIL", msg: "raw" } });
  });
});

describe("tap / tapErr", () => {
  it("tap calls fn on Ok and returns same Result", () => {
    const calls: number[] = [];
    const r = tap(ok(5), (v) => calls.push(v));
    expect(r).toEqual(ok(5));
    expect(calls).toEqual([5]);
  });

  it("tap skips fn on Err", () => {
    const calls: number[] = [];
    const r = tap(err("x") as Result<number, string>, (v) => calls.push(v));
    expect(r).toEqual(err("x"));
    expect(calls).toEqual([]);
  });

  it("tapErr calls fn on Err and returns same Result", () => {
    const calls: string[] = [];
    const r = tapErr(err("oops"), (e) => calls.push(e));
    expect(r).toEqual(err("oops"));
    expect(calls).toEqual(["oops"]);
  });

  it("tapErr skips fn on Ok", () => {
    const calls: string[] = [];
    const r = tapErr(ok(1) as Result<number, string>, (e) => calls.push(e));
    expect(r).toEqual(ok(1));
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Additional combinators: sequenceFirst, sequenceAll, orElse, andThenAsync, mapAsync
// ---------------------------------------------------------------------------

import {
  sequenceFirst,
  sequenceAll,
  orElse,
  andThenAsync,
  mapAsync,
} from "../types/result.js";

describe("sequenceFirst", () => {
  it("returns ok(values[]) when all results are Ok", () => {
    const results = [ok(1), ok(2), ok(3)];
    expect(sequenceFirst(results)).toEqual(ok([1, 2, 3]));
  });

  it("short-circuits on the first Err", () => {
    const results: Result<number, string>[] = [ok(1), err("boom"), ok(3)];
    expect(sequenceFirst(results)).toEqual(err("boom"));
  });

  it("returns the earliest Err when multiple exist", () => {
    const results: Result<number, string>[] = [ok(1), err("first"), err("second")];
    expect(sequenceFirst(results)).toEqual(err("first"));
  });

  it("returns ok([]) for an empty array", () => {
    expect(sequenceFirst([])).toEqual(ok([]));
  });
});

describe("sequenceAll", () => {
  it("returns ok(values[]) when all results are Ok", () => {
    const results = [ok("a"), ok("b")];
    expect(sequenceAll(results)).toEqual(ok(["a", "b"]));
  });

  it("returns err(allErrors[]) when any results are Err", () => {
    const results: Result<number, string>[] = [ok(1), err("e1"), ok(3), err("e2")];
    expect(sequenceAll(results)).toEqual(err(["e1", "e2"]));
  });

  it("returns ok([]) for an empty array", () => {
    expect(sequenceAll([])).toEqual(ok([]));
  });

  it("collects all errors, not just the first", () => {
    const results: Result<number, string>[] = [err("a"), err("b"), err("c")];
    const r = sequenceAll(results);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual(["a", "b", "c"]);
  });
});

describe("orElse", () => {
  it("passes Ok through without calling recovery fn", () => {
    const r = orElse(ok(42) as Result<number, string>, (_e) => ok(0));
    expect(r).toEqual(ok(42));
  });

  it("calls recovery fn on Err and returns its result", () => {
    const r = orElse(err("oops") as Result<number, string>, (e) => ok(e.length));
    expect(r).toEqual(ok(4));
  });

  it("recovery fn can return a new Err", () => {
    const r = orElse(err("oops") as Result<number, string>, (_e) => err("still broken") as Result<number, string>);
    expect(r).toEqual(err("still broken"));
  });
});

describe("andThenAsync", () => {
  it("chains async fn on Ok", async () => {
    const r = await andThenAsync(ok(5), async (v) => ok(v * 2));
    expect(r).toEqual(ok(10));
  });

  it("short-circuits on Err without calling fn", async () => {
    let called = false;
    const r = await andThenAsync(err("nope") as Result<number, string>, async (_v) => {
      called = true;
      return ok(99);
    });
    expect(r).toEqual(err("nope"));
    expect(called).toBe(false);
  });

  it("async fn can return Err", async () => {
    const r = await andThenAsync(ok(5), async (_v) => err("async fail") as Result<number, string>);
    expect(r).toEqual(err("async fail"));
  });
});

describe("mapAsync", () => {
  it("transforms value on Ok via async fn", async () => {
    const r = await mapAsync(ok("hello"), async (s) => s.toUpperCase());
    expect(r).toEqual(ok("HELLO"));
  });

  it("passes through Err without calling fn", async () => {
    let called = false;
    const r = await mapAsync(err("nope") as Result<string, string>, async (_s) => {
      called = true;
      return "never";
    });
    expect(r).toEqual(err("nope"));
    expect(called).toBe(false);
  });
});
