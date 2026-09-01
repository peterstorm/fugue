import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { buildDescribedDag } from "../describe/build-described-dag.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { createTransformNode } from "../nodes/transform.js";
import { DAG_INPUT } from "../types/ids.js";
import { ok } from "../types/result.js";

const node = createTransformNode({
  id: "describe-node",
  inputSchema: z.string(),
  outputSchema: z.string(),
  transform: (value) => ok(value),
});

const dag = defineDagFromArray({
  id: "describe-dag",
  nodes: [node],
  edges: [{ from: DAG_INPUT, to: "describe-node" }],
  outputNodeId: "describe-node",
});

describe("buildDescribedDag", () => {
  it("contains a throwing warning sink and returns the best-effort payload", () => {
    const schemaFailure = new Error("schema introspection failed");
    const hostileSchema = new Proxy(z.string(), {
      get(target, property, receiver) {
        if (property === "_zod") throw schemaFailure;
        return Reflect.get(target, property, receiver);
      },
    });
    let warnedWith: unknown;

    const described = buildDescribedDag({
      dag,
      inputSchema: hostileSchema,
      route: "/describe",
      description: "best effort",
      version: "1.0.0",
      warningSink: {
        onSchemaSerializationError: (_where, error) => {
          warnedWith = error;
          throw new Error("warning sink unavailable");
        },
      },
    });

    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(warnedWith).toBe(schemaFailure);
    expect(described.value.inputSchema).toBeNull();
    expect(described.value.outputSchema).not.toBeNull();
  });
});
