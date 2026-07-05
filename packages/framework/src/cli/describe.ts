// fugue describe — import a DAG file and emit a structured summary as JSON.
// Reuses `importDagFile` for the import + validation work, then delegates to the
// framework's shared `buildDescribedDag` so the CLI surface matches what
// `GET /dags/:id/manifest` returns (same node/edge/wave shapes).
//
// The describe shape is deliberately permissive: fields that aren't present
// on the default export (no `inputSchema`, no `outputNodeId`) come back as
// `null` rather than being omitted, so LLM tooling never has to branch on
// "field present vs missing" — only on the value.

import { formatFrameworkError } from "../types/errors.js";
import { buildDescribedDag } from "../describe/index.js";
import { importDagFile } from "./lint.js";
import type { DescribeResult, LintError } from "./types.js";

/**
 * Parse the registration's untyped `meta` record into the two fields describe
 * consumes, with the same defaults the manifest endpoint falls back to —
 * missing/mis-typed values degrade to the defaults, never throw.
 */
const parseRegistrationMeta = (
  raw: unknown,
): { readonly description: string; readonly version: string } => {
  const meta =
    raw !== null && typeof raw === "object" ? (raw as { description?: unknown; version?: unknown }) : {};
  return {
    description: typeof meta.description === "string" ? meta.description : "",
    version: typeof meta.version === "string" ? meta.version : "0.0.0",
  };
};

/**
 * Describe a DAG file. On success, returns the dag's id, route, schemas,
 * wave plan, prompts, and capabilities. On import/definition failure, returns
 * the same `LintError` shapes `importDagFile` produces (plus `describe-failed`
 * for assembly errors); lint-only analyzer checks (e.g. fan-in-key-mismatch)
 * are not re-run — see `DescribeResult`.
 */
export const runDescribe = async (path: string): Promise<DescribeResult> => {
  const imported = await importDagFile(path);
  if (!imported.ok) {
    return { ok: false, path: imported.path, errors: imported.errors };
  }

  const registration = imported.defaultExport;
  const dag = imported.dag;

  const route =
    typeof registration.route === "string"
      ? registration.route
      : `/dags/${dag.id}/run`;

  const { description, version } = parseRegistrationMeta(registration.meta);

  const schemaWarnings: string[] = [];
  const built = buildDescribedDag({
    dag,
    inputSchema: registration.inputSchema,
    route,
    description,
    version,
    warningSink: {
      onSchemaSerializationError: (where, e) => {
        const target =
          where.field === "outputSchema"
            ? `outputSchema (node '${where.nodeId}')`
            : "inputSchema";
        const msg = e instanceof Error ? e.message : String(e);
        schemaWarnings.push(`${target}: ${msg}`);
      },
    },
  });

  if (!built.ok) {
    const lintError: LintError = {
      kind: "describe-failed",
      message: `Failed to assemble describe payload: ${formatFrameworkError(built.error)}`,
      detail: built.error,
    };
    return { ok: false, path: imported.path, errors: [lintError] };
  }

  // Non-fatal schema serialization failures are surfaced on stderr so a
  // subprocess caller can capture them without contaminating the JSON
  // payload on stdout — AND carried on the machine-readable result's
  // `warnings` field so in-process consumers never have to scrape stderr.
  // The describe payload still ships with `null` in place of the affected
  // schema (consumers see this as "schema unavailable").
  if (schemaWarnings.length > 0) {
    for (const warning of schemaWarnings) {
      process.stderr.write(`[fugue describe] ${warning}\n`);
    }
  }

  return { ok: true, path: imported.path, dag: built.value, warnings: schemaWarnings };
};
