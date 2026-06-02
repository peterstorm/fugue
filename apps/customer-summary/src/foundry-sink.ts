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
 * Auth (FR-022 / FR-023) — BOTH modes use an ISOLATED `TelemetryClient`
 * (`useGlobalProviders: false`): manual track calls only, NO global Azure
 * Monitor distro and NO global OpenTelemetry provider registration. This keeps
 * the app's domain-event sink from colliding with the framework's own global
 * `TracerProvider` (the tracing pipeline's `NodeSDK`), which would otherwise
 * race the distro for the single process-global provider with undefined
 * last-writer-wins precedence.
 *   - connection-string mode: the connection string governs auth.
 *   - entra-id mode: the same isolated client, plus a `DefaultAzureCredential`
 *     attached via `config.aadTokenCredential` (the connection string still
 *     carries the ingestion endpoint). The shim's lazy `initialize()` reads that
 *     credential through `parseConfig()` into the isolated client's Azure Monitor
 *     exporter — so AAD auth needs NO global `useAzureMonitor` pipeline.
 *
 * Fail-tolerance (FR-028): track-call fault isolation is provided by the
 * observer wrappers (the framework's `AiFoundryObserver` and the app's
 * `FoundryRunSummaryObserver`), which wrap every emission in try/catch + log. This adapter is intentionally a
 * thin pass-through. `flush()` may reject; its sole caller (graceful shutdown in
 * bootstrap.ts) guards and logs it, so a flush failure is surfaced rather than
 * silently swallowed.
 */
import { TelemetryClient } from "applicationinsights";
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
 * The mutable AAD-auth surface of the shim `TelemetryClient`. `applicationinsights@3.x`
 * exposes `client.config.aadTokenCredential`; the lazy `initialize()` reads it
 * via `parseConfig()` into the isolated client's Azure Monitor exporter
 * credential. Narrowed here so {@link applyCredential} can set it without the
 * whole `Config` surface, and so the cast lives in exactly one place.
 */
interface AadConfigurableClient {
  config: { aadTokenCredential?: TokenCredential };
}

/**
 * Injectable seams for {@link createAppInsightsClient}. The defaults bind the
 * real `applicationinsights` surface; tests supply fakes so BOTH auth branches
 * are exercisable WITHOUT a live Azure pipeline or global Application Insights
 * init:
 *   - `credentialFactory` — defaults to `DefaultAzureCredential`.
 *   - `newClient` — constructs the (structurally typed) ISOLATED `TelemetryClient`.
 *     The `useGlobalProviders: false` isolation flag is ALWAYS passed (both auth
 *     modes), so a regression dropping it is observable in tests.
 *   - `applyCredential` — attaches the entra-id credential to the isolated
 *     client (`config.aadTokenCredential`). Tests fake it to assert the entra-id
 *     branch wires the credential without touching `applicationinsights`.
 */
export interface AppInsightsClientSeams {
  readonly credentialFactory: () => TokenCredential;
  readonly newClient: (connectionString: string, options: { useGlobalProviders: boolean }) => AppInsightsClient;
  readonly applyCredential: (client: AppInsightsClient, credential: TokenCredential) => void;
}

const defaultSeams: AppInsightsClientSeams = {
  credentialFactory: () => new DefaultAzureCredential(),
  newClient: (connectionString, options) =>
    new TelemetryClient(connectionString, options) as unknown as AppInsightsClient,
  applyCredential: (client, credential) => {
    // The single sanctioned cast to the real shim shape: an ISOLATED client
    // (useGlobalProviders:false) still authenticates via AAD by setting
    // config.aadTokenCredential, which the shim's lazy initialize()/parseConfig()
    // forwards to the Azure Monitor exporter — no global useAzureMonitor distro.
    (client as unknown as AadConfigurableClient).config.aadTokenCredential = credential;
  },
};

/**
 * Construct the production Application Insights `TelemetryClient` for the
 * resolved auth. This is the IMPERATIVE boundary (touches `applicationinsights`).
 * BOTH auth modes build an ISOLATED client (`useGlobalProviders: false`) so the
 * sink never registers a process-global OpenTelemetry provider — entra-id differs
 * ONLY by attaching the credential. Tests inject {@link AppInsightsClientSeams}
 * fakes to exercise both branches with no live Azure, and {@link foundrySinkOver}
 * bypasses it entirely with a fake client.
 *
 * @param auth   the resolved auth mode + connection string.
 * @param seams  injectable for tests; defaults bind the real surface.
 */
export const createAppInsightsClient = (
  auth: ResolvedAuth,
  seams: Partial<AppInsightsClientSeams> = {},
): AppInsightsClient => {
  const { credentialFactory, newClient, applyCredential } = { ...defaultSeams, ...seams };

  // Isolated client for BOTH modes: manual track calls only, no global pipeline.
  const client = newClient(auth.connectionString, { useGlobalProviders: false });

  if (auth.mode === "entra-id") {
    // Entra ID: attach the credential to the isolated client (the connection
    // string still carries the ingestion endpoint). No global distro needed.
    applyCredential(client, credentialFactory());
  }
  return client;
};

/** Build the production app-layer sink for the resolved auth. */
export const createFoundrySink = (
  auth: ResolvedAuth,
  seams?: Partial<AppInsightsClientSeams>,
): FoundryTelemetrySink => foundrySinkOver(createAppInsightsClient(auth, seams));
