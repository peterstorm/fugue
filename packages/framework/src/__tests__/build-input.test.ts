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
    }, "test-node");
    expect(result).toEqual({ ok: true, value: "dag-level-input" });
  });

  it("single required source → returns bare upstream value", () => {
    const outputs = new Map([["fetch", { data: 42 }]]);
    const result = buildNodeInput(null, outputs, {
      required: ["fetch"],
      optional: [],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { data: 42 } });
  });

  it("two required sources → returns keyed object", () => {
    const outputs = new Map([
      ["a", "valueA"],
      ["b", "valueB"],
    ]);
    const result = buildNodeInput(null, outputs, {
      required: ["a", "b"],
      optional: [],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { a: "valueA", b: "valueB" } });
  });

  it("optional sources present → keyed object with values", () => {
    const outputs = new Map([
      ["a", "valueA"],
      ["opt", "optValue"],
    ]);
    const result = buildNodeInput(null, outputs, {
      required: ["a"],
      optional: ["opt"],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { a: "valueA", opt: "optValue" } });
  });

  it("optional sources missing → keyed object with undefined", () => {
    const outputs = new Map([["a", "valueA"]]);
    const result = buildNodeInput(null, outputs, {
      required: ["a"],
      optional: ["opt"],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { a: "valueA", opt: undefined } });
  });

  it("optional forces keyed shape even with 0 required", () => {
    const outputs = new Map([["opt", "yes"]]);
    const result = buildNodeInput("dagInput", outputs, {
      required: [],
      optional: ["opt"],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { opt: "yes" } });
  });

  it("returns non-retriable error when required source is missing", () => {
    const result = buildNodeInput(null, new Map(), {
      required: ["missing"],
      optional: [],
    }, "test-node");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("BUG: required source 'missing' has no output");
      }
    }
  });
});
