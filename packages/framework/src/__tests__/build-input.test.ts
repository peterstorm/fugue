/**
 * Unit tests for `buildNodeInput`.
 *
 * Validates bare/keyed assembly by total incoming-source cardinality. Node ids
 * go through the branded `NodeId` smart constructor — the validated-id
 * precondition `buildNodeInput` expresses structurally in its signature.
 */

import { describe, it, expect } from "bun:test";
import { buildNodeInput } from "../shared/build-input.js";
import { DAG_INPUT, nodeId } from "../types/ids.js";

describe("buildNodeInput", () => {
  it("no incoming sources → returns undefined (source node, C0)", () => {
    // Under 0.2.0 no node implicitly receives the DAG input: a 0-required node
    // is a source and gets `undefined`. The request reaches a node only via a
    // `$input` edge (which makes "$input" a required source).
    const result = buildNodeInput(new Map(), {
      required: [],
      optional: [],
    }, nodeId("test-node"));
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("single $input source → returns the bare request (C0)", () => {
    // A `{ from: DAG_INPUT, to: n }` edge: "$input" is the one required source,
    // resolved from the seeded outputs map as a bare value.
    const outputs = new Map<string, unknown>([["$input", { region: "dk" }]]);
    const result = buildNodeInput(outputs, {
      required: [DAG_INPUT],
      optional: [],
    }, nodeId("test-node"));
    expect(result).toEqual({ ok: true, value: { region: "dk" } });
  });

  it("single required source → returns bare upstream value", () => {
    const outputs = new Map([["fetch", { data: 42 }]]);
    const result = buildNodeInput(outputs, {
      required: [nodeId("fetch")],
      optional: [],
    }, nodeId("test-node"));
    expect(result).toEqual({ ok: true, value: { data: 42 } });
  });

  it("two required sources → returns keyed object", () => {
    const outputs = new Map([
      ["a", "valueA"],
      ["b", "valueB"],
    ]);
    const result = buildNodeInput(outputs, {
      required: [nodeId("a"), nodeId("b")],
      optional: [],
    }, nodeId("test-node"));
    expect(result).toEqual({ ok: true, value: { a: "valueA", b: "valueB" } });
  });

  it("fan-in including $input → keyed object with the request in its slot (C0)", () => {
    const outputs = new Map<string, unknown>([
      ["score", { scored: [] }],
      ["$input", { region: "dk", minScore: 5 }],
    ]);
    const result = buildNodeInput(outputs, {
      required: [nodeId("score"), DAG_INPUT],
      optional: [],
    }, nodeId("assemble"));
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
      required: [nodeId("a")],
      optional: [nodeId("opt")],
    }, nodeId("test-node"));
    expect(result).toEqual({ ok: true, value: { a: "valueA", opt: "optValue" } });
  });

  it("optional sources missing → keyed object with undefined", () => {
    const outputs = new Map([["a", "valueA"]]);
    const result = buildNodeInput(outputs, {
      required: [nodeId("a")],
      optional: [nodeId("opt")],
    }, nodeId("test-node"));
    expect(result).toEqual({ ok: true, value: { a: "valueA", opt: undefined } });
  });

  it("one selected optional router source returns its bare upstream value", () => {
    const outputs = new Map([["classifier", { route: "yes" }]]);
    const result = buildNodeInput(outputs, {
      required: [],
      optional: [nodeId("classifier")],
    }, nodeId("handler"));
    expect(result).toEqual({ ok: true, value: { route: "yes" } });
  });

  it("multiple optional sources retain a keyed fan-in shape", () => {
    const outputs = new Map([["left", "yes"]]);
    const result = buildNodeInput(outputs, {
      required: [],
      optional: [nodeId("left"), nodeId("right")],
    }, nodeId("merge"));
    expect(result).toEqual({
      ok: true,
      value: { left: "yes", right: undefined },
    });
  });

  it("returns non-retriable error when required source is missing", () => {
    const result = buildNodeInput(new Map(), {
      required: [nodeId("missing")],
      optional: [],
    }, nodeId("test-node"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("BUG: required source 'missing' has no output");
      }
    }
  });

  it("returns non-retriable error when the sole optional source is missing", () => {
    // Same corruption class as the required-source branch: a selected router
    // edge whose output is absent is checkpoint corruption or a framework
    // ordering bug, so it gets the same non-retriable node-attributed error
    // instead of silently passing `undefined` as the node's input.
    const result = buildNodeInput(new Map(), {
      required: [],
      optional: [nodeId("classifier")],
    }, nodeId("handler"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      if (result.error.kind === "node-crash") {
        expect(result.error.retriability).toBe("non-retriable");
        expect(result.error.message).toContain("BUG: sole optional source 'classifier' has no output");
      }
    }
  });
});
