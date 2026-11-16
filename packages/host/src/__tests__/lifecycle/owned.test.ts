import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { owned } from "../../lifecycle/owned.js";

describe("owned", () => {
  it("starts empty", () => {
    const cell = owned<{ readonly id: number }>();
    expect(cell.peek()).toBeUndefined();
    expect(cell.take()).toBeUndefined();
  });

  it("take returns the held value once, then the cell is empty", () => {
    const resource = { id: 1 };
    const cell = owned<{ readonly id: number }>();
    cell.set(resource);
    expect(cell.take()).toBe(resource);
    expect(cell.take()).toBeUndefined();
    expect(cell.peek()).toBeUndefined();
  });

  it("peek reads the held value without releasing it", () => {
    const resource = { id: 2 };
    const cell = owned<{ readonly id: number }>();
    cell.set(resource);
    expect(cell.peek()).toBe(resource);
    expect(cell.peek()).toBe(resource);
    expect(cell.take()).toBe(resource);
  });

  it("set replaces the held value", () => {
    const first = { id: 1 };
    const second = { id: 2 };
    const cell = owned<{ readonly id: number }>();
    cell.set(first);
    cell.set(second);
    expect(cell.take()).toBe(second);
  });

  it("a value is handed out by at most one take, however many takes follow", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.nat({ max: 10 }), (ids, takes) => {
        const cell = owned<{ readonly ids: readonly number[] }>();
        const resource = { ids };
        cell.set(resource);
        const taken = Array.from({ length: takes + 1 }, () => cell.take());
        expect(taken.filter((v) => v !== undefined)).toEqual([resource]);
        expect(taken[0]).toBe(resource);
      }),
    );
  });
});
