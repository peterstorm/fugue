// Definition-time fan-in key validation in defineSources (deferred-fix remediation).
//
// defineSources wires N source nodes into a keyed `join` (and optional
// `assemble`). The runtime builds the fan-in input as an object keyed by the
// incoming node ids, so the join's `inputSchema` keys MUST equal that set. This
// suite proves defineSources rejects a mismatch at definition time — the same
// invariant `fugue lint` B1 enforces for manual DAGs — rather than deferring it
// to a runtime Zod parse failure.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import { createSourceNode } from "../nodes/fetch.js";
import { createTransformNode } from "../nodes/transform.js";
import { defineSources } from "../executor/define-sources.js";
import { DagDefinitionError } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";

const A = z.object({ a: z.number() });
const B = z.object({ b: z.number() });
const Req = z.object({ region: z.string() });

const srcA = createSourceNode({ id: "src-a", outputSchema: A, fetch: async () => ok({ a: 1 }) });
const srcB = createSourceNode({ id: "src-b", outputSchema: B, fetch: async () => ok({ b: 2 }) });

describe("defineSources — definition-time fan-in key validation", () => {
  it("accepts a join whose keys equal the source ids", () => {
    const join = createTransformNode({
      id: "join",
      inputSchema: z.object({ "src-a": A, "src-b": B }),
      outputSchema: z.object({ total: z.number() }),
      transform: (i) => ok({ total: i["src-a"].a + i["src-b"].b }),
    });
    expect(() =>
      defineSources({ id: "valid-sources", sources: [srcA, srcB], join }),
    ).not.toThrow();
  });

  it("throws DagDefinitionError when a join key is missing/typo'd", () => {
    const join = createTransformNode({
      id: "join",
      // keys {src-a, WRONG} vs incoming {src-a, src-b}
      inputSchema: z.object({ "src-a": A, WRONG: B }),
      outputSchema: z.object({ total: z.number() }),
      transform: (i) => ok({ total: i["src-a"].a }),
    });

    let thrown: unknown;
    try {
      defineSources({ id: "bad-sources", sources: [srcA, srcB], join });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DagDefinitionError);
    const err = thrown as DagDefinitionError;
    expect(err.dagId).toBe("bad-sources");
    expect(err.detail.kind).toBe("validation");
    expect(err.message).toContain("src-b"); // missing key for incoming source
    expect(err.message).toContain("WRONG"); // extra key with no source
  });

  it("accepts a join that declares the $input slot when it equals sources + $input", () => {
    const join = createTransformNode({
      id: "join",
      inputSchema: z.object({ "src-a": A, "src-b": B, [DAG_INPUT as string]: Req }),
      outputSchema: z.object({ total: z.number() }),
      transform: () => ok({ total: 0 }),
    });
    expect(() =>
      defineSources({ id: "input-sources", sources: [srcA, srcB], join }),
    ).not.toThrow();
  });

  it("rejects a join that declares $input as an OPTIONAL key", () => {
    // The DAG request is always delivered over the wired DAG_INPUT edge, so an
    // optional "$input" slot has no defined meaning. defineSources must reject it
    // at definition time rather than silently treating it as required.
    const join = createTransformNode({
      id: "join",
      inputSchema: z.object({ "src-a": A, "src-b": B, [DAG_INPUT as string]: Req.optional() }),
      outputSchema: z.object({ total: z.number() }),
      transform: () => ok({ total: 0 }),
    });
    let thrown: unknown;
    try {
      defineSources({ id: "optional-input-sources", sources: [srcA, srcB], join });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DagDefinitionError);
    const err = thrown as DagDefinitionError;
    expect(err.detail.kind).toBe("validation");
    expect(err.message).toContain("$input");
    expect(err.message).toContain("required");
  });

  it("throws when the assemble fan-in keys don't match (join + $input)", () => {
    const join = createTransformNode({
      id: "join",
      inputSchema: z.object({ "src-a": A, "src-b": B }),
      outputSchema: A,
      transform: () => ok({ a: 3 }),
    });
    const assemble = createTransformNode({
      id: "assemble",
      // declares $input (so the request edge is wired) → incoming {join, $input}
      // but keys are {join, NOPE} — mismatch on the $input slot.
      inputSchema: z.object({ join: A, NOPE: Req, [DAG_INPUT as string]: Req }),
      outputSchema: z.object({ done: z.boolean() }),
      transform: () => ok({ done: true }),
    });

    expect(() =>
      defineSources({ id: "assemble-bad", sources: [srcA, srcB], join, assemble }),
    ).toThrow(DagDefinitionError);
  });

  it("does not key-check a single source (bare value, <2 incoming)", () => {
    const join = createTransformNode({
      id: "join",
      // Single incoming source ⇒ bare value, NOT a keyed object — any schema ok.
      inputSchema: A,
      outputSchema: A,
      transform: (i) => ok(i),
    });
    expect(() =>
      defineSources({ id: "single-source", sources: [srcA], join }),
    ).not.toThrow();
  });

  it("rejects an assemble that declares $input as an OPTIONAL key", () => {
    // Mirror of the join-optional case for the second-stage fan-in: the
    // assertInputKeyRequired call on `assemble` (define-sources.ts) is otherwise
    // only covered transitively via the join path. Pin it directly.
    const join = createTransformNode({
      id: "join",
      inputSchema: z.object({ "src-a": A, "src-b": B }),
      outputSchema: A,
      transform: () => ok({ a: 3 }),
    });
    const assemble = createTransformNode({
      id: "assemble",
      inputSchema: z.object({ join: A, [DAG_INPUT as string]: Req.optional() }),
      outputSchema: z.object({ done: z.boolean() }),
      transform: () => ok({ done: true }),
    });
    let thrown: unknown;
    try {
      defineSources({ id: "assemble-optional-input", sources: [srcA, srcB], join, assemble });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DagDefinitionError);
    const err = thrown as DagDefinitionError;
    expect(err.detail.kind).toBe("validation");
    expect(err.message).toContain("assemble"); // the second-stage node, not the join
    expect(err.message).toContain("$input");
    expect(err.message).toContain("required");
  });

  it("throws when given zero sources (defensive guard over the NonEmptyNodeList type)", () => {
    const join = createTransformNode({
      id: "join",
      inputSchema: A,
      outputSchema: A,
      transform: (i) => ok(i),
    });
    let thrown: unknown;
    try {
      // The typed API forbids this (`sources: NonEmptyNodeList`); cast through
      // `unknown` to exercise the runtime guard that protects `as`-cast callers.
      defineSources({
        id: "empty-sources",
        sources: [] as unknown as Parameters<typeof defineSources>[0]["sources"],
        join,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DagDefinitionError);
    const err = thrown as DagDefinitionError;
    expect(err.dagId).toBe("empty-sources");
    expect(err.detail.kind).toBe("validation");
    expect(err.message).toContain("at least one source");
  });

  it("accepts an unverifiable (non-object) join schema with ≥2 sources, deferring to the runtime parse", () => {
    // `z.unknown()` isn't an introspectable object schema, so `fanInKeyCheck`
    // returns `unverifiable` and defineSources must NOT throw — the keyed fan-in
    // object is left to the runtime Zod parse rather than rejected at definition
    // time (mirrors `fugue lint` B1's "skips non-object input schemas").
    const join = createTransformNode({
      id: "join",
      inputSchema: z.unknown(),
      outputSchema: z.object({ total: z.number() }),
      transform: () => ok({ total: 0 }),
    });
    expect(() =>
      defineSources({ id: "unverifiable-sources", sources: [srcA, srcB], join }),
    ).not.toThrow();
  });
});
