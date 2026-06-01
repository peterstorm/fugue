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
 * unrepresentable") this instead models `auth` as REQUIRED but NULLABLE: it is
 * non-null ONLY when foundry is on and `null` otherwise, so a foundry-enabled
 * value without auth is unrepresentable. The foundry-enabled fact is DERIVED
 * from `auth !== null` via {@link isFoundryEnabled} rather than stored as a
 * redundant boolean that could drift from `traceBackends`.
 */
import type { Config, TraceBackend } from "./config.js";
import { type Result, ok, err } from "@fugue/framework";

export type { TraceBackend };

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
 * Resolved observability backend selection. `auth` is REQUIRED but nullable:
 * it is non-null ONLY when a foundry backend is selected, and `null` otherwise.
 * Foundry-enabled is therefore DERIVED from `auth !== null` ({@link isFoundryEnabled}),
 * so a foundry-enabled value without auth is unrepresentable and there is no
 * separate boolean to drift from `traceBackends`.
 */
export interface ResolvedObservability {
  readonly traceBackends: readonly TraceBackend[];
  readonly auth: ResolvedAuth | null;
}

/**
 * Derived: foundry is enabled iff resolved auth is non-null. `auth` is non-null
 * ONLY when a foundry backend was selected (constructed by {@link resolveObservabilityBackends}),
 * so this is the single source of truth — there is no stored boolean to drift
 * from `traceBackends`.
 */
export const isFoundryEnabled = (
  r: ResolvedObservability,
): r is ResolvedObservability & { readonly auth: ResolvedAuth } => r.auth !== null;

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
 * - No foundry selected → `{ traceBackends: ['mlflow', …], auth: null }` (FR-003).
 *   `auth` is `null` by construction, so {@link isFoundryEnabled} derives `false`.
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
    return ok({ traceBackends, auth: null });
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
