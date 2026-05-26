/**
 * Manifest handler — GET /dags/:id/manifest
 *
 * Returns a stable, machine-readable summary of a registered DAG. Designed
 * for LLM authoring tools that compose against existing DAGs without reading
 * their source: it exposes input/output JSON Schemas, the resolved wave plan,
 * declared capabilities, and referenced prompts.
 *
 * Auth: same team-isolation rules as `POST /dags/:id/run` — a team token can
 * only manifest its own DAGs. Schemas can be sensitive (PII field names,
 * internal model identifiers); admin tokens see everything.
 */

import type { Context } from "hono";
import { tryDagId } from "@fugue/framework";
import type { DagDef, NodeDef } from "@fugue/framework";
import { zodToJsonSchema } from "@fugue/framework";
import type { z } from "zod";
import { topoSort } from "@fugue/framework/advanced";
import type { HostEnv } from "../router.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { canAccessDag } from "../../domain/auth.js";
import { errorResponse } from "../response.js";
import type {
  DagManifestEdge,
  DagManifestNode,
  DagManifestResponse,
} from "../response.js";
import { canServeRequests, getRegistry } from "../../domain/host-state.js";
import { lookupDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";

// ---------------------------------------------------------------------------
// Pure assembly helpers
// ---------------------------------------------------------------------------

const isZodSchema = (value: unknown): value is z.ZodType<unknown> =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { parse?: unknown }).parse === "function";

const safeZodToJsonSchema = (
  schema: unknown,
): Record<string, unknown> | null => {
  if (!isZodSchema(schema)) return null;
  try {
    // `zodToJsonSchema` is typed `ZodType<any>` at the framework seam; we
    // pass our narrowed `ZodType<unknown>` — sound because the helper only
    // reads the schema's structure.
    return zodToJsonSchema(schema);
  } catch {
    // A malformed schema is best-effort: the manifest still returns; consumers
    // see `null` and can decide to fall back to /dags listing.
    return null;
  }
};

const describeNode = (node: NodeDef<unknown, unknown>): DagManifestNode => ({
  id: node.id as string,
  kind: node.kind,
  sideEffects: node.sideEffects.kind,
  requires: [...(node.requires as readonly string[])],
  humanReview: node.humanReview !== undefined,
});

const describeEdge = (e: DagDef["edges"][number]): DagManifestEdge => {
  if (e.kind === "unconditional") {
    return { from: e.from as string, to: e.to as string, kind: "unconditional" };
  }
  if (e.kind === "conditional") {
    return {
      from: e.from as string,
      to: e.to as string,
      kind: "conditional",
      predicateLabel: e.when.label,
      predicateVersion: e.when.version,
    };
  }
  return { from: e.from as string, to: e.to as string, kind: "default" };
};

const collectCapabilities = (dag: DagDef): string[] => {
  const set = new Set<string>();
  for (const node of dag.nodes) {
    for (const cap of node.requires as readonly string[]) set.add(cap);
  }
  return [...set].sort();
};

const collectPromptNames = (
  dag: DagDef,
  loadedPrompts: ReadonlyMap<string, string>,
): string[] => {
  const set = new Set<string>();
  // Prefer the actually-loaded prompt set — it's the authoritative answer
  // to "what prompts does this DAG need?" The host already validates this
  // matches the LLM nodes' promptName references at load time.
  for (const name of loadedPrompts.keys()) set.add(name);
  // Also inspect nodes for promptName so manifests stay honest if a future
  // change drifts the two surfaces.
  for (const node of dag.nodes) {
    const maybe = (node as unknown as { promptName?: unknown }).promptName;
    if (typeof maybe === "string" && maybe.length > 0) set.add(maybe);
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
 * Build a manifest payload from a `RegisteredDag` snapshot. Pure — depends
 * only on the registered DAG passed in. Exposed so tests can exercise the
 * shape without spinning up a Hono context.
 */
export const buildManifest = (registered: RegisteredDag): DagManifestResponse => {
  const dag = registered.dag;
  const waves = topoSort(dag);
  const waveIds: readonly (readonly string[])[] = waves.ok
    ? waves.value.map((wave) => wave.map((id) => id as string))
    : [];

  return {
    id: registered.id as string,
    route: registered.route,
    description: registered.meta.description,
    version: registered.meta.version,
    team: registered.team,
    healthy: registered.status.kind === "healthy",
    sha: registered.sha as string,
    loadedAt: registered.loadedAt,
    inputSchema: safeZodToJsonSchema(registered.inputSchema),
    outputSchema: outputSchemaOf(dag),
    outputNodeId: dag.outputNodeId !== undefined ? (dag.outputNodeId as string) : null,
    nodes: dag.nodes.map(describeNode),
    edges: dag.edges.map(describeEdge),
    waves: waveIds,
    prompts: collectPromptNames(dag, registered.prompts),
    capabilities: collectCapabilities(dag),
  };
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const manifestHandler = (c: Context<HostEnv>): Response => {
  const rawId = c.req.param("id") ?? "";
  const dagIdResult = tryDagId(rawId);
  if (!dagIdResult.ok) {
    return errorResponse(c, 400, "invalid-dag-id", `Invalid DAG ID '${rawId}': ${dagIdResult.error}`, {
      details: { raw: rawId },
    });
  }
  const dagId = dagIdResult.value;

  const hostState = c.get("hostState");
  if (!canServeRequests(hostState)) {
    return errorResponse(c, 503, "host-unavailable", `Host is ${hostState.phase} — not accepting requests`, {
      details: { phase: hostState.phase },
    });
  }

  const registry = getRegistry(hostState);
  if (!registry) {
    return errorResponse(c, 404, "dag-not-found", `DAG '${dagId}' is not registered`, {
      dagId,
      details: { available: [] },
    });
  }

  const registered = lookupDag(registry, dagId);
  if (!registered) {
    const available = Array.from(registry.dags.keys());
    return errorResponse(c, 404, "dag-not-found", `DAG '${dagId}' is not registered`, {
      dagId,
      details: { available },
    });
  }

  // Team isolation: same model as POST /dags/:id/run. Manifests can leak
  // sensitive schema details (PII field names, internal model identifiers),
  // so a team token cannot manifest another team's DAGs.
  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  if (!identity) {
    return errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied");
  }
  if (!canAccessDag(identity, registered.team)) {
    const callerTeam = identity.kind === "team" ? identity.team : "admin";
    return errorResponse(c, 403, "forbidden",
      `Token for team '${callerTeam}' cannot access DAG '${dagId}' (owned by '${registered.team}')`,
      { dagId, details: { callerTeam, dagTeam: registered.team } },
    );
  }

  const manifest = buildManifest(registered);
  return c.json(manifest, 200);
};
