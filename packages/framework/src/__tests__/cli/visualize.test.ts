// fugue visualize (B4) — describedToMermaid is pure over DescribedDag; the
// invariants: every node appears exactly once, every edge renders with its
// kind's arrow, human-review gates are visually distinct, and a file that
// fails lint fails visualize with the same structured errors.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describedToMermaid, runVisualize } from "../../cli/visualize.js";
import { writeAuthoredScaffold } from "../../cli/new.js";
import { parseAuthoredDag } from "../../cli/authored.js";
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

  it("declares every node exactly once (n_-prefixed tokens, original ids in labels)", () => {
    expect(diagram.match(/n_classify\[/g)).toHaveLength(1);
    expect(diagram.match(/n_reply\{\{/g)).toHaveLength(1);
    expect(diagram).toContain("classify<br/>fetch");
  });

  it("renders each edge kind distinctly", () => {
    expect(diagram).toContain("dag_input --> n_classify");
    expect(diagram).toContain('n_classify -->|"is-billing (v2)"| n_reply');
    expect(diagram).toContain("n_classify -.->|default| n_reply");
  });

  it("marks human-review gates and the output node", () => {
    expect(diagram).toContain("[human review]");
    expect(diagram).toContain("class n_reply humanReview;");
    expect(diagram).toContain('n_reply --> dag_output(["output"])');
  });

  it("annotates capabilities in the title", () => {
    expect(diagram).toContain("capabilities: llm");
  });

  it("keeps distinct node ids distinct and clear of the reserved tokens", () => {
    // ID_REGEX allows `_`, `:` and `-` — the old sanitizer collapsed them all
    // to `_`, merging distinct nodes into one Mermaid id. The encoding must be
    // injective, and a node literally named `dag_input` must not merge with
    // the virtual request node.
    const node = (id: string) =>
      ({ id, kind: "fetch", sideEffects: "none", requires: [], humanReview: false }) as const;
    const d: DescribedDag = {
      ...described,
      outputNodeId: null,
      nodes: [node("a:b"), node("a_b"), node("a-b"), node("dag_input")],
      edges: [],
      waves: [["a:b", "a_b", "a-b", "dag_input"]],
    };
    const merged = describedToMermaid(d);
    expect(merged).toContain('n_a_cb["a:b<br/>fetch"]');
    expect(merged).toContain('n_a__b["a_b<br/>fetch"]');
    expect(merged).toContain('n_a_db["a-b<br/>fetch"]');
    expect(merged).toContain('n_dag__input["dag_input<br/>fetch"]');
    // Exactly four distinct declarations — nothing merged.
    expect(merged.match(/n_[A-Za-z0-9_]+\[/g)).toHaveLength(4);
  });
});

/** Scaffold a small valid DAG under tmpRoot and return its dag.ts path. */
const scaffoldVizDag = async (): Promise<string> => {
  // `AuthoredDag` is branded — parse the fixture (never cast).
  const authored = parseAuthoredDag({
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
  });
  if (!authored.ok) throw new Error(authored.problems.join("; "));
  const written = await writeAuthoredScaffold(authored.dag, { root: tmpRoot, force: true }, []);
  if (!written.ok) throw new Error(written.problems.join("; "));
  return join(written.dir, "dag.ts");
};

describe("runVisualize", () => {
  it("renders a real generated DAG and fails with lint errors for a broken file", async () => {
    const dagPath = await scaffoldVizDag();
    const good = await runVisualize(dagPath);
    expect(good.ok).toBe(true);
    if (good.ok) {
      // `-` encodes to `_d` (injective escape) and real ids get the n_ prefix;
      // the human-readable labels keep the original ids.
      expect(good.diagram).toContain("n_fetch_dx");
      expect(good.diagram).toContain("n_shape_dx");
      expect(good.diagram).toContain("fetch-x<br/>fetch");
    }

    const brokenPath = join(tmpRoot, "broken.ts");
    await Bun.write(brokenPath, "export default {};");
    const bad = await runVisualize(brokenPath);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.kind).toBe("missing-dag-field");
  });
});

// ---------------------------------------------------------------------------
// Bin subprocess contract for `--raw` — the one command whose success output
// is NOT JSON (the bare Mermaid text, for piping into docs).
// ---------------------------------------------------------------------------

const binPath = resolve(__dirname, "..", "..", "..", "bin", "fugue.ts");

const runBin = async (
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", binPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

describe("fugue visualize --raw (subprocess)", () => {
  it("prints the bare Mermaid diagram (no JSON) on stdout, exit 0", async () => {
    const dagPath = await scaffoldVizDag();
    const { exitCode, stdout, stderr } = await runBin(["visualize", dagPath, "--raw"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("flowchart TD");
    // Bare diagram, not the JSON envelope.
    expect(stdout.trimStart().startsWith("{")).toBe(false);
    expect(stdout).not.toContain('"ok"');
    expect(stderr).toBe("");
  });

  it("a raw failure goes to stderr as JSON with exit 1, stdout stays clean", async () => {
    const brokenPath = join(tmpRoot, "broken-raw.ts");
    await Bun.write(brokenPath, "export default {};");
    const { exitCode, stdout, stderr } = await runBin(["visualize", brokenPath, "--raw"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    const json = JSON.parse(stderr) as { ok: boolean; errors?: { kind: string }[] };
    expect(json.ok).toBe(false);
    expect(json.errors?.[0]?.kind).toBe("missing-dag-field");
  });

  it("--raw on a non-visualize command is a usage error (exit 2)", async () => {
    const dagPath = await scaffoldVizDag();
    const { exitCode, stderr } = await runBin(["lint", dagPath, "--raw"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unexpected extra arguments");
  });
});
