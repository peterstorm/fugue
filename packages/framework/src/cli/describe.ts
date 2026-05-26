// fugue describe — import a DAG file and emit a structured summary as JSON.
// Reuses `runLint` for the import + validation work, then walks the
// resolved DagDef + (optional) inputSchema to produce a stable describe
// payload.
//
// The describe shape is deliberately permissive: fields that aren't present
// on the default export (no `inputSchema`, no `outputNodeId`) come back as
// `null` rather than being omitted, so LLM tooling never has to branch on
// "field present vs missing" — only on the value.

import { z } from "zod";
import type { DagDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import { topoSort } from "../shared/topo.js";
import { zodToJsonSchema } from "../llm/zod-schema.js";
import { isUnconditionalEdge, isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import { importDagFile } from "./lint.js";
import type {
  DescribeResult,
  DescribedDag,
  DescribedEdge,
  DescribedNode,
} from "./types.js";

const isZodSchema = (value: unknown): value is z.ZodType<unknown> =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { parse?: unknown }).parse === "function";

const safeZodToJsonSchema = (
  schema: unknown,
): Record<string, unknown> | null => {
  if (!isZodSchema(schema)) return null;
  try {
    return zodToJsonSchema(schema);
  } catch {
    // A malformed schema shouldn't kill describe — surface a placeholder.
    // Lint already caught it if it was structurally invalid.
    return null;
  }
};

const describeNode = (node: NodeDef<unknown, unknown>): DescribedNode => ({
  id: node.id as string,
  kind: node.kind,
  sideEffects: node.sideEffects.kind,
  requires: [...(node.requires as readonly string[])],
  humanReview: node.humanReview !== undefined,
});

const describeEdge = (e: DagDef["edges"][number]): DescribedEdge => {
  if (isUnconditionalEdge(e)) {
    return { from: e.from as string, to: e.to as string, kind: "unconditional" };
  }
  if (isConditionalEdge(e)) {
    return {
      from: e.from as string,
      to: e.to as string,
      kind: "conditional",
      predicateLabel: e.when.label,
      predicateVersion: e.when.version,
    };
  }
  // isDefaultEdge guards the remaining variant — exhaustive narrowing.
  if (isDefaultEdge(e)) {
    return { from: e.from as string, to: e.to as string, kind: "default" };
  }
  // Unreachable; the EdgeDef union is closed.
  return { from: "", to: "", kind: "unconditional" };
};

const collectCapabilities = (dag: DagDef): string[] => {
  const set = new Set<string>();
  for (const node of dag.nodes) {
    for (const cap of node.requires as readonly string[]) set.add(cap);
  }
  return [...set].sort();
};

const collectPromptNames = (dag: DagDef): string[] => {
  const set = new Set<string>();
  for (const node of dag.nodes) {
    // LLM nodes carry a `promptName` field on their factory config; the
    // resulting NodeDef stores it under a private property. Inspecting the
    // node is best-effort — undefined access is silently skipped.
    const maybeName = (node as unknown as { promptName?: unknown }).promptName;
    if (typeof maybeName === "string" && maybeName.length > 0) set.add(maybeName);
  }
  return [...set].sort();
};

const outputSchemaOf = (dag: DagDef): Record<string, unknown> | null => {
  if (dag.outputNodeId === undefined) return null;
  const node = dag.nodes.find((n) => n.id === dag.outputNodeId);
  if (!node) return null;
  return safeZodToJsonSchema(node.outputSchema);
};

/**
 * Describe a DAG file. On success, returns the dag's id, route, schemas,
 * wave plan, prompts, and capabilities. On lint failure, returns the same
 * `errors[]` array `runLint` would have produced.
 */
export const runDescribe = async (path: string): Promise<DescribeResult> => {
  const imported = await importDagFile(path);
  if (!imported.ok) {
    return { ok: false, path: imported.path, errors: imported.errors };
  }

  const registration = imported.defaultExport;
  const dag = registration.dag as DagDef;

  const waves = topoSort(dag);
  const waveIds: readonly (readonly string[])[] = waves.ok
    ? waves.value.map((wave) => wave.map((id) => id as string))
    : [];

  const route =
    typeof registration.route === "string"
      ? registration.route
      : `/dags/${dag.id as string}/run`;

  const meta = registration.meta as { description?: unknown; version?: unknown } | undefined;
  const description = typeof meta?.description === "string" ? meta.description : "";
  const version = typeof meta?.version === "string" ? meta.version : "0.0.0";

  const described: DescribedDag = {
    id: dag.id as string,
    route,
    description,
    version,
    inputSchema: safeZodToJsonSchema(registration.inputSchema),
    outputSchema: outputSchemaOf(dag),
    outputNodeId: dag.outputNodeId !== undefined ? (dag.outputNodeId as string) : null,
    nodes: dag.nodes.map(describeNode),
    edges: dag.edges.map(describeEdge),
    waves: waveIds,
    prompts: collectPromptNames(dag),
    capabilities: collectCapabilities(dag),
  };

  return { ok: true, path: imported.path, dag: described };
};
