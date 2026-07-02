// fugue visualize — render a DAG file as a Mermaid flowchart (deterministic-
// core convergence, Phase B4).
//
// `describedToMermaid` is a PURE function `DescribedDag → string`; the CLI
// wrapper reuses `runDescribe` for the import + validation work, so a file
// that fails lint fails visualize with the same structured `errors[]`. The
// JSON result carries the Mermaid text; `--raw` in the bin prints only the
// diagram for direct piping into docs.

import type { DescribedDag, DescribedEdge } from "../describe/index.js";
import { runDescribe } from "./describe.js";
import type { LintError } from "./types.js";

export type VisualizeResult =
  | { readonly ok: true; readonly path: string; readonly format: "mermaid"; readonly diagram: string }
  | { readonly ok: false; readonly path: string; readonly errors: readonly LintError[] };

const INPUT_ID = "$input";

// Mermaid node ids must avoid `$` and other specials — map ids to safe tokens.
const safeId = (id: string): string => (id === INPUT_ID ? "dag_input" : id.replace(/[^A-Za-z0-9_]/g, "_"));

const escapeLabel = (s: string): string => s.replace(/"/g, "&quot;");

const edgeLine = (e: DescribedEdge): string => {
  const from = safeId(e.from);
  const to = safeId(e.to);
  switch (e.kind) {
    case "unconditional":
      return `    ${from} --> ${to}`;
    case "conditional":
      return `    ${from} -->|"${escapeLabel(e.predicateLabel)} (v${e.predicateVersion})"| ${to}`;
    case "default":
      return `    ${from} -.->|default| ${to}`;
  }
};

/**
 * Render a `DescribedDag` as a Mermaid flowchart. Nodes are labeled
 * `id + kind` (human-review gates get a distinct shape + class), conditional
 * edges carry their predicate label/version, the `$input` virtual source is
 * rendered when any edge references it, and capabilities are annotated on
 * the title line.
 */
export const describedToMermaid = (dag: DescribedDag): string => {
  const lines: string[] = [];

  const caps = dag.capabilities.length > 0 ? ` (capabilities: ${dag.capabilities.join(", ")})` : "";
  lines.push("---", `title: "${escapeLabel(`${dag.id}${caps}`)}"`, "---");
  lines.push("flowchart TD");

  if (dag.edges.some((e) => e.from === INPUT_ID)) {
    lines.push(`    dag_input(["$input (request)"])`);
  }

  for (const node of dag.nodes) {
    const label = escapeLabel(`${node.id}<br/>${node.kind}`);
    // Human-review gates suspend the run — render as a hexagon and tag the class.
    lines.push(
      node.humanReview
        ? `    ${safeId(node.id)}{{"${label} [human review]"}}`
        : `    ${safeId(node.id)}["${label}"]`,
    );
  }

  for (const edge of dag.edges) {
    lines.push(edgeLine(edge));
  }

  if (dag.outputNodeId !== null) {
    lines.push(`    ${safeId(dag.outputNodeId)} --> dag_output(["output"])`);
  }

  const reviewIds = dag.nodes.filter((n) => n.humanReview).map((n) => safeId(n.id));
  if (reviewIds.length > 0) {
    lines.push(`    classDef humanReview stroke-width:3px,stroke:#c00;`);
    lines.push(`    class ${reviewIds.join(",")} humanReview;`);
  }

  return lines.join("\n");
};

/** Visualize a DAG file. Wraps `runDescribe`; failures surface identically. */
export const runVisualize = async (path: string): Promise<VisualizeResult> => {
  const described = await runDescribe(path);
  if (!described.ok) {
    return { ok: false, path: described.path, errors: described.errors };
  }
  return {
    ok: true,
    path: described.path,
    format: "mermaid",
    diagram: describedToMermaid(described.dag),
  };
};
