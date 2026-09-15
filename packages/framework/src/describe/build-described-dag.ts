// Shared describe assembly — produces the stable LLM-facing DAG contract used
// by both `fugue describe` (CLI) and `GET /dags/:id/manifest` (host). Keeping
// the assembly in one place prevents the two surfaces from drifting.
//
// Deterministic assembly with a caller-provided diagnostic callback: takes a
// branded `DagDef` plus context and returns either a `DescribedDag` or a
// structured `FrameworkError` for registry/validator invariant violations
// (unsortable topology, an `outputNodeId` naming an unknown node). Schema
// serialization warnings invoke the caller-provided sink while leaving the
// payload best-effort.

import { match } from "ts-pattern";
import type { z } from "zod";
import type { DagDef, DagNodeDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { topoSort } from "../shared/topo.js";
import { inventoryCapabilities, runtimeNodeInventory } from "../shared/runtime-node-inventory.js";
import { zodToJsonSchema } from "../llm/zod-schema.js";

// ---------------------------------------------------------------------------
// Public describe shape
// ---------------------------------------------------------------------------

/**
 * Per-node describe payload. Stable JSON contract — adding a field is a minor
 * version bump for LLM authoring consumers.
 */
interface DescribedNodeBase {
  readonly id: string;
  readonly sideEffects: string;
  readonly requires: readonly string[];
  readonly humanReview: boolean;
}

/**
 * Map-node describe payload. The child DAG's nodes and edges are projected
 * into the payload so manifest consumers see the mapped structure — the child
 * is not a separately registered DAG, so this payload is the only surface
 * carrying its contract. `childDagId` stays as the execution-addressing
 * reference; the top-level `waves` array remains outer-only (child execution
 * schedules as its own DAG invocation).
 */
export interface DescribedMap {
  readonly widthFrom: string;
  readonly maxWidth: number;
  readonly childDagId: string;
  readonly gather: Readonly<{ readonly kind: "collect"; readonly field: string }> | null;
  readonly childNodes: readonly DescribedNode[];
  readonly childEdges: readonly DescribedEdge[];
}

export type DescribedNode =
  | (DescribedNodeBase & {
      readonly kind: "map";
      readonly mapping: DescribedMap;
    })
  | (DescribedNodeBase & {
      readonly kind: Exclude<DagNodeDef["kind"], "map">;
      readonly mapping?: never;
    });

/**
 * Per-edge describe payload — discriminated on `kind`. The conditional
 * variant carries the predicate's label and version so consumers can
 * reason about routing without parsing prose.
 */
export type DescribedEdge =
  | { readonly from: string; readonly to: string; readonly kind: "unconditional" }
  | {
      readonly from: string;
      readonly to: string;
      readonly kind: "conditional";
      readonly predicateLabel: string;
      readonly predicateVersion: number;
    }
  | { readonly from: string; readonly to: string; readonly kind: "default" };

/**
 * Stable describe payload. Identical fields appear in `fugue describe` and
 * `GET /dags/:id/manifest`; the host wraps this with team metadata.
 *
 * Fields that are not present on the source DAG (no `inputSchema`, no
 * `outputNodeId`) come back as `null` rather than being omitted, so LLM
 * tooling never has to branch on "field present vs missing".
 */
export interface DescribedDag {
  readonly id: string;
  readonly route: string;
  readonly description: string;
  readonly version: string;
  readonly inputSchema: Record<string, unknown> | null;
  readonly outputSchema: Record<string, unknown> | null;
  readonly outputNodeId: string | null;
  readonly nodes: readonly DescribedNode[];
  readonly edges: readonly DescribedEdge[];
  readonly waves: readonly (readonly string[])[];
  readonly prompts: readonly string[];
  readonly capabilities: readonly string[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Optional sink for non-fatal schema-serialization failures. The describe
 * payload still returns (with `null` in place of the bad schema), but the
 * caller can log/observe the failure instead of silently swallowing it.
 */
export interface DescribeWarningSink {
  readonly onSchemaSerializationError: (
    where:
      | { readonly field: "inputSchema" }
      | { readonly field: "outputSchema"; readonly nodeId: string },
    err: unknown,
  ) => void;
}

export interface BuildDescribedDagInput {
  readonly dag: DagDef;
  /** Caller-supplied input schema (typically from the DagRegistration). */
  readonly inputSchema?: unknown;
  readonly route: string;
  readonly description: string;
  readonly version: string;
  /**
   * Prompts the host loaded for this DAG. Describe unions these keys with
   * node-introspected prompt names so omissions on either surface stay visible.
   * The CLI omits this (no host context); the host passes `RegisteredDag.prompts`.
   */
  readonly loadedPrompts?: ReadonlyMap<string, string>;
  /**
   * Sink for non-fatal warnings (schema serialization failures). Required so
   * a degraded schema is always observable somewhere — a no-sink call would
   * make the `null` in place of the bad schema indistinguishable from an
   * absent one. Fixtures that do not assert on warnings pass an inert sink.
   */
  readonly warningSink: DescribeWarningSink;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const isZodSchema = (value: unknown): value is z.ZodType<unknown> =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { parse?: unknown }).parse === "function";

const safeZodToJsonSchema = (
  schema: unknown,
  onError: (e: unknown) => void,
): Record<string, unknown> | null => {
  if (schema === undefined) return null;
  try {
    if (!isZodSchema(schema)) {
      throw new TypeError("expected a Zod schema");
    }
    return zodToJsonSchema(schema);
  } catch (e) {
    // Warning delivery is diagnostic-only. A broken sink cannot replace the
    // schema failure or break describe's best-effort Result boundary.
    try {
      onError(e);
    } catch {
      // No secondary channel exists here; the null schema remains authoritative.
    }
    return null;
  }
};

const describeNode = (
  node: DagDef["nodes"][number],
): DescribedNode => {
  const base: DescribedNodeBase = {
    id: node.id,
    sideEffects: node.sideEffects.kind,
    requires: [...(node.requires as readonly string[])],
    humanReview: node.humanReview !== undefined,
  };
  if (node.kind !== "map") return { ...base, kind: node.kind };
  return {
    ...base,
    kind: "map",
    mapping: {
      widthFrom: node.mapping.widthFrom,
      maxWidth: node.mapping.maxWidth,
      childDagId: node.mapping.child.id,
      gather: node.mapping.authoredGather === undefined
        ? null
        : Object.freeze({
            kind: node.mapping.authoredGather.kind,
            field: node.mapping.authoredGather.field,
          }),
      // Projected so manifest consumers see the mapped structure: the child
      // is not a separately registered DAG, so this payload is the only
      // surface carrying its contract. The recursion is defensive — nested
      // maps are rejected at map construction and validation, so nested-map
      // describe is not a supported input path.
      childNodes: node.mapping.child.nodes.map(describeNode),
      childEdges: node.mapping.child.edges.map(describeEdge),
    },
  };
};

const describeEdge = (e: DagDef["edges"][number]): DescribedEdge =>
  match(e)
    .with({ kind: "unconditional" }, (edge) => ({
      from: edge.from,
      to: edge.to,
      kind: "unconditional" as const,
    }))
    .with({ kind: "conditional" }, (edge) => ({
      from: edge.from,
      to: edge.to,
      kind: "conditional" as const,
      predicateLabel: edge.when.label,
      predicateVersion: edge.when.version,
    }))
    .with({ kind: "default" }, (edge) => ({
      from: edge.from,
      to: edge.to,
      kind: "default" as const,
    }))
    .exhaustive();

/**
 * Type-narrowed accessor for the `promptName` field on LLM-kind nodes. The
 * `createLlmNode` / `createLlmWithToolsNode` factories surface their prompt
 * name as a typed field; this predicate makes the read safe without an
 * `as unknown` cast at the call site.
 */
const readNodePromptName = (
  node: DagDef["nodes"][number],
): string | null => {
  if (node.kind !== "llm") return null;
  const candidate = (node as { readonly promptName?: unknown }).promptName;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
};

const collectPromptNames = (
  nodes: DagDef["nodes"],
  loadedPrompts: ReadonlyMap<string, string> | undefined,
): string[] => {
  const set = new Set<string>();
  // Seed from the host-loaded prompt set when available, then augment it with
  // node-introspected references below so omissions on either surface remain visible.
  if (loadedPrompts) {
    for (const name of loadedPrompts.keys()) set.add(name);
  }
  // Also walk nodes so the CLI (which has no host context) still surfaces
  // promptName references, and so the host's manifest stays honest if the
  // two surfaces drift.
  for (const node of nodes) {
    const name = readNodePromptName(node);
    if (name !== null) set.add(name);
  }
  return [...set].sort();
};

const outputSchemaOf = (
  node: DagDef["nodes"][number],
  warningSink: DescribeWarningSink,
): Record<string, unknown> | null =>
  safeZodToJsonSchema(node.outputSchema, (e) => {
    warningSink.onSchemaSerializationError(
      { field: "outputSchema", nodeId: node.id },
      e,
    );
  });

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a `DescribedDag` from a branded `DagDef`. Returns `Err` for two
 * registry/validator invariant violations that should never reach this code in
 * practice, but are surfaced as structured `FrameworkError`s instead of being
 * swallowed silently: an unsortable topology (like `topoSort` itself) and an
 * `outputNodeId` that names a node the DAG does not contain — degrading that
 * to a payload would emit an `outputNodeId` pointing at a nonexistent node.
 *
 * Non-fatal warnings (e.g. a Zod schema that `zodToJsonSchema` cannot render)
 * route through the caller-provided `warningSink`; the returned payload sets
 * the affected field to `null`.
 */
export const buildDescribedDag = (
  input: BuildDescribedDagInput,
): Result<DescribedDag, FrameworkError> => {
  const { dag, warningSink } = input;
  const waves = topoSort(dag);
  if (!waves.ok) return err(waves.error);
  const outputNode =
    dag.outputNodeId === undefined
      ? null
      : dag.nodes.find((n) => n.id === dag.outputNodeId) ?? null;
  if (outputNode === null && dag.outputNodeId !== undefined) {
    return err({
      kind: "validation" as const,
      nodeId: dag.outputNodeId,
      message: `outputNodeId references unknown node '${dag.outputNodeId}'`,
    });
  }
  const runtimeNodes = runtimeNodeInventory(dag).nodes;

  return ok({
    id: dag.id,
    route: input.route,
    description: input.description,
    version: input.version,
    inputSchema: safeZodToJsonSchema(input.inputSchema, (e) => {
      warningSink.onSchemaSerializationError({ field: "inputSchema" }, e);
    }),
    outputSchema:
      outputNode === null ? null : outputSchemaOf(outputNode, warningSink),
    outputNodeId:
      dag.outputNodeId !== undefined ? dag.outputNodeId : null,
    nodes: dag.nodes.map(describeNode),
    edges: dag.edges.map(describeEdge),
    waves: waves.value,
    prompts: collectPromptNames(runtimeNodes, input.loadedPrompts),
    capabilities: inventoryCapabilities(dag),
  });
};
