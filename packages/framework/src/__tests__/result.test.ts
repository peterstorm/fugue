import { describe, expect, it } from "bun:test";
import { ok, err, isOk, isErr, andThen, map, mapErr, unwrap, unwrapOr } from "../types/result.js";

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
});
