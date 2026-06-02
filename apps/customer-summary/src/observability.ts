/**
 * Pure resolver: app `Config` → resolved observability backend selection.
 *
 * This is the FUNCTIONAL CORE for observability wiring. It takes the zod-parsed
 * {@link Config} and produces a validated {@link ResolvedObservability} value (or
 * a typed {@link ObservabilityConfigError}). NO I/O, NO env reads, NO Azure — it
 * is a total function of its `Config` argument and is therefore trivially unit
 * testable. The imperative shell (`bootstrap.ts`) consumes the result to
 * build the actual `SpanExporter` instances.
 *
 * Requirements satisfied:
 * - FR-002: one trace backend = exclusive, two = dual export.
 * - FR-003: MLflow is the default trace backend (no foundry selected).
 * - FR-006: contradictory/invalid selection fails CLOSED with a typed error.
 * - FR-022: default auth = Application Insights connection string.
 * - FR-023: opt-in Entra ID via the default Azure credential mechanism.
 *
 * Note on shapes vs. the plan: the plan sketched a FLAT `ResolvedObservability`
 * with an always-present `auth`. Per CLAUDE.md ("make illegal states
 * unrepresentable") this instead models the result as a DISCRIMINATED UNION on
 * `kind`: the `with-foundry` arm carries a non-null `auth`; the `mlflow-only`
 * arm has no `auth` field at all. A foundry-enabled value without auth — and an
 * auth attached to a non-foundry selection — are both literally unconstructable.
 * The foundry-enabled fact is the discriminant itself ({@link isFoundryEnabled}
 * narrows on `kind`), not a separate boolean that could drift from `traceBackends`.
 */
import type { Config, TraceBackend, TraceBackends } from "./config.js";
import { type Result, ok, err } from "@fugue/framework";

export type { TraceBackend, TraceBackends };

/**
 * Resolved auth for the Foundry (Application Insights) exporter.
 *
 * Both modes carry the connection string: the Azure Monitor SDK needs it to
 * locate the ingestion endpoint even under Entra ID. In
 * connection-string mode the string also governs auth; in entra-id mode a
 * `DefaultAzureCredential` (constructed in the app bootstrap) governs auth while
 * the connection string supplies the endpoint.
 */
export type ResolvedAuth =
  | { readonly mode: "connection-string"; readonly connectionString: string }
  | { readonly mode: "entra-id"; readonly connectionString: string };

/**
 * Resolved observability backend selection, as a DISCRIMINATED UNION on `kind`:
 *
 * - `mlflow-only` — no foundry backend selected. There is NO `auth` field, so
 *   "foundry off but auth present" cannot be expressed.
 * - `with-foundry` — a foundry backend is selected; `auth` is REQUIRED and
 *   non-null. So "foundry on but auth missing" cannot be expressed either.
 *
 * Both illegal states are unrepresentable by construction (CLAUDE.md), and
 * foundry-enabled is the discriminant itself rather than a derived boolean.
 */
export type ResolvedObservability =
  | { readonly kind: "mlflow-only"; readonly traceBackends: TraceBackends }
  | {
      readonly kind: "with-foundry";
      readonly traceBackends: TraceBackends;
      readonly auth: ResolvedAuth;
    };

/**
 * Foundry is enabled iff the resolved selection is the `with-foundry` arm. The
 * type guard narrows to that arm, exposing the non-null `auth` to callers — the
 * single source of truth, with no boolean that could drift from `traceBackends`.
 */
export const isFoundryEnabled = (
  r: ResolvedObservability,
): r is Extract<ResolvedObservability, { kind: "with-foundry" }> => r.kind === "with-foundry";

/**
 * Typed, discriminated configuration error so callers/tests branch on the
 * `reason`, not on parsed message strings.
 *
 * - `missing-connection-string`: foundry is selected but no Application Insights
 *   connection string is available for the resolved auth mode (FR-006/FR-022).
 *   In well-formed config this is caught earlier by the zod `superRefine`, but
 *   the resolver re-checks defense-in-depth (a `Config` built by hand in a test,
 *   or any future bypass of `loadConfig`, still fails closed here).
 */
export type ObservabilityConfigErrorCause = "missing-connection-string";

export class ObservabilityConfigError extends Error {
  readonly reason: ObservabilityConfigErrorCause;
  constructor(reason: ObservabilityConfigErrorCause, message: string) {
    super(message);
    this.name = "ObservabilityConfigError";
    this.reason = reason;
  }
}

/**
 * Pure resolver. `Config -> Result<ResolvedObservability, ObservabilityConfigError>`.
 *
 * - No foundry selected → `{ kind: 'mlflow-only', traceBackends }` (FR-003).
 *   The `mlflow-only` arm has no `auth`, so {@link isFoundryEnabled} is `false`.
 * - Foundry selected → requires a connection string for BOTH auth modes
 *   (FR-022/FR-023; the connection string carries the ingestion endpoint).
 *   Missing → fail-closed `ObservabilityConfigError` (FR-006).
 */
export const resolveObservabilityBackends = (
  config: Config,
): Result<ResolvedObservability, ObservabilityConfigError> => {
  const traceBackends = config.OBSERVABILITY_TRACE_BACKENDS;
  const foundryEnabled = traceBackends.includes("foundry");

  if (!foundryEnabled) {
    return ok({ kind: "mlflow-only", traceBackends });
  }

  const connectionString = config.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (connectionString === undefined) {
    return err(
      new ObservabilityConfigError(
        "missing-connection-string",
        "Foundry trace backend is selected but no Application Insights connection string is configured. " +
          "Set APPLICATIONINSIGHTS_CONNECTION_STRING (required for both connection-string and entra-id auth modes).",
      ),
    );
  }

  const auth: ResolvedAuth =
    config.AZURE_AUTH_MODE === "entra-id"
      ? { mode: "entra-id", connectionString }
      : { mode: "connection-string", connectionString };

  return ok({ kind: "with-foundry", traceBackends, auth });
};
