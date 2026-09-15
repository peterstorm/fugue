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
import { tryDagId, buildDescribedDag, formatFrameworkError, err, type FrameworkError, type Result } from "@fuguejs/framework";
import type { HostEnv } from "../env.js";
import type { LogPort } from "../../ports.js";
import { authorizeDagAccess } from "./dag-access.js";
import { errorResponse, hostUnavailableResponse } from "../response.js";
import type { DagManifestResponse } from "../response.js";
import { getRegistry } from "../../domain/host-state.js";
import { lookupDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";

// ---------------------------------------------------------------------------
// Pure assembly — delegates the per-DAG describe payload to the framework's
// shared builder so this surface stays in lockstep with `fugue describe`.
// ---------------------------------------------------------------------------

/**
 * Build a manifest payload from a `RegisteredDag` snapshot. Returns `Err`
 * only when the framework's describe assembly fails (a registry/validator
 * invariant violation — see `buildDescribedDag`). Exposed so tests can
 * exercise the shape without spinning up a Hono context.
 *
 * `onSchemaWarning`, when provided, is invoked for each NON-FATAL schema
 * serialization failure. The payload still ships with `null` in place of the
 * unrenderable schema (the documented LLM-tooling contract), but the caller can
 * log/observe the degradation instead of it vanishing silently — matching the
 * `fugue describe` CLI surface, which writes the same warnings to stderr. The
 * sink itself is always provided (describe requires the diagnostic channel);
 * when `onSchemaWarning` is absent the delivery is inert at this boundary.
 */
export const buildManifest = (
  registered: RegisteredDag,
  onSchemaWarning?: (message: string) => void,
): Result<DagManifestResponse, FrameworkError> => {
  const built = buildDescribedDag({
    dag: registered.dag,
    inputSchema: registered.inputSchema,
    route: registered.route,
    description: registered.meta.description,
    version: registered.meta.version,
    loadedPrompts: registered.prompts,
    warningSink: {
      onSchemaSerializationError: (where, e) => {
        const target =
          where.field === "outputSchema"
            ? `outputSchema (node '${where.nodeId}')`
            : "inputSchema";
        const msg = e instanceof Error ? e.message : String(e);
        onSchemaWarning?.(`${target}: ${msg}`);
      },
    },
  });

  if (!built.ok) return err(built.error);

  const described = built.value;
  return {
    ok: true,
    value: {
      ...described,
      team: registered.team,
      healthy: registered.status.kind === "healthy",
      sha: registered.sha,
      loadedAt: registered.loadedAt,
    },
  };
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface ManifestHandlerDeps {
  /** Logger — records non-fatal schema-serialization degradations server-side. Required so a degraded schema is always observable by default. */
  readonly logger: LogPort;
}

const assembleManifest = (
  c: Context<HostEnv>,
  onSchemaWarning?: (message: string) => void,
): Response => {
  const rawId = c.req.param("id") ?? "";
  const dagIdResult = tryDagId(rawId);
  if (!dagIdResult.ok) {
    return errorResponse(c, 400, "invalid-dag-id", `Invalid DAG ID '${rawId}': ${dagIdResult.error}`, {
      details: { raw: rawId },
    });
  }
  const dagId = dagIdResult.value;

  const hostState = c.get("hostState");
  const unavailable = hostUnavailableResponse(c, hostState);
  if (unavailable) return unavailable;

  // `canServeRequests` only returns true in phases that carry a registry, so
  // `getRegistry` must be defined here. Treat the absence as the framework
  // invariant violation it would be — 500, not a misleading 404.
  const registry = getRegistry(hostState);
  if (!registry) {
    return errorResponse(c, 500, "registry-missing", "Host state has no registry despite serving requests", {
      details: { phase: hostState.phase },
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
  // sensitive schema details (PII field names, internal model identifiers).
  const access = authorizeDagAccess(c, dagId, registered);
  if (!access.ok) return access.response;

  const built = buildManifest(registered, onSchemaWarning);
  if (!built.ok) {
    return errorResponse(c, 500, "manifest-build-failed",
      `Failed to assemble manifest for DAG '${dagId}': ${formatFrameworkError(built.error)}`,
      { dagId },
    );
  }
  return c.json(built.value, 200);
};

/**
 * Creates the manifest handler. The logger is required (not optional with an
 * empty default) so a degraded schema is always observable server-side by
 * default — the same degradations `fugue describe` writes to stderr — instead
 * of recreating the absent-vs-degraded indistinguishability the framework's
 * required warning sink designed away.
 */
export const createManifestHandler = (deps: ManifestHandlerDeps) =>
  (c: Context<HostEnv>): Response =>
    assembleManifest(c, (message) =>
      deps.logger?.warn(`[manifest] schema serialization degraded to null`, { detail: message }),
    );
