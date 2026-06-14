import { describe, expect, it } from "bun:test";
import { N } from "./_id-helpers.js";
import { z } from "zod";
import { ok } from "../types/result.js";
import { createTransformNode } from "../nodes/transform.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createHumanReviewNode, withHumanReview } from "../nodes/human-review.js";

describe("createHumanReviewNode", () => {
  const schema = z.object({ proposal: z.string() });

  it("attaches the humanReview gate with the given prompt", () => {
    const gate = createHumanReviewNode({ id: N("review"), schema, prompt: "Approve?" });
    expect(gate.humanReview).toEqual({ prompt: "Approve?" });
    expect(gate.kind).toBe("transform");
    expect(gate.requires).toEqual([]);
  });

  it("forwards its input unchanged (passthrough)", async () => {
    const gate = createHumanReviewNode({ id: N("review"), schema, prompt: "Approve?" });
    const input = { proposal: "Refund $25" };
    const result = await gate.run(input, {} as never);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(input);
  });

  it("uses the single schema for both input and output", () => {
    const gate = createHumanReviewNode({ id: N("review"), schema, prompt: "Approve?" });
    expect(gate.inputSchema).toBe(schema);
    expect(gate.outputSchema).toBe(schema);
  });

  it("rejects an empty or whitespace-only prompt at construction", () => {
    // The prompt is the gate's entire human-facing payload — a blank one is an
    // illegal "asks nothing" gate that must not be representable.
    expect(() => createHumanReviewNode({ id: N("review"), schema, prompt: "" })).toThrow(
      /non-empty/,
    );
    expect(() => createHumanReviewNode({ id: N("review"), schema, prompt: "   \n\t " })).toThrow(
      /non-empty/,
    );
  });
});

describe("withHumanReview", () => {
  it("gates an existing node while preserving kind, id, and behaviour", async () => {
    const base = createTransformNode({
      id: N("draft"),
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      transform: (input) => ok({ doubled: input.n * 2 }),
    });

    const gated = withHumanReview(base, { prompt: "Approve the draft?" });

    expect(gated.id).toBe(base.id);
    expect(gated.kind).toBe("transform");
    expect(gated.humanReview).toEqual({ prompt: "Approve the draft?" });
    // The original node's work is preserved — the gate is purely additive.
    expect(base.humanReview).toBeUndefined();
    const result = await gated.run({ n: 21 }, {} as never);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ doubled: 42 });
  });

  it("gates a node that does work (fetch) and keeps its requires", () => {
    const fetchNode = createFetchNode({
      id: N("load"),
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ id: z.string(), value: z.number() }),
      fetch: async (input) => ok({ id: input.id, value: 1 }),
    });

    const gated = withHumanReview(fetchNode, { prompt: "Approve the fetched record?" });
    expect(gated.kind).toBe("fetch");
    expect(gated.humanReview).toEqual({ prompt: "Approve the fetched record?" });
    expect(gated.requires).toEqual(fetchNode.requires);
  });

  it("rejects an empty prompt at construction", () => {
    const base = createTransformNode({
      id: N("draft"),
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      transform: (input) => ok(input),
    });
    expect(() => withHumanReview(base, { prompt: "  " })).toThrow(/non-empty/);
  });
});
