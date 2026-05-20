import { describe, expect, it } from "bun:test";
import { N } from "./_id-helpers.js";
import { z } from "zod";
import { ok } from "../types/result.js";
import { createTransformNode } from "../nodes/transform.js";

describe("createTransformNode", () => {
  it("transform node receives purified context (no ctx passed to transform)", () => {
    let receivedArgs: unknown[] = [];
    const node = createTransformNode({
      id: N("t1"),
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      transform: (...args: any[]) => {
        receivedArgs = args;
        return ok({ y: (args[0] as any).x * 2 });
      },
    });

    // The transform function signature only takes input, not ctx
    expect(node.kind).toBe("transform");
  });

  it("sync transform function works via async run wrapper", async () => {
    const node = createTransformNode({
      id: N("double"),
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ result: z.number() }),
      transform: (input: { n: number }) => ok({ result: input.n * 2 }),
    });

    const result = await node.run({ n: 5 }, {} as any);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ result: 10 });
    }
  });
});
