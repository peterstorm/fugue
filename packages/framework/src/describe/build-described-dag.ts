// Shared describe assembly — produces the stable LLM-facing DAG contract used
// by both `fugue describe` (CLI) and `GET /dags/:id/manifest` (host). Keeping
// the assembly in one place prevents the two surfaces from drifting.
//
// Pure function: takes a branded `DagDef` plus optional context (registered
// prompts, input schema), returns either a `DescribedDag` or a structured
// `FrameworkError` if the DAG's topology can't be sorted (a registry/
// validator invariant violation, never expected in practice).

import { match } from "ts-pattern";
import type { z } from "zod";
import type { DagDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { topoSort } from "../shared/topo.js";
import { zodToJsonSchema } from "../llm/zod-schema.js";

// ---------------------------------------------------------------------------
// Public describe shape
// ---------------------------------------------------------------------------

/**
 * Per-node describe payload. Stable JSON contract — adding a field is a minor
 * version bump for LLM authoring consumers.
 */
export interface DescribedNode {
  readonly id: string;
  readonly kind: string;
  readonly sideEffects: string;
  readonly requires: readonly string[];
  readonly humanReview: boolean;
}

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
   * Authoritative set of prompts the host has loaded for this DAG. When
   * supplied, takes precedence over node introspection for the `prompts`
   * array. The CLI omits this (no host context); the host passes
   * `RegisteredDag.prompts`.
   */
  readonly loadedPrompts?: ReadonlyMap<string, string>;
  /** Optional sink for non-fatal warnings (schema serialization failures). */
  readonly warningSink?: DescribeWarningSink;
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
  if (!isZodSchema(schema)) return null;
  try {
    return zodToJsonSchema(schema);
  } catch (e) {
    // Surface the failure to the caller — describe stays best-effort but
    // never silently swallows the error.
    onError(e);
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

const describeEdge = (e: DagDef["edges"][number]): DescribedEdge =>
  match(e)
    .with({ kind: "unconditional" }, (edge) => ({
      from: edge.from as string,
      to: edge.to as string,
      kind: "unconditional" as const,
    }))
    .with({ kind: "conditional" }, (edge) => ({
      from: edge.from as string,
      to: edge.to as string,
      kind: "conditional" as const,
      predicateLabel: edge.when.label,
      predicateVersion: edge.when.version,
    }))
    .with({ kind: "default" }, (edge) => ({
      from: edge.from as string,
      to: edge.to as string,
      kind: "default" as const,
    }))
    .exhaustive();

const collectCapabilities = (dag: DagDef): string[] => {
  const set = new Set<string>();
  for (const node of dag.nodes) {
    for (const cap of node.requires as readonly string[]) set.add(cap);
  }
  return [...set].sort();
};

/**
 * Type-narrowed accessor for the `promptName` field on LLM-kind nodes. The
 * `createLlmNode` / `createLlmWithToolsNode` factories surface their prompt
 * name as a typed field; this predicate makes the read safe without an
 * `as unknown` cast at the call site.
 */
const readNodePromptName = (node: NodeDef<unknown, unknown>): string | null => {
  if (node.kind !== "llm") return null;
  const candidate = (node as { readonly promptName?: unknown }).promptName;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
};

const collectPromptNames = (
  dag: DagDef,
  loadedPrompts: ReadonlyMap<string, string> | undefined,
): string[] => {
  const set = new Set<string>();
  // When the host supplied its authoritative prompt set, seed from it first
  // — it's the ground truth for "what's actually been loaded for this DAG".
  if (loadedPrompts) {
    for (const name of loadedPrompts.keys()) set.add(name);
  }
  // Also walk nodes so the CLI (which has no host context) still surfaces
  // promptName references, and so the host's manifest stays honest if the
  // two surfaces drift.
  for (const node of dag.nodes) {
    const name = readNodePromptName(node);
    if (name !== null) set.add(name);
  }
  return [...set].sort();
};

const outputSchemaOf = (
  dag: DagDef,
  warningSink: DescribeWarningSink | undefined,
): Record<string, unknown> | null => {
  if (dag.outputNodeId === undefined) return null;
  const node = dag.nodes.find((n) => n.id === dag.outputNodeId);
  if (!node) return null;
  return safeZodToJsonSchema(node.outputSchema, (e) => {
    warningSink?.onSchemaSerializationError(
      { field: "outputSchema", nodeId: node.id as string },
      e,
    );
  });
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a `DescribedDag` from a branded `DagDef`. Returns `Err` only when the
 * DAG fails to topologically sort — a registry/validator invariant violation
 * that should never reach this code in practice, but is surfaced as a
 * structured `FrameworkError` instead of being swallowed silently.
 *
 * Non-fatal warnings (e.g. a Zod schema that `zodToJsonSchema` cannot render)
 * route through the optional `warningSink`; the returned payload sets the
 * affected field to `null`.
 */
export const buildDescribedDag = (
  input: BuildDescribedDagInput,
): Result<DescribedDag, FrameworkError> => {
  const { dag, warningSink } = input;
  const waves = topoSort(dag);
  if (!waves.ok) return err(waves.error);

  const waveIds: readonly (readonly string[])[] = waves.value.map((wave) =>
    wave.map((id) => id as string),
  );

  return ok({
    id: dag.id as string,
    route: input.route,
    description: input.description,
    version: input.version,
    inputSchema: safeZodToJsonSchema(input.inputSchema, (e) => {
      warningSink?.onSchemaSerializationError({ field: "inputSchema" }, e);
    }),
    outputSchema: outputSchemaOf(dag, warningSink),
    outputNodeId:
      dag.outputNodeId !== undefined ? (dag.outputNodeId as string) : null,
    nodes: dag.nodes.map(describeNode),
    edges: dag.edges.map(describeEdge),
    waves: waveIds,
    prompts: collectPromptNames(dag, input.loadedPrompts),
    capabilities: collectCapabilities(dag),
  });
};
