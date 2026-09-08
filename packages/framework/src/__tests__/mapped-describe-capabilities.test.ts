import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { buildDescribedDag, createFetchNode, createMapNode, defineDag, runDag, DAG_INPUT, ok } from "../index.js";
import { runDescribe } from "../cli/describe.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import type { Capability } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { Invocation } from "../types/capability-broker.js";

const customCapability = "describe-test:read";
declare module "../types/node.js" {
  interface CapabilityRegistry {
    readonly "describe-test:read": { readonly read: (n: number) => number };
  }
}

const registrationMeta = { route: "/mapped/run", description: "Mapped authority", version: "1.0.0" };
const described = (dag: DagDef) => {
  const result = buildDescribedDag({ dag, ...registrationMeta });
  if (!result.ok) throw new Error("fixture description failed");
  return result.value;
};

const fixture = (first: readonly Capability[], second: readonly Capability[] = first) => {
  const executions: string[] = [];
  const node = (id: string, requires: readonly Capability[]) => createFetchNode({
    id, inputSchema: z.number(), outputSchema: z.number(), requires,
    fetch: async n => { executions.push(id); return ok(n * 2); },
  });
  const child = defineDag({ id: "child", nodes: { first: node("first", first), second: node("second", second) },
    edges: [{ from: DAG_INPUT, to: "first" }, { from: "first", to: "second" }], outputNodeId: "second" });
  const itemsSchema = z.object({ items: z.array(z.number()) });
  const fan = createMapNode({ id: "fan", inputSchema: itemsSchema, outputSchema: z.array(z.number()),
    widthFrom: "items", maxWidth: 4, child, childOutputSchema: z.number(), reduce: xs => ok([...xs]) });
  const pre = createFetchNode({ id: "pre", inputSchema: itemsSchema, outputSchema: itemsSchema, requires: ["clock"],
    fetch: async x => { executions.push("pre"); return ok(x); } });
  const dag = defineDag({ id: "outer", nodes: { pre, fan },
    edges: [{ from: DAG_INPUT, to: "pre" }, { from: "pre", to: "fan" }], outputNodeId: "fan" });
  return { dag, child, fan, executions };
};

describe("mapped descriptions share the bounded runtime capability inventory", () => {
  it("includes child-only builtin/custom requirements without projecting children or hoisting map permissions", () => {
    const { dag, fan } = fixture([customCapability, "cache"], ["clock", customCapability]);
    const result = described(dag);
    expect(result.capabilities).toEqual(["cache", "checkpointer", "clock", customCapability]);
    expect(result.nodes.map(n => n.id)).toEqual(["pre", "fan"]);
    expect(result.nodes.find(n => n.id === "fan")?.requires).toEqual(["checkpointer"]);
    expect(fan.requires).toEqual(["checkpointer"]);
    expect(result.waves).toEqual([["pre"], ["fan"]]);
    expect(result.edges).toHaveLength(2);
    expect(described(dag)).toEqual(result);
  });

  it("deduplicates/sorts independently of child requirement order and leaves ordinary DAGs unchanged", () => {
    const requirements = fc.array(fc.constantFrom<Capability>("cache", "clock", customCapability));
    fc.assert(fc.property(requirements, requirements, (first, second) => {
      const { dag, child } = fixture(first, second);
      const expectedChild = [...new Set([...first, ...second])].sort();
      expect(described(child).capabilities).toEqual(expectedChild);
      expect(described(dag).capabilities).toEqual([...new Set(["clock", "checkpointer", ...expectedChild])].sort());
      const reordered = fixture([...second].reverse(), [...first].reverse());
      expect(described(reordered.dag).capabilities).toEqual(described(dag).capabilities);
    }));
  });

  it.each([0, 1])("describes and preflights static child requirements at width %s while minting per child", async width => {
    const { dag, executions } = fixture([customCapability, "clock"], [customCapability]);
    const summary = described(dag);
    const claims: Capability[] = [];
    const mints: { readonly invocation: Invocation; readonly requires: readonly Capability[] }[] = [];
    const ctx = makeNodeContext({ runId: `describe-width-${width}`, dagId: "outer", capabilities: {
      checkpointer: new InMemoryCheckpointer(), clock: { now: () => new Date(0) },
    } });
    const input = { items: Array.from({ length: width }, () => 2) };
    expect(await runDag(dag, input, ctx)).toMatchObject({ ok: false, error: { kind: "missing-capability", missing: [
      { nodeId: "first", capability: customCapability }, { nodeId: "second", capability: customCapability },
    ] } });
    expect(executions).toEqual([]);
    expect(await runDag(dag, input, ctx, { minting: {
      origin: { kind: "agent", agentClientId: "describe-client" },
      meterLlm: (_cap, binding) => ok(binding.client),
      broker: {
        provides: cap => { claims.push(cap); return cap === customCapability; },
        mintFor: async (invocation, requires) => {
          mints.push({ invocation, requires });
          return requires.includes(customCapability)
            ? ok({ [customCapability]: { clientKind: "non-llm", client: { read: (n: number) => n } } })
            : ok({});
        },
      },
    } })).toEqual(ok(width === 0 ? [] : [8]));
    expect(claims.map(String).sort()).toEqual([...summary.capabilities]);
    expect(mints.map(({ invocation, requires }) => [String(invocation.dagId), String(invocation.nodeId), requires.map(String)])).toEqual([
      ["outer", "pre", ["clock"]], ["outer", "fan", ["checkpointer"]],
      ...(width === 0 ? [] : [["child", "first", [customCapability, "clock"]], ["child", "second", [customCapability]]]),
    ]);
    expect(described(dag)).toEqual(summary);
  });

  it("the actual CLI registration import emits the manifest builder's complete capability union", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fugue-mapped-describe-"));
    const path = join(directory, "dag.ts");
    const entry = resolve(__dirname, "../index.ts");
    const zod = require.resolve("zod");
    try {
      await writeFile(path, `
        import { createFetchNode, createMapNode, defineDag, DAG_INPUT, ok } from ${JSON.stringify(entry)};
        import { z } from ${JSON.stringify(zod)};
        const work = createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(),
          requires: ["clock", "describe-test:read"], fetch: async n => ok(n) });
        const child = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
        const fan = createMapNode({ id: "fan", inputSchema: z.object({ items: z.array(z.number()) }), outputSchema: z.array(z.number()),
          widthFrom: "items", maxWidth: 4, child, childOutputSchema: z.number(), reduce: xs => ok([...xs]) });
        export default { dag: defineDag({ id: "outer", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" }),
          route: "/mapped/run", meta: { description: "Mapped authority", version: "1.0.0" } };
      `);
      const result = await runDescribe(path);
      expect(result).toMatchObject({ ok: true, dag: {
        ...registrationMeta, capabilities: ["checkpointer", "clock", customCapability],
        nodes: [{ id: "fan", requires: ["checkpointer"] }], waves: [["fan"]],
      } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
