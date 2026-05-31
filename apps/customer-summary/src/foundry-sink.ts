/**
 * Application Insights-backed {@link FoundryTelemetrySink} adapter — the thin
 * IMPERATIVE SHELL the framework's vendor-neutral `AiFoundryObserver` writes to.
 *
 * The framework observer depends only on the `FoundryTelemetrySink` PORT and
 * deliberately leaves the `applicationinsights` dependency to the app layer.
 * This module is the only place in the app that imports `applicationinsights`;
 * it translates the port's three methods onto an Application Insights
 * `TelemetryClient`:
 *   - `trackEvent`  → `client.trackEvent`  (customEvent)
 *   - `trackMetric` → `client.trackMetric` (customMetric, single data point)
 *   - `flush`       → `client.flush`        (graceful-shutdown drain)
 *
 * Auth (FR-022 / FR-023):
 *   - connection-string mode: construct an ISOLATED `TelemetryClient` over the
 *     connection string (`useGlobalProviders: false`) — manual track calls only,
 *     no global pipeline side effects.
 *   - entra-id mode: the shim `TelemetryClient` ctor cannot take a credential,
 *     so we configure the global Azure Monitor distro pipeline with the
 *     `DefaultAzureCredential` (the connection string still carries the
 *     ingestion endpoint), then construct a `TelemetryClient` that relies on
 *     those global providers.
 *
 * Fail-tolerance (FR-028): track-call fault isolation is provided by the
 * framework observer wrappers (AiFoundryObserver / FoundryRunSummaryObserver),
 * which wrap every emission in try/catch + log. This adapter is intentionally a
 * thin pass-through. `flush()` may reject; its sole caller (graceful shutdown in
 * bootstrap.ts) guards and logs it, so a flush failure is surfaced rather than
 * silently swallowed.
 */
import { TelemetryClient, useAzureMonitor } from "applicationinsights";
import { DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import type { FoundryTelemetrySink } from "@fugue/framework";
import type { ResolvedAuth } from "./observability.js";

/**
 * Minimal structural view of the Application Insights `TelemetryClient` surface
 * this sink uses. Declaring it lets tests inject a fake client WITHOUT touching
 * `applicationinsights` or any global pipeline (no live Azure, FR-028 test
 * isolation) while keeping the production path strongly typed.
 */
export interface AppInsightsClient {
  trackEvent(t: { name: string; properties?: Record<string, string>; measurements?: Record<string, number> }): void;
  trackMetric(t: { name: string; value: number; properties?: Record<string, string> }): void;
  flush(): Promise<void> | void;
}

/**
 * Wrap an Application Insights client in the framework's `FoundryTelemetrySink`
 * port. PURE over its argument — no construction, no I/O at call time — so it is
 * trivially testable with a fake client. Thin pass-through — track-call fault
 * isolation lives in the observer wrappers; `flush()` may reject and is guarded
 * by its caller.
 */
export const foundrySinkOver = (client: AppInsightsClient): FoundryTelemetrySink => ({
  trackEvent: (e) => {
    client.trackEvent({
      name: e.name,
      ...(e.properties ? { properties: e.properties } : {}),
      ...(e.measurements ? { measurements: e.measurements } : {}),
    });
  },
  trackMetric: (m) => {
    client.trackMetric({
      name: m.name,
      value: m.value,
      ...(m.properties ? { properties: m.properties } : {}),
    });
  },
  flush: async () => {
    await client.flush();
  },
});

/**
 * Options describing how the global Azure Monitor distro pipeline is configured
 * in entra-id mode — the exact shape passed to `useAzureMonitor`. Named so the
 * seam below (and its tests) can reason about the entra-id branch without
 * touching `applicationinsights` globals.
 */
export interface AzureMonitorInit {
  azureMonitorExporterOptions: {
    connectionString: string;
    credential: TokenCredential;
  };
}

/**
 * Injectable seams for {@link createAppInsightsClient}. The defaults bind the
 * real `applicationinsights` surface; tests supply fakes so BOTH auth branches
 * are exercisable WITHOUT a live Azure pipeline or global Application Insights
 * init:
 *   - `credentialFactory` — defaults to `DefaultAzureCredential`.
 *   - `configureGlobalPipeline` — the entra-id global init (`useAzureMonitor`).
 *     Tests fake it to assert the global-pipeline branch runs without actually
 *     mutating global providers.
 *   - `newClient` — constructs the (structurally typed) `TelemetryClient`. The
 *     `useGlobalProviders: false` isolation flag for connection-string mode is
 *     passed here, so a regression dropping it is observable in tests.
 */
export interface AppInsightsClientSeams {
  readonly credentialFactory: () => TokenCredential;
  readonly configureGlobalPipeline: (init: AzureMonitorInit) => void;
  readonly newClient: (connectionString: string, options?: { useGlobalProviders: boolean }) => AppInsightsClient;
}

const defaultSeams: AppInsightsClientSeams = {
  credentialFactory: () => new DefaultAzureCredential(),
  configureGlobalPipeline: (init) => useAzureMonitor(init),
  newClient: (connectionString, options) =>
    (options === undefined
      ? new TelemetryClient(connectionString)
      : new TelemetryClient(connectionString, options)) as unknown as AppInsightsClient,
};

/**
 * Construct the production Application Insights `TelemetryClient` for the
 * resolved auth. This is the IMPERATIVE boundary (touches `applicationinsights`
 * and, for entra-id, the global Azure Monitor pipeline). Tests inject
 * {@link AppInsightsClientSeams} fakes to exercise both auth branches with no
 * live Azure, and {@link foundrySinkOver} bypasses it entirely with a fake
 * client.
 *
 * @param auth   the resolved auth mode + connection string.
 * @param seams  injectable for tests; defaults bind the real surface.
 */
export const createAppInsightsClient = (
  auth: ResolvedAuth,
  seams: Partial<AppInsightsClientSeams> = {},
): AppInsightsClient => {
  const { credentialFactory, configureGlobalPipeline, newClient } = { ...defaultSeams, ...seams };

  if (auth.mode === "entra-id") {
    // The shim TelemetryClient ctor takes no credential; configure the global
    // Azure Monitor distro pipeline with the credential (the connection string
    // carries the ingestion endpoint), then construct a client that relies on
    // those global providers.
    configureGlobalPipeline({
      azureMonitorExporterOptions: {
        connectionString: auth.connectionString,
        credential: credentialFactory(),
      },
    });
    return newClient(auth.connectionString);
  }
  // connection-string mode: isolated client, manual track calls only.
  return newClient(auth.connectionString, { useGlobalProviders: false });
};

/** Build the production app-layer sink for the resolved auth. */
export const createFoundrySink = (
  auth: ResolvedAuth,
  seams?: Partial<AppInsightsClientSeams>,
): FoundryTelemetrySink => foundrySinkOver(createAppInsightsClient(auth, seams));
