/**
 * Generic OAuth2-style token provider for `@fuguejs/http-auth`.
 *
 * Mints a single boot-scoped bearer token via an `application/x-www-form-urlencoded`
 * password/operator grant and caches it. The token is shared across every request;
 * it is minted lazily on first use, refreshed when absent or expired, and
 * invalidated on a `401` so the next `get()` re-mints.
 *
 * Concurrency: a burst of callers arriving after expiry mints exactly ONE token,
 * not N — a single in-flight refresh promise de-dups concurrent refreshes.
 *
 * NFR-010: the token and credentials never leave this module — `get()` returns
 * the bearer string only to the client that injects it into an `Authorization`
 * header, and nothing here logs the token or credentials.
 *
 * @see FR-060 — all credentials/locations arrive via config; nothing read from env here.
 */

import { z } from "zod";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err, nodeId } from "@fuguejs/framework";

// ---------------------------------------------------------------------------
// Branded bearer token
// ---------------------------------------------------------------------------

declare const __bearerBrand: unique symbol;

/**
 * A validated bearer token string. Branded so it cannot be confused with an
 * arbitrary string (e.g. a username, a header value) at a call site.
 */
export type BearerToken = string & { readonly [__bearerBrand]: "BearerToken" };

const asBearerToken = (raw: string): BearerToken => raw as BearerToken;

// ---------------------------------------------------------------------------
// Fetch seam (single-method port → function type)
// ---------------------------------------------------------------------------

/**
 * The slice of the Fetch API the package actually uses. Tests inject a fake;
 * production passes the platform `fetch`. A single-method port collapses to a
 * function type — no class, no interface, no mocking framework.
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** The slice of `Response` the package reads. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Form-field credentials for the password/operator grant. The two mandatory
 * grant fields are modelled explicitly; any further static fields (a second
 * factor, a device id) go in `extra` — mirroring how `AuthConfig.params`
 * carries optional extras. An open index signature is deliberately avoided so a
 * stray non-string field cannot widen the type and so the shape stays honest.
 */
export interface GrantCredentials {
  readonly username: string;
  readonly password: string;
  /** Any further static credential fields (e.g. a second factor). */
  readonly extra?: Readonly<Record<string, string>>;
}

/** Optional HTTP Basic auth applied to the token request itself. */
export interface BasicAuth {
  readonly username: string;
  readonly password: string;
}

/**
 * Generic OAuth2-style token-grant configuration. All values arrive via config
 * — nothing is hardcoded or read from `process.env` here (FR-060).
 */
export interface AuthConfig {
  /** Absolute URL of the token endpoint. */
  readonly tokenUrl: string;
  /** OAuth2 `grant_type` value (e.g. `"password"`, `"operator_password"`). */
  readonly grantType: string;
  /** Static extra form fields merged into the grant body (e.g. a brand key). */
  readonly params?: Readonly<Record<string, string>>;
  /** Optional HTTP Basic auth header on the token request. */
  readonly basicAuth?: BasicAuth;
  /**
   * Form-field credentials (username/password and any extras) for resource-owner
   * style grants (`password`/`operator_password`).
   *
   * OPTIONAL because a two-legged `client_credentials` grant carries NO
   * resource-owner username/password — the client authenticates solely via
   * `basicAuth` (HTTP Basic `client_id:client_secret`) and any non-secret extras
   * (brand key, operator) ride in `params`. When omitted, `buildGrantBody` emits
   * neither `username` nor `password`, so the body is exactly
   * `grant_type=client_credentials&<params>` — what an OAuth2 client-credentials
   * token endpoint expects (sending empty `username=`/`password=` would otherwise
   * be rejected as an `invalid_request`).
   */
  readonly credentials?: GrantCredentials;
  /**
   * Request timeout for the token mint, in ms. Falls back to the client's
   * default when absent.
   */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Token provider port
// ---------------------------------------------------------------------------

/**
 * Internal capability the client depends on to obtain a bearer token. `get()`
 * returns a cached token or mints one; `invalidate()` drops the cache so the
 * next `get()` re-mints (used on a `401`).
 *
 * `get()` accepts an optional `AbortSignal`: when a mint is actually performed
 * (cache miss), aborting the signal cancels the in-flight fetch so a caller that
 * has given up (e.g. a health check that hit its deadline) does not leave an
 * orphaned mint that could later repopulate the cache (split-brain). A cancelled
 * mint maps to a non-retriable `node-crash` (see `mapTokenError`).
 */
export interface TokenProvider {
  get(signal?: AbortSignal): Promise<Result<BearerToken, FrameworkError>>;
  invalidate(): void;
}

// ---------------------------------------------------------------------------
// Token grant — response processing is pure
// ---------------------------------------------------------------------------

const AUTH_NODE_ID = nodeId("http-auth-token");

/** Sentinel: how long before real expiry we treat a token as stale (clock skew). */
const EXPIRY_SKEW_MS = 30_000;

/**
 * Zod schema for a generic OAuth2 token response. `expires_in` is optional —
 * when absent the token is treated as non-expiring within the boot scope.
 * Unknown extra fields (scope, refresh_token, …) are tolerated and ignored.
 */
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});

/** Base64-encode `user:pass` for an HTTP Basic header without leaking via logs. */
const basicAuthHeader = (basic: BasicAuth): string => {
  const raw = `${basic.username}:${basic.password}`;
  // `Buffer` exists under Node and Bun; `btoa` is the browser/edge fallback.
  const encoded =
    typeof Buffer !== "undefined"
      ? Buffer.from(raw, "utf8").toString("base64")
      : btoa(raw);
  return `Basic ${encoded}`;
};

/** Build the `x-www-form-urlencoded` grant body from config. */
const buildGrantBody = (auth: AuthConfig): string => {
  const params = new URLSearchParams();
  params.set("grant_type", auth.grantType);
  // Resource-owner credentials are emitted ONLY when present. A
  // `client_credentials` grant omits them entirely (the client authenticates via
  // `basicAuth`); emitting empty `username=`/`password=` would make a compliant
  // token endpoint reject the request as `invalid_request`.
  if (auth.credentials) {
    params.set("username", auth.credentials.username);
    params.set("password", auth.credentials.password);
    if (auth.credentials.extra)
      for (const [k, v] of Object.entries(auth.credentials.extra)) params.set(k, v);
  }
  if (auth.params) for (const [k, v] of Object.entries(auth.params)) params.set(k, v);
  return params.toString();
};

/**
 * HTTP statuses that are retriable despite being non-5xx: `429 Too Many
 * Requests` (rate-limit — back off and retry) and `408 Request Timeout` (the
 * server timed the request out — retry). These are the textbook retriable
 * signals, so we classify them `transient` rather than a non-retriable crash.
 */
const RETRIABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Map a token-mint failure to a `FrameworkError`. The token/credentials are
 * never included in the message (NFR-010).
 *
 * Retriability policy (see the README error-mapping table):
 * - `network` / `timeout` (our own timeout abort): `transient` — a blip or a
 *   slow endpoint should be retried.
 * - `abort` (a non-timeout `AbortError`, i.e. caller/node cancellation):
 *   non-retriable `node-crash` — a deliberate cancellation must NOT silently
 *   auto-retry the very work the caller asked to stop.
 * - HTTP `5xx`, `429` (rate-limit), `408` (request timeout): `transient` — all
 *   retriable per `RETRIABLE_HTTP_STATUSES` + the 5xx range.
 * - any other non-2xx `4xx` or an unparseable body: non-retriable `node-crash`
 *   (a deterministic rejection — retrying with the same credentials/body would
 *   just fail again).
 */
const mapTokenError = (
  kind: "network" | "timeout" | "abort" | "http" | "parse",
  detail: string,
  status?: number,
): FrameworkError => {
  if (kind === "network" || kind === "timeout") {
    return { kind: "transient", nodeId: AUTH_NODE_ID, message: `Token mint ${kind}: ${detail}` };
  }
  // A deliberate (non-timeout) cancellation: do not auto-retry what was cancelled.
  if (kind === "abort") {
    return {
      kind: "node-crash",
      nodeId: AUTH_NODE_ID,
      message: `Token mint aborted: ${detail}`,
      retriability: "non-retriable",
    };
  }
  // 5xx + rate-limit (429) + request-timeout (408) are the retriable HTTP signals.
  if (kind === "http" && status !== undefined && (status >= 500 || RETRIABLE_HTTP_STATUSES.has(status))) {
    return { kind: "transient", nodeId: AUTH_NODE_ID, message: `Token mint HTTP ${status}`, httpStatus: status };
  }
  if (kind === "http") {
    return {
      kind: "node-crash",
      nodeId: AUTH_NODE_ID,
      message: `Token mint rejected: HTTP ${status ?? "?"}`,
      retriability: "non-retriable",
    };
  }
  return {
    kind: "node-crash",
    nodeId: AUTH_NODE_ID,
    message: `Token mint response invalid: ${detail}`,
    retriability: "non-retriable",
  };
};

/** A minted token plus the absolute epoch-ms it expires (or `null` if non-expiring). */
interface CachedToken {
  readonly token: BearerToken;
  readonly expiresAtMs: number | null;
}

/**
 * Perform the token grant over the injected fetch seam. Side-effecting I/O is
 * isolated here; response *processing* (schema, expiry computation) is pure.
 */
const mintToken = async (
  auth: AuthConfig,
  doFetch: FetchLike,
  now: () => number,
  defaultTimeoutMs: number | undefined,
  externalSignal?: AbortSignal,
): Promise<Result<CachedToken, FrameworkError>> => {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (auth.basicAuth) headers.Authorization = basicAuthHeader(auth.basicAuth);

  const timeoutMs = auth.timeoutMs ?? defaultTimeoutMs;
  // A single controller drives BOTH the internal timeout and any external
  // cancellation. The timeout aborts with an Error("timeout") (→ transient);
  // an external abort propagates a plain AbortError (→ non-retriable
  // node-crash), so the two causes stay distinguishable in the catch.
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  if (timeoutMs != null || externalSignal) {
    controller = new AbortController();
    const ctrl = controller;
    if (timeoutMs != null) {
      timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    }
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else {
        onExternalAbort = () => ctrl.abort();
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
  }

  try {
    const response = await doFetch(auth.tokenUrl, {
      method: "POST",
      headers,
      body: buildGrantBody(auth),
      signal: controller?.signal,
    });

    if (!response.ok) {
      // Best-effort drain so a keep-alive socket is not left dangling; the body
      // is intentionally NOT surfaced in the error to avoid leaking secrets.
      await response.text().catch(() => "");
      return err(mapTokenError("http", "non-2xx", response.status));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Do NOT surface the JSON-parse error text: V8/Bun parse messages echo a
      // snippet of the offending body, which for a token endpoint can carry the
      // access_token. A static detail keeps the credential out of logs/errors.
      return err(mapTokenError("parse", "malformed JSON response"));
    }

    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      // Surface only the failing field PATHS, never zod's full message (which can
      // interpolate received values for some issue kinds) — the body may carry a
      // secret. Paths name which fields were wrong without echoing their values.
      const paths = parsed.error.issues
        .map((i) => (i.path.length > 0 ? i.path.join(".") : "(root)"))
        .join(", ");
      return err(mapTokenError("parse", `unexpected token response shape (${paths})`));
    }

    const expiresAtMs =
      parsed.data.expires_in !== undefined
        ? now() + parsed.data.expires_in * 1000 - EXPIRY_SKEW_MS
        : null;

    return ok({ token: asBearerToken(parsed.data.access_token), expiresAtMs });
  } catch (error) {
    // Distinguish OUR timeout abort from an external/foreign cancellation. The
    // abort reason carried on the controller's signal is the source of truth: a
    // signal-respecting fetch rejects with that reason. Our timeout aborts with
    // `Error("timeout")`; an external cancel aborts with no/other reason.
    const reason: unknown = controller?.signal.reason;
    const isOurTimeout =
      (reason instanceof Error && reason.message === "timeout") ||
      (error instanceof Error && (error.message === "timeout" || error.name === "TimeoutError"));
    const isAbort =
      controller?.signal.aborted === true ||
      (error instanceof Error && error.name === "AbortError");

    // Our OWN timeout → transient: a slow auth endpoint should be retried.
    if (isOurTimeout) {
      return err(mapTokenError("timeout", `after ${timeoutMs}ms`));
    }
    // A non-timeout abort means the caller/node cancelled the mint → must NOT
    // auto-retry the cancelled work; map to a non-retriable node-crash.
    if (isAbort) {
      return err(mapTokenError("abort", "request cancelled"));
    }
    return err(mapTokenError("network", error instanceof Error ? error.message : String(error)));
  } finally {
    if (timer != null) clearTimeout(timer);
    if (onExternalAbort && externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
};

// ---------------------------------------------------------------------------
// Provider factory — the one justified piece of encapsulated mutable state
// ---------------------------------------------------------------------------

export interface TokenProviderDeps {
  readonly auth: AuthConfig;
  readonly fetch: FetchLike;
  /** Epoch-ms clock seam; defaults to `Date.now`. Injected by tests. */
  readonly now?: () => number;
  /** Default mint timeout when `auth.timeoutMs` is absent. */
  readonly defaultTimeoutMs?: number;
}

/**
 * Build a boot-scoped `TokenProvider`. The cached token and the single
 * in-flight refresh promise are the only mutable state; both are closed over
 * and never escape. Exported for testing — the adapter factory wires the real
 * fetch.
 */
export const createTokenProvider = (deps: TokenProviderDeps): TokenProvider => {
  const now = deps.now ?? (() => Date.now());
  let cached: CachedToken | null = null;
  // De-dups concurrent refreshes: the first caller to find the cache empty
  // starts the mint and parks its promise here; later callers in the same burst
  // await the same promise instead of starting their own mint.
  let inflight: Promise<Result<CachedToken, FrameworkError>> | null = null;
  // Cache generation. `invalidate()` bumps it; a refresh captures the
  // generation when it STARTS and only writes `cached` on settle if the
  // generation is unchanged. This closes the lost-invalidate race: an
  // `invalidate()` that lands while a mint is in flight must win — the
  // resolving mint must not repopulate `cached` with the token the caller just
  // asked to drop.
  let generation = 0;

  const isFresh = (entry: CachedToken): boolean =>
    entry.expiresAtMs === null || entry.expiresAtMs > now();

  const refresh = (signal?: AbortSignal): Promise<Result<CachedToken, FrameworkError>> => {
    if (inflight) return inflight;
    const startedGeneration = generation;
    const p = mintToken(deps.auth, deps.fetch, now, deps.defaultTimeoutMs, signal)
      .then((result) => {
        // Only write the cache if no invalidate() intervened since this mint
        // started — otherwise the just-invalidated token would be resurrected.
        if (result.ok && generation === startedGeneration) cached = result.value;
        return result;
      })
      .finally(() => {
        // Clear the in-flight slot so a later expiry can mint afresh. A failed
        // mint leaves `cached` untouched (still null/stale) so the next call
        // retries rather than serving a poisoned entry.
        inflight = null;
      });
    inflight = p;
    return p;
  };

  return {
    get: async (signal?: AbortSignal): Promise<Result<BearerToken, FrameworkError>> => {
      if (cached && isFresh(cached)) return ok(cached.token);
      const result = await refresh(signal);
      return result.ok ? ok(result.value.token) : err(result.error);
    },

    invalidate: (): void => {
      cached = null;
      // Bump the generation so any in-flight mint's `.then` write is discarded.
      generation += 1;
    },
  };
};

// ---------------------------------------------------------------------------
// Exports for the client / adapter
// ---------------------------------------------------------------------------

export { AUTH_NODE_ID, basicAuthHeader, buildGrantBody, mapTokenError, mintToken };
