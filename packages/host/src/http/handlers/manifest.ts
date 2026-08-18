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
import { tryDagId, buildDescribedDag, formatFrameworkError } from "@fuguejs/framework";
import type { HostEnv } from "../env.js";
import type { LogPort } from "../../ports.js";
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
 *
 * `onSchemaWarning`, when provided, is invoked for each NON-FATAL schema
 * serialization failure. The payload still ships with `null` in place of the
 * unrenderable schema (the documented LLM-tooling contract), but the caller can
 * log/observe the degradation instead of it vanishing silently — matching the
 * `fugue describe` CLI surface, which writes the same warnings to stderr.
 */
export const buildManifest = (
  registered: RegisteredDag,
  onSchemaWarning?: (message: string) => void,
): { readonly ok: true; readonly value: DagManifestResponse }
   | { readonly ok: false; readonly errorMessage: string } => {
  const built = buildDescribedDag({
    dag: registered.dag,
    inputSchema: registered.inputSchema,
    route: registered.route,
    description: registered.meta.description,
    version: registered.meta.version,
    loadedPrompts: registered.prompts,
    ...(onSchemaWarning
      ? {
          warningSink: {
            onSchemaSerializationError: (where, e) => {
              const target =
                where.field === "outputSchema"
                  ? `outputSchema (node '${where.nodeId}')`
                  : "inputSchema";
              const msg = e instanceof Error ? e.message : String(e);
              onSchemaWarning(`${target}: ${msg}`);
            },
          },
        }
      : {}),
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

interface ManifestHandlerDeps {
  /** Optional logger — records non-fatal schema-serialization degradations server-side. */
  readonly logger?: LogPort;
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
    // `user` identities are refusable too (canRunDag policy) — name the kind
    // honestly rather than mislabelling a refused user as "admin".
    const callerTeam = identity.kind === "team" ? identity.team : identity.kind;
    return errorResponse(c, 403, "forbidden",
      `Token for team '${callerTeam}' cannot access DAG '${dagId}' (owned by '${registered.team}')`,
      { dagId, details: { callerTeam, dagTeam: registered.team } },
    );
  }

  const built = buildManifest(registered, onSchemaWarning);
  if (!built.ok) {
    return errorResponse(c, 500, "manifest-build-failed",
      `Failed to assemble manifest for DAG '${dagId}': ${built.errorMessage}`,
      { dagId },
    );
  }
  return c.json(built.value, 200);
};

/**
 * Creates the manifest handler. Injecting the logger (rather than exporting a
 * bare function) lets the handler surface non-fatal schema-serialization
 * warnings server-side — the same degradations `fugue describe` writes to
 * stderr — instead of emitting a `null` schema with no host-side trace.
 */
export const createManifestHandler = (deps: ManifestHandlerDeps = {}) =>
  (c: Context<HostEnv>): Response =>
    assembleManifest(c, (message) =>
      deps.logger?.warn(`[manifest] schema serialization degraded to null`, { detail: message }),
    );
