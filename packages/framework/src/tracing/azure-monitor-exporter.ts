/**
 * Azure AI Foundry exporter.
 *
 * Foundry's Tracing tab reads from Application Insights, so this wraps the
 * official `AzureMonitorTraceExporter` and forwards spans to an Application
 * Insights resource. Unlike the MLflow exporter, this is a **pure pass-through**:
 * Foundry consumes the framework's vendor-neutral GenAI semantic attributes
 * (`gen_ai.*`) and framework-owned enrichment (`ai.*`) NATIVELY, so spans flow
 * through unchanged. `translateSpanForFoundry` therefore remains an explicit
 * identity function; a future vendor requirement can introduce translation
 * only when there is real behavior to encode.
 *
 * Content-capture / PII gating (FR-012) is applied UPSTREAM in `span-enrich.ts`
 * via the configured `ContentFilter`. This exporter MUST NOT re-filter content —
 * by the time a span reaches `export()`, redaction has already happened.
 *
 * Auth (FR-022 / FR-023):
 * - Default: an Application Insights connection string supplied via config.
 * - Opt-in: Entra ID via a `TokenCredential` (e.g. `DefaultAzureCredential`
 *   from `@azure/identity`). When a credential is provided it is forwarded to
 *   the inner exporter alongside the connection string (the connection string
 *   still carries the ingestion endpoint).
 */
import { createRequire } from "node:module";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TokenCredential } from "@azure/identity";
import type { NonEmptyString } from "../types/non-empty-string.js";
import { fwLogger } from "../logger.js";

// ESM-safe synchronous `require`. Under Bun this module executes as native ESM,
// where the bare `require` global is undefined; we derive a real one via
// `createRequire`. We anchor it on `__filename` (a Node/Bun-provided global that
// resolves in BOTH the framework's CommonJS typecheck context and the Bun ESM
// runtime) rather than `import.meta.url`, which the framework's NodeNext-CJS
// typecheck rejects. Used ONLY to load the Azure exporter lazily-yet-synchronously
// at construction time (see `buildInner`) so the default MLflow-only path never
// loads the Azure SDK.
const requireModule = createRequire(__filename);

/**
 * The assembled auth options forwarded to the inner Azure exporter. This is the
 * EXACT object shape `@azure/monitor-opentelemetry-exporter` receives, and the
 * shape the `createInner` test seam observes (Fix 1: the seam carries the
 * real assembled options so auth-shape regressions are caught on the real path).
 */
export interface AzureMonitorInnerOpts {
  readonly connectionString?: string;
  readonly credential?: TokenCredential;
}

/**
 * Auth invariant encoded as a discriminated union so an empty `{}` is a COMPILE
 * error rather than a runtime-only failure (CLAUDE.md: make illegal states
 * unrepresentable). Every VALID combination is permitted:
 *   - connection-string only (default auth, FR-022)
 *   - credential only (Entra ID, FR-023)
 *   - connection-string + credential (Entra ID needs both — the connection
 *     string carries the ingestion endpoint; the credential governs auth)
 * The one forbidden combination — neither field — cannot be constructed.
 *
 * `connectionString` is a {@link NonEmptyString}, so a blank connection string
 * (`""`) is ALSO unrepresentable at compile time — the brand pushes the
 * non-blank invariant out of the runtime guard in `resolveOpts` and into the
 * type. The guard is retained for the dynamic (env-derived) boundary.
 */
export type AzureMonitorAuth =
  | { readonly connectionString: NonEmptyString; readonly credential?: TokenCredential }
  | { readonly credential: TokenCredential; readonly connectionString?: NonEmptyString };

/** Test seam: receives the REAL assembled {@link AzureMonitorInnerOpts}. */
export type AzureMonitorInnerFactory = (opts: AzureMonitorInnerOpts) => SpanExporter;

/**
 * Exporter config. A discriminated union over `auth` vs `createInner` so the
 * empty state `{}` is a COMPILE error (CLAUDE.md: illegal states
 * unrepresentable):
 *
 * - `{ auth }` — production: supply an {@link AzureMonitorAuth}. At least one of
 *   {connectionString, credential} is required BY THE TYPE, so `{}` and
 *   `{ auth: {} }` do not compile. An OPTIONAL `createInner` may accompany it:
 *   when present, `buildInner` assembles the auth options via the REAL
 *   `resolveOpts(auth)` path and hands the resulting {@link AzureMonitorInnerOpts}
 *   to the seam INSTEAD of constructing the live Azure exporter. This is how
 *   auth-shape tests observe exactly what Azure would receive — no live
 *   network, no test-only hand-wired spread.
 * - `{ createInner }` (no `auth`) — pure test seam: inject a fake inner
 *   `SpanExporter` with no auth at all. The factory receives empty opts `{}`.
 *
 * `AzureMonitorTraceExporter` is imported synchronously only when `auth` is
 * present AND no `createInner` override is supplied; the seam paths never touch
 * Azure.
 */
export type AzureMonitorExporterConfig =
  | { readonly auth: AzureMonitorAuth; readonly createInner?: AzureMonitorInnerFactory }
  | { readonly createInner: AzureMonitorInnerFactory };

/** Explicit Foundry pass-through; returns the same span without mutation. */
export const translateSpanForFoundry = (span: ReadableSpan): ReadableSpan => span;

/**
 * Thrown at the boundary when no auth input and no test seam are supplied.
 *
 * Defense-in-depth ONLY: the discriminated-union {@link AzureMonitorExporterConfig}
 * makes the empty-auth state unrepresentable from typed call sites, so this is
 * largely unreachable there. It exists for the DYNAMIC / untyped config boundary
 * (the app's bootstrap builds this config from parsed env, where a runtime hole
 * could still yield an `auth` object with neither field). Construction is the boundary
 * — there is no useful exporter to return, so we fail fast and loud rather than
 * silently dropping every span at runtime.
 */
export class AzureMonitorExporterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureMonitorExporterConfigError";
  }
}

export class AzureMonitorExporter implements SpanExporter {
  private readonly inner: SpanExporter;

  constructor(config: AzureMonitorExporterConfig) {
    this.inner = AzureMonitorExporter.buildInner(config);
  }

  /**
   * Resolve the inner `SpanExporter`. Assemble the auth options ONCE, then route
   * them through either the `createInner` test seam (no live Azure) or the real
   * `AzureMonitorTraceExporter`. Because the SAME assembled `opts` object flows
   * down BOTH paths, a test injecting `createInner` observes exactly what the
   * real Azure exporter would receive (no test-only hand-wired spread).
   */
  private static buildInner(config: AzureMonitorExporterConfig): SpanExporter {
    // Assemble the auth options ONCE via the REAL resolveOpts path when auth is
    // present; the no-auth seam path has nothing to assemble (empty opts).
    const opts: AzureMonitorInnerOpts =
      "auth" in config ? AzureMonitorExporter.resolveOpts(config.auth) : {};

    // Seam takes precedence and receives the SAME assembled `opts` the real
    // Azure exporter would — so auth-shape regressions are caught on the
    // real assembly path, with no live network.
    if (config.createInner) return config.createInner(opts);

    // The module-scoped `requireModule` (from `createRequire(__filename)`) gives
    // an ESM-safe SYNCHRONOUS require. The load stays LAZY: it runs only here,
    // when the Azure exporter is actually constructed without a `createInner`
    // seam (auth present, no override). So the default MLflow-only path — and
    // every seam path — never loads the Azure SDK, even though the package is a
    // HARD dependency (FR-029) and always installed.
    const { AzureMonitorTraceExporter } = requireModule("@azure/monitor-opentelemetry-exporter") as {
      AzureMonitorTraceExporter: new (opts: AzureMonitorInnerOpts) => SpanExporter;
    };

    return new AzureMonitorTraceExporter(opts);
  }

  /**
   * Pure: assemble the {@link AzureMonitorInnerOpts} forwarded to the inner
   * exporter from an {@link AzureMonitorAuth}. Forwards whichever auth inputs are
   * present and NO stray keys. When `credential` is set we still pass the
   * connection string (it carries the ingestion endpoint); Entra ID then governs
   * authentication (FR-023).
   *
   * Defense-in-depth: the type makes empty auth unrepresentable, but a dynamic
   * (env-derived) caller could still smuggle in `{}`. Fail fast and loud here.
   */
  private static resolveOpts(auth: AzureMonitorAuth): AzureMonitorInnerOpts {
    const connectionString = auth.connectionString;
    const credential = auth.credential;
    if (!connectionString && !credential) {
      throw new AzureMonitorExporterConfigError(
        "AzureMonitorExporter requires a connectionString (FR-022) or a credential " +
          "(FR-023). The auth object had neither.",
      );
    }
    return {
      ...(connectionString ? { connectionString } : {}),
      ...(credential ? { credential } : {}),
    };
  }

  /**
   * Failure contract: log-but-propagate. On an inner failure
   * (`result.code !== ExportResultCode.SUCCESS`) we WARN via `fwLogger` and then
   * forward the ORIGINAL `ExportResult` unchanged. We never swallow or rewrite
   * the result, so the OTel SDK's own retry/backoff still sees the true outcome.
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Pass-through: identity-translate and delegate.
    const translated = spans.map(translateSpanForFoundry);
    this.inner.export(translated, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        fwLogger().warn(
          `[AzureMonitorExporter] Inner exporter failed for ${spans.length} span(s): ${
            result.error?.message ?? "unknown error"
          }`,
        );
      }
      resultCallback(result);
    });
  }

  /**
   * Failure contract: log-then-continue. `shutdown()` runs on the SDK's shutdown
   * chain, where a rejection aborts the remaining exporters and makes a clean
   * stop look like a crash to a process supervisor. A transport failure on the
   * final flush is worth SEEING — hence the warn, matching `export()`'s
   * discipline — but never worth propagating, because there is no retry left to
   * inform and nothing the caller can do with it.
   */
  async shutdown(): Promise<void> {
    if (!this.inner.shutdown) return;
    try {
      await this.inner.shutdown();
    } catch (e) {
      fwLogger().warn(
        `[AzureMonitorExporter] Inner exporter shutdown() failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async forceFlush(): Promise<void> {
    const flush = (this.inner as { forceFlush?: () => Promise<void> }).forceFlush;
    if (flush) await flush.call(this.inner);
  }
}

/** Factory function for creating an Azure AI Foundry (Application Insights) exporter. */
export const createAzureMonitorExporter = (
  config: AzureMonitorExporterConfig,
): SpanExporter => new AzureMonitorExporter(config);
