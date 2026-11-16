/**
 * Tests for the two in-process concurrency guards (single-flight.ts): the keyed
 * single-flight that COALESCES concurrent callers onto one promise, and the
 * skip-if-running guard that turns an overlapping call away with a fixed value.
 */

import { describe, test, expect } from "bun:test";
import { singleFlight, skipIfRunning } from "../../../supervisor/lifecycle/single-flight.js";

/** A promise plus the function that settles it, for parking a task mid-flight. */
const gate = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("singleFlight", () => {
  test("concurrent callers for one key share ONE task run and ONE result", async () => {
    const flight = singleFlight<string, number>();
    const g = gate<number>();
    let runs = 0;
    const task = (): Promise<number> => {
      runs += 1;
      return g.promise;
    };
    const a = flight.run("acme", task);
    const b = flight.run("acme", task);
    g.resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(runs).toBe(1);
  });

  test("distinct keys run independently", async () => {
    const flight = singleFlight<string, string>();
    const [a, b] = await Promise.all([
      flight.run("acme", async () => "a"),
      flight.run("globex", async () => "b"),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  test("the task starts synchronously, before run returns", () => {
    const flight = singleFlight<string, void>();
    let started = false;
    void flight.run("acme", async () => {
      started = true;
    });
    expect(started).toBe(true);
  });

  test("a settled flight is cleared — the next call runs the task again", async () => {
    const flight = singleFlight<string, number>();
    let runs = 0;
    const task = async (): Promise<number> => ++runs;
    expect(await flight.run("acme", task)).toBe(1);
    expect(await flight.run("acme", task)).toBe(2);
  });

  test("a rejected flight is cleared too, and every coalesced caller sees the rejection", async () => {
    const flight = singleFlight<string, number>();
    const g = gate<number>();
    const a = flight.run("acme", () => g.promise);
    const b = flight.run("acme", () => g.promise);
    g.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect(await flight.run("acme", async () => 3)).toBe(3);
  });
});

describe("skipIfRunning", () => {
  test("a call overlapping a running task is SKIPPED with the given value — it does not share the result", async () => {
    const guard = skipIfRunning<readonly string[]>();
    const g = gate<readonly string[]>();
    let runs = 0;
    const first = guard.run(() => {
      runs += 1;
      return g.promise;
    }, []);
    const second = guard.run(async () => {
      runs += 1;
      return ["never"];
    }, []);
    expect(await second).toEqual([]);
    g.resolve(["acme"]);
    expect(await first).toEqual(["acme"]);
    expect(runs).toBe(1);
  });

  test("the guard is released after the task settles, including when it rejects", async () => {
    const guard = skipIfRunning<number>();
    await expect(guard.run(async () => Promise.reject(new Error("boom")), 0)).rejects.toThrow("boom");
    expect(await guard.run(async () => 5, 0)).toBe(5);
  });
});
