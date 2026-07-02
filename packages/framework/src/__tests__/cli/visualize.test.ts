// fugue visualize (B4) — describedToMermaid is pure over DescribedDag; the
// invariants: every node appears exactly once, every edge renders with its
// kind's arrow, human-review gates are visually distinct, and a file that
// fails lint fails visualize with the same structured errors.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describedToMermaid, runVisualize } from "../../cli/visualize.js";
import { writeAuthoredScaffold } from "../../cli/new.js";
import type { DescribedDag } from "../../describe/index.js";

const tmpRoot = resolve(__dirname, ".tmp-visualize");

beforeAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const described: DescribedDag = {
  id: "viz-demo",
  route: "/viz-demo",
  description: "demo",
  version: "1.0.0",
  inputSchema: null,
  outputSchema: null,
  outputNodeId: "reply",
  nodes: [
    { id: "classify", kind: "fetch", sideEffects: "none", requires: [], humanReview: false },
    { id: "reply", kind: "transform", sideEffects: "none", requires: [], humanReview: true },
  ],
  edges: [
    { from: "$input", to: "classify", kind: "unconditional" },
    { from: "classify", to: "reply", kind: "conditional", predicateLabel: "is-billing", predicateVersion: 2 },
    { from: "classify", to: "reply", kind: "default" },
  ],
  waves: [["classify"], ["reply"]],
  prompts: [],
  capabilities: ["llm"],
};

describe("describedToMermaid", () => {
  const diagram = describedToMermaid(described);

  it("declares every node exactly once", () => {
    expect(diagram.match(/classify\[/g)).toHaveLength(1);
    expect(diagram.match(/reply\{\{/g)).toHaveLength(1);
  });

  it("renders each edge kind distinctly", () => {
    expect(diagram).toContain("dag_input --> classify");
    expect(diagram).toContain('classify -->|"is-billing (v2)"| reply');
    expect(diagram).toContain("classify -.->|default| reply");
  });

  it("marks human-review gates and the output node", () => {
    expect(diagram).toContain("[human review]");
    expect(diagram).toContain("class reply humanReview;");
    expect(diagram).toContain('reply --> dag_output(["output"])');
  });

  it("annotates capabilities in the title", () => {
    expect(diagram).toContain("capabilities: llm");
  });
});

describe("runVisualize", () => {
  it("renders a real generated DAG and fails with lint errors for a broken file", async () => {
    const written = await writeAuthoredScaffold(
      {
        fugueAuthored: 1,
        name: "viz-roundtrip",
        team: "demo",
        description: "viz roundtrip",
        input: { fields: [{ name: "id", type: { kind: "string" } }] },
        nodes: [
          { id: "fetch-x", kind: "fetch", purpose: "x", output: { fields: [{ name: "x", type: { kind: "string" } }] } },
          { id: "shape-x", kind: "transform", purpose: "y", output: { fields: [{ name: "y", type: { kind: "string" } }] } },
        ],
        structure: { shape: "linear", order: ["fetch-x", "shape-x"] },
      },
      { root: tmpRoot, force: false },
    );
    if (!written.ok) throw new Error(written.problems.join("; "));

    const good = await runVisualize(join(written.dir, "dag.ts"));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.diagram).toContain("fetch_x");
      expect(good.diagram).toContain("shape_x");
    }

    const brokenPath = join(tmpRoot, "broken.ts");
    await Bun.write(brokenPath, "export default {};");
    const bad = await runVisualize(brokenPath);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.kind).toBe("missing-dag-field");
  });
});
