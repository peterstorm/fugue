/**
 * Pure resolver: app `Config` → resolved observability backend selection.
 *
 * This is the FUNCTIONAL CORE for observability wiring. It takes the zod-parsed
 * {@link Config} and produces a validated {@link ResolvedObservability} value (or
 * a typed {@link ObservabilityConfigError}). NO I/O, NO env reads, NO Azure — it
 * is a total function of its `Config` argument and is therefore trivially unit
 * testable. The imperative shell (T5 `bootstrap.ts`) consumes the result to
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
 * with an always-present `auth`. That forces a meaningless `auth` in the
 * common no-foundry case. Per CLAUDE.md ("make illegal states unrepresentable")
 * this models `ResolvedObservability` as a DISCRIMINATED UNION on the PRESENCE
 * of `auth`: `auth` exists ONLY when foundry is on, and the foundry-enabled fact
 * is DERIVED from it via {@link isFoundryEnabled} rather than stored as a
 * redundant boolean that could drift from `traceBackends`.
 */
import type { Config, TraceBackend } from "./config.js";
import { type Result, ok, err } from "@fugue/framework";

export type { TraceBackend };

/**
 * Resolved auth for the Foundry (Application Insights) exporter.
 *
 * Both modes carry the connection string: the Azure Monitor SDK needs it to
 * locate the ingestion endpoint even under Entra ID (T2 finding). In
 * connection-string mode the string also governs auth; in entra-id mode a
 * `DefaultAzureCredential` (constructed downstream in T5) governs auth while
 * the connection string supplies the endpoint.
 */
export type ResolvedAuth =
  | { readonly mode: "connection-string"; readonly connectionString: string }
  | { readonly mode: "entra-id"; readonly connectionString: string };

/**
 * Resolved observability backend selection. Discriminated on the PRESENCE of
 * `auth` so it is carried ONLY when foundry is on — the no-foundry case cannot
 * carry a meaningless/empty auth (illegal state unrepresentable). The
 * foundry-enabled fact is DERIVED from `auth` presence via {@link isFoundryEnabled},
 * NOT stored as a separate boolean (which could drift from `traceBackends`).
 */
export type ResolvedObservability =
  | { readonly traceBackends: readonly TraceBackend[] }
  | { readonly traceBackends: readonly TraceBackend[]; readonly auth: ResolvedAuth };

/**
 * Derived: foundry is enabled iff resolved auth is present. `auth` exists ONLY
 * when a foundry backend was selected (constructed by {@link resolveObservabilityBackends}),
 * so this is the single source of truth — there is no stored boolean to drift
 * from `traceBackends`.
 */
export const isFoundryEnabled = (
  r: ResolvedObservability,
): r is { readonly traceBackends: readonly TraceBackend[]; readonly auth: ResolvedAuth } =>
  "auth" in r;

/**
 * Typed, discriminated configuration error so callers/tests branch on the
 * `cause`, not on parsed message strings.
 *
 * - `missing-connection-string`: foundry is selected but no Application Insights
 *   connection string is available for the resolved auth mode (FR-006/FR-022).
 *   In well-formed config this is caught earlier by the zod `superRefine`, but
 *   the resolver re-checks defense-in-depth (a `Config` built by hand in a test,
 *   or any future bypass of `loadConfig`, still fails closed here).
 */
export type ObservabilityConfigErrorCause = "missing-connection-string";

export class ObservabilityConfigError extends Error {
  readonly cause: ObservabilityConfigErrorCause;
  constructor(cause: ObservabilityConfigErrorCause, message: string) {
    super(message);
    this.name = "ObservabilityConfigError";
    this.cause = cause;
  }
}

/**
 * Pure resolver. `Config -> Result<ResolvedObservability, ObservabilityConfigError>`.
 *
 * - No foundry selected → `{ traceBackends: ['mlflow', …] }` (FR-003). `auth`
 *   is absent by construction, so {@link isFoundryEnabled} derives `false`.
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
    return ok({ traceBackends });
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

  return ok({ traceBackends, auth });
};
