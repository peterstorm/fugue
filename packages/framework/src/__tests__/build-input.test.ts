/**
 * Unit tests for `buildNodeInput`.
 *
 * Validates the 0/1/≥2 required sources split and optional source handling.
 */

import { describe, it, expect } from "bun:test";
import { buildNodeInput } from "../shared/build-input.js";
import type { IncomingSources } from "../shared/incoming.js";

describe("buildNodeInput", () => {
  it("no required sources → returns dagInput", () => {
    const result = buildNodeInput("dag-level-input", new Map(), {
      required: [],
      optional: [],
    });
    expect(result).toBe("dag-level-input");
  });

  it("single required source → returns bare upstream value", () => {
    const outputs = new Map([["fetch", { data: 42 }]]);
    const result = buildNodeInput(null, outputs, {
      required: ["fetch"],
      optional: [],
    });
    expect(result).toEqual({ data: 42 });
  });

  it("two required sources → returns keyed object", () => {
    const outputs = new Map([
      ["a", "valueA"],
      ["b", "valueB"],
    ]);
    const result = buildNodeInput(null, outputs, {
      required: ["a", "b"],
      optional: [],
    });
    expect(result).toEqual({ a: "valueA", b: "valueB" });
  });

  it("optional sources present → keyed object with values", () => {
    const outputs = new Map([
      ["a", "valueA"],
      ["opt", "optValue"],
    ]);
    const result = buildNodeInput(null, outputs, {
      required: ["a"],
      optional: ["opt"],
    });
    expect(result).toEqual({ a: "valueA", opt: "optValue" });
  });

  it("optional sources missing → keyed object with undefined", () => {
    const outputs = new Map([["a", "valueA"]]);
    const result = buildNodeInput(null, outputs, {
      required: ["a"],
      optional: ["opt"],
    });
    expect(result).toEqual({ a: "valueA", opt: undefined });
  });

  it("optional forces keyed shape even with 0 required", () => {
    const outputs = new Map([["opt", "yes"]]);
    const result = buildNodeInput("dagInput", outputs, {
      required: [],
      optional: ["opt"],
    });
    expect(result).toEqual({ opt: "yes" });
  });

  it("throws when required source is missing from outputs", () => {
    expect(() =>
      buildNodeInput(null, new Map(), {
        required: ["missing"],
        optional: [],
      }),
    ).toThrow("BUG: required source 'missing' has no output");
  });
});
