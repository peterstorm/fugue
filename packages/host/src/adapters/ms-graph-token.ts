/**
 * Microsoft Graph app-only token provider (client credentials flow, v2.0
 * endpoint) for the `@fuguejs/ms-graph` adapter's `getAccessToken` seam.
 *
 * PURE functional core: no env, no global fetch, no wall clock — the host
 * entries (`main.ts` / `worker-main.ts`) read config; tests inject fakes. The
 * adapter ships no auth SDK and treats token acquisition/refresh policy as
 * the caller's choice; this module is that choice: fetch on demand, cache
 * until shortly before expiry, single-flight so N concurrent document reads
 * share ONE token request.
 *
 * Secrets never appear in errors or logs — failures carry the HTTP status and
 * endpoint host only (token-endpoint error bodies can echo the request,
 * including the client secret, back to the caller).
 */

/** The v2.0 token endpoint response shape. */
interface TokenResponse {
  readonly access_token: string;
  /** Lifetime in seconds (v2.0). */
  readonly expires_in?: number;
}

/** Minimal response slice the provider needs — tests inject a fake. */
export interface TokenEndpointResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** The global-fetch slice the provider calls. */
export type TokenFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<TokenEndpointResponse>;

export interface MsGraphTokenProviderConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * OIDC v2.0 token endpoint. Default:
   * `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`
   * (override for sovereign clouds / tests).
   */
  readonly tokenUrl?: string;
  /**
   * Graph resource scope. Default `https://graph.microsoft.com/.default` —
   * when overriding the Graph base URL (sovereign cloud) the host entry
   * derives the matching `<origin>/.default` scope.
   */
  readonly scope?: string;
  /** Per-request timeout. Default 15000 ms. */
  readonly requestTimeoutMs?: number;
  /** Refresh the token this many ms before its expiry. Default 60000. */
  readonly refreshLeadMs?: number;
  /** Injected fetch. Default: global fetch. */
  readonly fetchImpl?: TokenFetch;
  /** Injected clock (ms epoch). Default: Date.now. */
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_LEAD_MS = 60_000;
const DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const FALLBACK_LIFETIME_MS = 3_600_000; // v2.0 always sends expires_in; 1 h keeps the cache honest
const defaultTokenUrl = (tenantId: string): string =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * Create the `getAccessToken` callback for `createMsGraphAdapter`.
 *
 * Throws (never resolves with an empty string) on any acquisition failure —
 * the adapter maps a thrown error to a retriable `transient` FrameworkError,
 * which is the correct classification for token-endpoint flakiness.
 */
export const createMsGraphTokenProvider = (
  config: MsGraphTokenProviderConfig,
): (() => Promise<string>) => {
  const tokenUrl = config.tokenUrl ?? defaultTokenUrl(config.tenantId);
  const scope = config.scope ?? DEFAULT_SCOPE;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshLeadMs = config.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
  const fetchImpl: TokenFetch =
    config.fetchImpl ??
    (async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, json: () => r.json() };
    });
  const now: () => number = config.now ?? Date.now;
  const endpointHost = tokenUrl.split("/")[2] ?? "token endpoint";

  let cached: CachedToken | undefined;
  let inflight: Promise<string> | undefined;

  const doFetch = async (): Promise<string> => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope,
    }).toString();
    let res: TokenEndpointResponse;
    try {
      res = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Network errors are transport-controlled and may echo the exact form
      // body, including percent-encoded credentials. Preserve only trusted
      // endpoint context; representation-by-representation redaction is not a
      // complete secret boundary.
      throw new Error(`MS Graph token request to ${endpointHost} failed`);
    }
    if (res.status !== 200) {
      throw new Error(`MS Graph token endpoint ${endpointHost} returned ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // Response-parser errors are endpoint-controlled and can echo the POST
      // body. Preserve only trusted endpoint context at this secret boundary.
      throw new Error(`MS Graph token endpoint ${endpointHost} returned a non-JSON body`);
    }
    const parsed = json as Partial<TokenResponse> | null;
    const accessToken = typeof parsed?.access_token === "string" ? parsed.access_token : "";
    if (accessToken.length === 0) {
      throw new Error(`MS Graph token endpoint ${endpointHost} returned no access_token`);
    }
    const expiresInMs =
      typeof parsed?.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in * 1000
        : FALLBACK_LIFETIME_MS;
    cached = { accessToken, expiresAtMs: now() + expiresInMs };
    return accessToken;
  };

  return async (): Promise<string> => {
    if (cached !== undefined && now() + refreshLeadMs < cached.expiresAtMs) {
      return cached.accessToken;
    }
    // Single-flight: concurrent callers (e.g. the fan-in of nine fetch nodes)
    // share one token request. A failure clears the in-flight guard but NOT
    // the cache — a still-valid token stays usable until its expiry.
    if (inflight !== undefined) return inflight;
    inflight = doFetch().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
};
