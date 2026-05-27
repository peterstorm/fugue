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
import { tryDagId, buildDescribedDag, formatFrameworkError } from "@fugue/framework";
import type { HostEnv } from "../router.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { canAccessDag } from "../../domain/auth.js";
import { errorResponse } from "../response.js";
import type { DagManifestResponse } from "../response.js";
import { canServeRequests, getRegistry } from "../../domain/host-state.js";
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
 */
export const buildManifest = (
  registered: RegisteredDag,
): { readonly ok: true; readonly value: DagManifestResponse }
   | { readonly ok: false; readonly errorMessage: string } => {
  const built = buildDescribedDag({
    dag: registered.dag,
    inputSchema: registered.inputSchema,
    route: registered.route,
    description: registered.meta.description,
    version: registered.meta.version,
    loadedPrompts: registered.prompts,
  });

  if (!built.ok) {
    return {
      ok: false,
      errorMessage: formatFrameworkError(built.error),
    };
  }

  const described = built.value;
  return {
    ok: true,
    value: {
      ...described,
      team: registered.team,
      healthy: registered.status.kind === "healthy",
      sha: registered.sha as string,
      loadedAt: registered.loadedAt,
    },
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

  const built = buildManifest(registered);
  if (!built.ok) {
    return errorResponse(c, 500, "manifest-build-failed",
      `Failed to assemble manifest for DAG '${dagId}': ${built.errorMessage}`,
      { dagId },
    );
  }
  return c.json(built.value, 200);
};
