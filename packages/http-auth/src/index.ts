/**
 * @fuguejs/http-auth — generic authenticated-REST capability for Fugue.
 *
 * A reusable building block: any DAG that must call a token-auth'd REST API
 * declares `requires: ["authedHttp"]` and reads `ctx.authedHttp`. The capability
 * mints and caches a boot-scoped bearer token (generic OAuth2-style
 * password/operator grant) and injects it into every request, validating
 * responses against Zod schemas and returning `Result` — no exception escapes.
 *
 * Not specific to any single API: all auth and base-location config arrives via
 * the factory (FR-060); nothing is read from `process.env` here.
 *
 * ## Usage
 *
 * ```ts
 * import { createHttpAuthAdapter } from "@fuguejs/http-auth";
 *
 * const authedHttp = createHttpAuthAdapter({
 *   baseUrl: "https://api.example.com",
 *   defaultHeaders: { Accept: "application/json" },
 *   timeoutMs: 10_000,
 *   auth: {
 *     tokenUrl: "https://auth.example.com/oauth/token",
 *     grantType: "operator_password",
 *     params: { brand_key: "acme" },
 *     basicAuth: { username: "client-id", password: "client-secret" },
 *     credentials: { username: "operator", password: "s3cret" },
 *   },
 * });
 *
 * // Register with the host:
 * const sharedInfra = { ..., capabilities: [authedHttp] };
 *
 * // In a node:
 * createFetchNode({
 *   id: "fetch-customer",
 *   requires: ["authedHttp"] as const,
 *   fetch: (input, ctx) =>
 *     ctx.authedHttp.get(`/customers/${input.id}`, { schema: CustomerSchema }),
 * });
 * ```
 *
 * ## Module Augmentation
 *
 * Augments `@fuguejs/framework`'s `CapabilityRegistry` to add `authedHttp`.
 * After importing this package `requires: ["authedHttp"]` is valid and
 * `ctx.authedHttp` is typed as `AuthedHttpCapability`.
 *
 * @satisfies FR-060, NFR-001/SC-001 (boot-scoped token cache), NFR-010 (no token leak)
 */

import type { Result, FrameworkError, CapabilityHandle } from "@fuguejs/framework";
import { ok, err, nodeId, formatFrameworkError } from "@fuguejs/framework";

import {
  createTokenProvider,
  type AuthConfig,
  type BasicAuth,
  type GrantCredentials,
  type FetchLike,
  type FetchResponseLike,
  type TokenProvider,
} from "./auth.js";
import {
  createAuthedHttpClient,
  type AuthedHttpCapability,
  type AuthedRequestOpts,
  type AuthedBodyRequestOpts,
  isRetriableHttpStatus,
} from "./client.js";

// ---------------------------------------------------------------------------
// Module augmentation
// ---------------------------------------------------------------------------

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    /** Authenticated REST capability. Access via `ctx.authedHttp` in nodes. */
    readonly authedHttp: AuthedHttpCapability;
  }
}

// ---------------------------------------------------------------------------
// Re-exports (public surface)
// ---------------------------------------------------------------------------

export {
  createTokenProvider,
  createAuthedHttpClient,
};
export type {
  AuthedHttpCapability,
  AuthedRequestOpts,
  AuthedBodyRequestOpts,
  AuthConfig,
  BasicAuth,
  GrantCredentials,
  FetchLike,
  FetchResponseLike,
  TokenProvider,
};
// Note: `BearerToken` is intentionally NOT exported. It is an internal brand —
// no public API consumes or produces it (the token never crosses the capability
// boundary, NFR-010), so exporting it would only leak an internal type.
export { buildUrl, type AuthedClientConfig } from "./client.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Full configuration for the authenticated-HTTP adapter. ALL config — nothing
 * hardcoded, nothing read from the environment here (FR-060).
 */
export interface HttpAuthConfig {
  /** Base URL prepended to relative request paths. */
  readonly baseUrl: string;
  /** Default headers applied to every request (per-call overridable). */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Default request timeout in ms (per-call overridable). */
  readonly timeoutMs?: number;
  /** Token-grant configuration. */
  readonly auth: AuthConfig;
  /**
   * Optional fetch seam override. Defaults to the platform `fetch`. Tests pass
   * a fake; production omits this.
   */
  readonly fetch?: FetchLike;
  /** Optional epoch-ms clock seam for token expiry; defaults to `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Default fetch adapter (imperative shell)
// ---------------------------------------------------------------------------

/**
 * Adapt the platform `fetch` to the narrow `FetchLike` seam. The vendor type
 * (`globalThis.fetch`) is confined to this one adapter so the core never sees
 * it.
 */
const platformFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
    json: () => response.json(),
  };
};

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Health-check token mints are bounded so a hung auth endpoint reports unhealthy. */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Create an authenticated-HTTP capability handle.
 *
 * Lifecycle:
 * - `connect()` mints the first token (fails boot if credentials are bad).
 * - `healthCheck()` does an uncached token probe under an independent 5s deadline.
 * - `close()` is a no-op (no pool to drain).
 *
 * The boot-scoped token cache means a steady-state request injects the cached
 * token without a per-request auth round-trip (NFR-001/SC-001).
 */
export const createHttpAuthAdapter = (config: HttpAuthConfig): CapabilityHandle<"authedHttp"> => {
  const doFetch = config.fetch ?? platformFetch;

  const tokens = createTokenProvider({
    auth: config.auth,
    fetch: doFetch,
    now: config.now,
    defaultTimeoutMs: config.timeoutMs,
  });

  const client = createAuthedHttpClient({
    config: {
      baseUrl: config.baseUrl,
      defaultHeaders: config.defaultHeaders,
      timeoutMs: config.timeoutMs,
    },
    tokens,
    fetch: doFetch,
  });

  return {
    name: "authedHttp",
    client,

    connect: async () => {
      // Mint the first token so a bad credential fails boot, not the first run.
      const minted = await tokens.get();
      if (!minted.ok) {
        // The error message is secret-free by construction (NFR-010).
        throw new Error(`http-auth connect failed: ${formatFrameworkError(minted.error)}`);
      }
    },

    close: async () => {
      // Stateless beyond the in-memory token cache — nothing to drain.
    },

    healthCheck: () => healthCheckWithTimeout(tokens, HEALTH_CHECK_TIMEOUT_MS),
  };
};

/**
 * Run an uncached token probe against a hard deadline. The deadline settles
 * independently of fetch cancellation, so a hostile or broken fetch that ignores
 * `AbortSignal` cannot stall readiness. The probe never populates the request
 * cache, making a late completion harmless. Exported for testing.
 */
export const healthCheckWithTimeout = async (
  tokens: TokenProvider,
  timeoutMs: number,
): Promise<Result<void, string>> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<Result<void, string>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`health check timed out after ${timeoutMs}ms`));
      resolve(err(`health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const probe = tokens.probe(controller.signal).then(
    (result): Result<void, string> =>
      result.ok ? ok(undefined) : err(formatFrameworkError(result.error)),
    (): Result<void, string> => err("token provider probe failed outside its Result contract"),
  );

  try {
    return await Promise.race([probe, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Fake for testing
// ---------------------------------------------------------------------------

/**
 * A canned response for one route in the fake capability. A `status` outside
 * 2xx produces the same error classification as the real client (5xx/408/429
 * → transient, other non-2xx → non-retriable node-crash); a `matchBody` that
 * returns `false` fails the route so a wrong-payload bug surfaces in tests.
 *
 * Construct one with {@link shapedRoute} — that brand is how the fake tells a
 * shaped route apart from a raw payload, so a raw payload that happens to carry
 * a `body`/`status` field is never misread as control metadata.
 */
interface FakeAuthedHttpRoute {
  readonly status?: number;
  readonly body: unknown;
  readonly matchBody?: (body: unknown) => boolean;
}

/**
 * Brand marking a route value as a shaped {@link FakeAuthedHttpRoute} rather
 * than a raw verbatim payload. A unique symbol (not a `"body" in route` shape
 * heuristic) so a raw payload can never accidentally look shaped — the only way
 * to carry it is through {@link shapedRoute}.
 */
const SHAPED_ROUTE: unique symbol = Symbol("fuguejs.http-auth.shapedRoute");

type ShapedAuthedHttpRoute = FakeAuthedHttpRoute & { readonly [SHAPED_ROUTE]: true };

/**
 * Wrap a {@link FakeAuthedHttpRoute} so the fake treats it as control metadata
 * (status / matchBody / explicit body) instead of a raw response payload. Any
 * route value NOT built with this helper is returned verbatim, so payloads that
 * legitimately contain a top-level `body` field round-trip unchanged.
 *
 * @example
 * ```ts
 * createFakeAuthedHttpCapability({
 *   "GET /customers/123": { id: "123", name: "Alice" },          // raw — returned verbatim
 *   "GET /raw": { id: "1", body: "note" },                       // raw — `body` field preserved
 *   "POST /orders": shapedRoute({ body: { orderId: "ord-1" } }), // shaped — `body` is the response
 *   "GET /missing": shapedRoute({ status: 404, body: "Not Found" }),
 * });
 * ```
 */
export const shapedRoute = (route: FakeAuthedHttpRoute): ShapedAuthedHttpRoute => ({
  ...route,
  [SHAPED_ROUTE]: true,
});

const isShapedRoute = (route: unknown): route is ShapedAuthedHttpRoute =>
  typeof route === "object" && route !== null && (route as Record<symbol, unknown>)[SHAPED_ROUTE] === true;

/**
 * In-memory fake `AuthedHttpCapability` for testing DAG nodes that use
 * `ctx.authedHttp`. No network, no token machinery — routes match on
 * `"METHOD /path"` (or the bare path). Mirrors `createFakeHttpCapability`.
 *
 * @remarks
 * A route value is a *raw* payload (returned verbatim) unless it was built with
 * {@link shapedRoute}, which brands it as control metadata (`status`/`matchBody`/
 * explicit `body`). Detection is by that brand — NOT a `"body" in route` shape
 * heuristic — so a raw payload that legitimately carries a top-level `body`
 * field round-trips unchanged instead of being misread as a shaped route.
 *
 * @example
 * ```ts
 * const fake = createFakeAuthedHttpCapability({
 *   "GET /customers/123": { id: "123", name: "Alice" },               // raw
 *   "POST /orders": shapedRoute({ body: { orderId: "ord-1" } }),      // shaped
 *   "GET /customers/999": shapedRoute({ status: 404, body: "Not Found" }),
 * });
 * ```
 */
export const createFakeAuthedHttpCapability = (
  routes: Readonly<Record<string, unknown>>,
): CapabilityHandle<"authedHttp"> => {
  const client: AuthedHttpCapability = {
    get: async (path, opts) => matchRoute("GET", path, undefined, opts.schema, routes),
    post: async (path, opts) => matchRoute("POST", path, opts.body, opts.schema, routes),
    put: async (path, opts) => matchRoute("PUT", path, opts.body, opts.schema, routes),
    patch: async (path, opts) => matchRoute("PATCH", path, opts.body, opts.schema, routes),
    delete: async (path, opts) => matchRoute("DELETE", path, undefined, opts.schema, routes),
  };
  return { name: "authedHttp", client };
};

const FAKE_NODE_ID_KIND = "node-crash" as const;
const FAKE_NODE_ID = nodeId("http-auth-fake");

const matchRoute = <T>(
  method: string,
  path: string,
  requestBody: unknown,
  schema: import("zod").z.ZodType<T>,
  routes: Readonly<Record<string, unknown>>,
): Result<T, FrameworkError> => {
  const key = `${method} ${path}`;
  const route = routes[key] ?? routes[path];
  if (route == null) {
    return err({ kind: "transient", nodeId: FAKE_NODE_ID, message: `No fake route matched: ${key}` });
  }

  const shaped = isShapedRoute(route);

  if (shaped) {
    const matchBody = route.matchBody;
    if (matchBody && !matchBody(requestBody)) {
      return err({ kind: "transient", nodeId: FAKE_NODE_ID, message: `Fake route ${key}: request body did not match matchBody` });
    }
    const status = route.status;
    if (status != null && (status < 200 || status >= 300)) {
      const bodyText = String(route.body ?? "");
      if (isRetriableHttpStatus(status)) {
        return err({ kind: "transient", nodeId: FAKE_NODE_ID, message: `HTTP ${status}: ${bodyText.slice(0, 500)}`, httpStatus: status });
      }
      return err({ kind: FAKE_NODE_ID_KIND, nodeId: FAKE_NODE_ID, message: `HTTP ${status}: ${bodyText.slice(0, 500)}`, retriability: "non-retriable" });
    }
  }

  const body = shaped ? route.body : route;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return err({ kind: FAKE_NODE_ID_KIND, nodeId: FAKE_NODE_ID, message: `Fake route response validation failed: ${parsed.error.message}`, retriability: "non-retriable" });
  }
  return ok(parsed.data);
};
