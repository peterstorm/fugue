// run-node-input-assembly.test.ts — Tests for run-node.ts input assembly logic
// Finding #19: conditional dep input assembly only integration-tested.
//
// Tests the 0/1/≥2 required dep split and optional dep keyed-object shape
// via runNodeShared with a trivial echo node that returns its input.

import { describe, it, expect } from "bun:test";
import { N, R, D, nodeMap } from "./_id-helpers.js";
import { z } from "zod";
import { runNodeShared } from "../dag-runtime/run-node.js";
import { ok } from "../types/result.js";
import type { NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { IncomingSources } from "../shared/incoming.js";
import { makeNodeContext } from "../shared/index.js";

// Echo node: returns whatever input it receives
const echoNode: NodeDef<unknown, unknown> = {
  id: N("echo"),
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [],
  run: async (input) => ok(input),
};

// Minimal validated context — echo node has requires: [] so any ctx is valid.
// Cast to ValidatedNodeContext since there's nothing to validate.
const ctx = makeNodeContext({ runId: "test-run", dagId: "test-dag" }) as unknown as ValidatedNodeContext;

describe("runNodeShared input assembly", () => {

  it("0 required deps, 0 optional → input = dagInput", async () => {
    const incoming: IncomingSources = { required: [], optional: [] };
    const outputs: ReadonlyMap<string, unknown> = new Map();

    // @ts-expect-error — branded ID test fixture
    const { result } = await runNodeShared(echoNode, "dag-level-input", ctx, D("d"), outputs, incoming);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("dag-level-input");
  });

  it("1 required dep → input = bare upstream value", async () => {
    const incoming: IncomingSources = { required: ["upstream"], optional: [] };
    const outputs: ReadonlyMap<string, unknown> = new Map([["upstream", { x: 42 }]]);

    // @ts-expect-error — branded ID test fixture
    const { result } = await runNodeShared(echoNode, "ignored", ctx, D("d"), outputs, incoming);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ x: 42 });
  });

  it("2 required deps → input = keyed object", async () => {
    const incoming: IncomingSources = { required: ["a", "b"], optional: [] };
    const outputs: ReadonlyMap<string, unknown> = new Map([
      ["a", "valueA"],
      ["b", "valueB"],
    ]);

    // @ts-expect-error — branded ID test fixture
    const { result } = await runNodeShared(echoNode, "ignored", ctx, D("d"), outputs, incoming);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: "valueA", b: "valueB" });
  });

  it("optional deps present → keyed object with all keys", async () => {
    const incoming: IncomingSources = { required: ["r"], optional: ["opt"] };
    const outputs: ReadonlyMap<string, unknown> = new Map([
      ["r", "reqVal"],
      ["opt", "optVal"],
    ]);

    // @ts-expect-error — branded ID test fixture
    const { result } = await runNodeShared(echoNode, "ignored", ctx, D("d"), outputs, incoming);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ r: "reqVal", opt: "optVal" });
  });

  it("optional deps absent → keyed object with undefined values", async () => {
    const incoming: IncomingSources = { required: ["r"], optional: ["missing"] };
    const outputs: ReadonlyMap<string, unknown> = new Map([["r", "reqVal"]]);

    // @ts-expect-error — branded ID test fixture
    const { result } = await runNodeShared(echoNode, "ignored", ctx, D("d"), outputs, incoming);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ r: "reqVal", missing: undefined });
    }
  });

  it("mixed required + optional → keyed object, optional undefined when absent", async () => {
    const incoming: IncomingSources = { required: ["a", "b"], optional: ["c"] };
    const outputs: ReadonlyMap<string, unknown> = new Map([
      ["a", 1],
      ["b", 2],
      // "c" deliberately absent
    ]);

    // @ts-expect-error — branded ID test fixture
    const { result } = await runNodeShared(echoNode, "ignored", ctx, D("d"), outputs, incoming);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: 2, c: undefined });
  });
});
