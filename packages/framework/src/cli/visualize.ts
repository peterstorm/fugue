// fugue visualize — render a DAG file as a Mermaid flowchart (deterministic-
// core convergence, Phase B4).
//
// `describedToMermaid` is a PURE function `DescribedDag → string`; the CLI
// wrapper reuses `runDescribe`, which imports the file via `importDagFile`
// (running `defineDag`'s structural validation). It does NOT re-run the
// `analyzeDag` schema checks `fugue lint` adds — a DAG with, say, a
// fan-in-key-mismatch fails lint but still visualizes (drawing the
// wrong-but-importable topology is often how the mistake is found). The JSON
// result carries the Mermaid text; `--raw` in the bin prints only the
// diagram for direct piping into docs.

import type { DescribedDag, DescribedEdge } from "../describe/index.js";
import { runDescribe } from "./describe.js";
import { LINE_TERMINATORS } from "./identifiers.js";
import { assertNever, type LintError } from "./types.js";

export type VisualizeResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly format: "mermaid";
      readonly diagram: string;
      /**
       * `runDescribe`'s non-fatal schema-serialization warnings, carried
       * through (the warnings-threading contract `DescribeResult` states:
       * in-process consumers never have to scrape stderr). Always an array,
       * empty when every schema serialized cleanly.
       */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly path: string; readonly errors: readonly LintError[] };

const INPUT_ID = "$input";

// Mermaid node ids must avoid `:`/`$` and other specials — map ids to safe
// tokens. Two properties the encoding must hold:
//   1. INJECTIVE — node ids may contain `_`, `:` and `-` (ID_REGEX), and
//      distinct ids must map to distinct Mermaid tokens (`a:b` and `a_b` must
//      never merge into one node). The escape scheme below (`_` doubles as
//      the lead-in, `:`/`-` get fixed 2-char escapes, anything else a
//      `_x<hex>_` escape) is decodable left-to-right, hence injective.
//   2. NAMESPACED — the `n_` prefix keeps real ids disjoint from the reserved
//      `dag_input` / `dag_output` virtual tokens (a node literally named
//      `dag_input` must not merge with the request node).
// Rendered labels still show the original id; only the token is encoded.
const escapeIdChar = (c: string): string =>
  c === "_" ? "__" : c === ":" ? "_c" : c === "-" ? "_d" : `_x${c.charCodeAt(0).toString(16)}_`;
const safeId = (id: string): string =>
  id === INPUT_ID ? "dag_input" : `n_${id.replace(/[^A-Za-z0-9]/g, escapeIdChar)}`;

// Labels sit inside Mermaid's double-quoted `["…"]` / `-->|"…"|` syntax: a `"`
// would close the quote, and a JS line terminator (`LINE_TERMINATORS` — the
// same single-sourced class the codegen comment scrub uses) would break the
// one-line node/edge statement. Neutralize both.
const escapeLabel = (s: string): string =>
  s.replace(/"/g, "&quot;").replace(LINE_TERMINATORS, " ");

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
    default:
      // The return type is inferred, so a missing case would otherwise fall
      // through to `undefined` silently — assertNever makes a new edge kind a
      // compile error here.
      return assertNever(e);
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
    warnings: described.warnings,
  };
};
