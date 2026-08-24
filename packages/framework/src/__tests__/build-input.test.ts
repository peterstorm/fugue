/**
 * Unit tests for `buildNodeInput`.
 *
 * Validates the 0/1/≥2 required sources split and optional source handling.
 */

import { describe, it, expect } from "bun:test";
import { buildNodeInput } from "../shared/build-input.js";

describe("buildNodeInput", () => {
  it("no required sources → returns undefined (source node, C0)", () => {
    // Under 0.2.0 no node implicitly receives the DAG input: a 0-required node
    // is a source and gets `undefined`. The request reaches a node only via a
    // `$input` edge (which makes "$input" a required source).
    const result = buildNodeInput(new Map(), {
      required: [],
      optional: [],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("single $input source → returns the bare request (C0)", () => {
    // A `{ from: DAG_INPUT, to: n }` edge: "$input" is the one required source,
    // resolved from the seeded outputs map as a bare value.
    const outputs = new Map<string, unknown>([["$input", { region: "dk" }]]);
    const result = buildNodeInput(outputs, {
      required: ["$input"],
      optional: [],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { region: "dk" } });
  });

  it("single required source → returns bare upstream value", () => {
    const outputs = new Map([["fetch", { data: 42 }]]);
    const result = buildNodeInput(outputs, {
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
    const result = buildNodeInput(outputs, {
      required: ["a", "b"],
      optional: [],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { a: "valueA", b: "valueB" } });
  });

  it("fan-in including $input → keyed object with the request in its slot (C0)", () => {
    const outputs = new Map<string, unknown>([
      ["score", { scored: [] }],
      ["$input", { region: "dk", minScore: 5 }],
    ]);
    const result = buildNodeInput(outputs, {
      required: ["score", "$input"],
      optional: [],
    }, "assemble");
    expect(result).toEqual({
      ok: true,
      value: { score: { scored: [] }, $input: { region: "dk", minScore: 5 } },
    });
  });

  it("optional sources present → keyed object with values", () => {
    const outputs = new Map([
      ["a", "valueA"],
      ["opt", "optValue"],
    ]);
    const result = buildNodeInput(outputs, {
      required: ["a"],
      optional: ["opt"],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { a: "valueA", opt: "optValue" } });
  });

  it("optional sources missing → keyed object with undefined", () => {
    const outputs = new Map([["a", "valueA"]]);
    const result = buildNodeInput(outputs, {
      required: ["a"],
      optional: ["opt"],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { a: "valueA", opt: undefined } });
  });

  it("optional forces keyed shape even with 0 required", () => {
    const outputs = new Map([["opt", "yes"]]);
    const result = buildNodeInput(outputs, {
      required: [],
      optional: ["opt"],
    }, "test-node");
    expect(result).toEqual({ ok: true, value: { opt: "yes" } });
  });

  it("returns non-retriable error when required source is missing", () => {
    const result = buildNodeInput(new Map(), {
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
