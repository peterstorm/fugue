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

  // ── The two branches a single happy-path test never reached ────────────────

  it("surfaces a topoSort failure as Err rather than a half-built payload", () => {
    // `buildDescribedDag`'s own doc says this is a registry/validator invariant
    // violation that "should never reach this code in practice" — which is
    // exactly the kind of branch that rots. `defineDagFromArray` refuses a
    // cyclic DAG at definition time, so the cycle is introduced afterwards, on
    // a already-branded DagDef, to reach the builder at all.
    const a = createTransformNode({
      id: "cycle-a",
      inputSchema: z.string(),
      outputSchema: z.string(),
      transform: (value) => ok(value),
    });
    const b = createTransformNode({
      id: "cycle-b",
      inputSchema: z.string(),
      outputSchema: z.string(),
      transform: (value) => ok(value),
    });
    const acyclic = defineDagFromArray({
      id: "cycle-dag",
      nodes: [a, b],
      edges: [
        { from: DAG_INPUT, to: "cycle-a" },
        { from: "cycle-a", to: "cycle-b" },
      ],
      outputNodeId: "cycle-b",
    });
    const cyclic = {
      ...acyclic,
      edges: [...acyclic.edges, { from: b.id, to: a.id, kind: "unconditional" as const }],
    } as typeof acyclic;

    const described = buildDescribedDag({
      dag: cyclic,
      inputSchema: z.string(),
      route: "/cycle",
      description: "cyclic",
      version: "1.0.0",
    });

    expect(described.ok).toBe(false);
    if (described.ok) return;
    expect(described.error.kind).toBe("cycle-detected");
  });

  it("renders a null outputSchema when outputNodeId names a node the DAG does not contain", () => {
    // The defensive `if (!node) return null` in `outputSchemaOf`. Reached the
    // same way: the id is rewritten on an already-branded DagDef, since the
    // definition-time validator would reject it.
    const orphaned = {
      ...dag,
      outputNodeId: "not-a-node",
    } as unknown as typeof dag;

    const described = buildDescribedDag({
      dag: orphaned,
      inputSchema: z.string(),
      route: "/orphan",
      description: "orphaned output node",
      version: "1.0.0",
    });

    // Non-fatal by design: an unresolvable output node degrades the DESCRIPTION
    // to a null schema rather than failing the describe endpoint outright.
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value.outputSchema).toBeNull();
    expect(described.value.inputSchema).not.toBeNull();
  });

  it("renders a null outputSchema when the DAG declares no output node", () => {
    const headless = { ...dag, outputNodeId: undefined } as unknown as typeof dag;

    const described = buildDescribedDag({
      dag: headless,
      inputSchema: z.string(),
      route: "/headless",
      description: "no output node",
      version: "1.0.0",
    });

    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value.outputSchema).toBeNull();
  });
});
