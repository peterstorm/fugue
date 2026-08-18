/**
 * Authenticated REST client for `@fuguejs/http-auth`.
 *
 * Wraps the injected fetch seam with:
 * - automatic injection of the managed bearer token as `Authorization: Bearer …`
 * - Zod validation of every response body (`Result`, never throws)
 * - FrameworkError mapping mirroring the framework's built-in HTTP capability
 *   (timeout/network/5xx → `transient`; invalid JSON/4xx/schema mismatch →
 *   non-retriable `node-crash`)
 * - a single `401` retry: on a `401` from any verb, the token is invalidated,
 *   re-minted, and the original request retried exactly once.
 *
 * NFR-010: the token is read from the provider per request and placed only in
 * the outbound header — it is never logged nor returned from any method.
 */

import type { z } from "zod";
import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err, nodeId, frameworkError } from "@fuguejs/framework";
import type { TokenProvider, FetchLike } from "./auth.js";

const CLIENT_NODE_ID = nodeId("http-auth-client");

// ---------------------------------------------------------------------------
// Request options & capability surface
// ---------------------------------------------------------------------------

/** Options for an authenticated request without a body (GET/DELETE). */
export interface AuthedRequestOpts<T> {
  /** Zod schema the response body is validated against. */
  readonly schema: z.ZodType<T>;
  /** Extra headers merged over the configured defaults (per-call override). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-call timeout in ms; falls back to the client default. */
  readonly timeoutMs?: number;
}

/**
 * Options for an authenticated request WITH a JSON body (POST/PUT/PATCH). The
 * body/no-body split is modelled exactly once, here: `body` is a first-class
 * field of the body-verb opts (not bolted on at the method signature). It is
 * optional because a body verb with no payload is legitimate (e.g. a `POST`
 * that signals an action), but it lives on this type alone so `get`/`delete`
 * cannot accept it and no unsafe cast is needed to read it.
 */
export interface AuthedBodyRequestOpts<T> extends AuthedRequestOpts<T> {
  /** The request payload; always JSON-stringified. Omit for a body-less action. */
  readonly body?: unknown;
  /** Content-Type override (header only); the body is always JSON-stringified. */
  readonly contentType?: string;
}

/**
 * The capability nodes see on `ctx.authedHttp`. Every method returns `Result`
 * — no exception escapes — and auto-injects the managed bearer token. The
 * body/no-body distinction is carried by the opts types: `get`/`delete` take
 * `AuthedRequestOpts` (no `body`), `post`/`put`/`patch` take
 * `AuthedBodyRequestOpts` (with `body`).
 */
export interface AuthedHttpCapability {
  get<T>(path: string, opts: AuthedRequestOpts<T>): Promise<Result<T, FrameworkError>>;
  post<T>(path: string, opts: AuthedBodyRequestOpts<T>): Promise<Result<T, FrameworkError>>;
  put<T>(path: string, opts: AuthedBodyRequestOpts<T>): Promise<Result<T, FrameworkError>>;
  patch<T>(path: string, opts: AuthedBodyRequestOpts<T>): Promise<Result<T, FrameworkError>>;
  delete<T>(path: string, opts: AuthedRequestOpts<T>): Promise<Result<T, FrameworkError>>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Join base URL and path, treating an absolute `path` as already complete. */
export const buildUrl = (baseUrl: string, path: string): string => {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
};

const makeTransientError = (message: string, httpStatus?: number): FrameworkError =>
  frameworkError.transient(CLIENT_NODE_ID, message, httpStatus);

const makeNodeCrashError = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: CLIENT_NODE_ID,
  message,
  retriability: "non-retriable",
});

/**
 * HTTP statuses that are retriable despite being non-5xx: `429 Too Many
 * Requests` (rate-limit — back off and retry) and `408 Request Timeout`. These
 * are the textbook retriable signals, so we classify them `transient` rather
 * than a non-retriable crash. Mirrors the token-mint path in `auth.ts`.
 */
const RETRIABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/** A non-2xx response is retriable when it is 5xx, 429 (rate-limit) or 408 (timeout). */
const isRetriableHttpStatus = (status: number): boolean =>
  status >= 500 || RETRIABLE_HTTP_STATUSES.has(status);

/**
 * The raw outcome of a single fetch attempt, before token-refresh logic. We
 * surface `401` distinctly so the caller can decide to invalidate + retry,
 * rather than baking the retry into the low-level send.
 */
type SendOutcome<T> =
  | { readonly tag: "ok"; readonly value: T }
  | { readonly tag: "unauthorized" }
  | { readonly tag: "error"; readonly error: FrameworkError };

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface AuthedClientConfig {
  readonly baseUrl: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

interface AuthedClientDeps {
  readonly config: AuthedClientConfig;
  readonly tokens: TokenProvider;
  readonly fetch: FetchLike;
}

// ---------------------------------------------------------------------------
// Single send attempt (I/O isolated)
// ---------------------------------------------------------------------------

/**
 * The body payload for a single send. `body === undefined` means a body-less
 * request (GET/DELETE, or a body verb invoked with no payload); `contentType`
 * overrides the default `application/json` header. Extracted from
 * `AuthedBodyRequestOpts` at the (statically body-typed) call site so neither
 * `sendOnce` nor `execute` needs an unsafe cast to read body-only fields off
 * the no-body opts type.
 */
interface RequestBody {
  readonly body: unknown | undefined;
  readonly contentType?: string;
}

const NO_BODY: RequestBody = { body: undefined };

const sendOnce = async <T>(
  deps: AuthedClientDeps,
  method: string,
  path: string,
  token: string,
  payload: RequestBody,
  opts: AuthedRequestOpts<T>,
): Promise<SendOutcome<T>> => {
  const fullUrl = buildUrl(deps.config.baseUrl, path);
  const timeoutMs = opts.timeoutMs ?? deps.config.timeoutMs;
  const body = payload.body;

  const headers: Record<string, string> = {
    ...deps.config.defaultHeaders,
    ...opts.headers,
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = payload.contentType ?? "application/json";
  }

  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs != null) {
    controller = new AbortController();
    const ctrl = controller;
    timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  }

  try {
    const response = await deps.fetch(fullUrl, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });

    if (response.status === 401) {
      await response.text().catch(() => "");
      return { tag: "unauthorized" };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "<body unreadable>");
      // 5xx, 429 (rate-limit) and 408 (request timeout) are the retriable HTTP
      // signals → transient. Every other non-2xx (deterministic 4xx) is a
      // non-retriable node-crash: retrying the same request would fail again.
      if (isRetriableHttpStatus(response.status)) {
        return { tag: "error", error: makeTransientError(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`, response.status) };
      }
      return { tag: "error", error: makeNodeCrashError(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`) };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (parseError) {
      return {
        tag: "error",
        error: makeNodeCrashError(
          `Response body was not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)} (${method} ${fullUrl})`,
        ),
      };
    }

    const parsed = opts.schema.safeParse(responseBody);
    if (!parsed.success) {
      return { tag: "error", error: makeNodeCrashError(`Response validation failed: ${parsed.error.message}`) };
    }
    return { tag: "ok", value: parsed.data };
  } catch (error: unknown) {
    // Distinguish OUR timeout abort from a foreign cancellation. The abort
    // reason on the controller's signal is the source of truth (a
    // signal-respecting fetch rejects with that reason): our timeout aborts with
    // `Error("timeout")`; an external cancel aborts with no/other reason.
    const reason: unknown = controller?.signal.reason;
    const isOurTimeout =
      (reason instanceof Error && reason.message === "timeout") ||
      (error instanceof Error && (error.message === "timeout" || error.name === "TimeoutError"));
    const isAbort =
      controller?.signal.aborted === true ||
      (error instanceof Error && error.name === "AbortError");

    // Our OWN timeout → transient: a slow endpoint should be retried.
    if (isOurTimeout) {
      return { tag: "error", error: makeTransientError(`HTTP request timed out after ${timeoutMs}ms: ${method} ${fullUrl}`) };
    }
    // A non-timeout abort means the caller/node cancelled this request →
    // non-retriable node-crash: auto-retrying cancelled work defeats the cancel.
    if (isAbort) {
      return { tag: "error", error: makeNodeCrashError(`HTTP request cancelled: ${method} ${fullUrl}`) };
    }
    return {
      tag: "error",
      error: makeTransientError(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`),
    };
  } finally {
    if (timer != null) clearTimeout(timer);
  }
};

/**
 * Execute a request with token injection and a single `401` retry: mint, send;
 * on `401` invalidate + re-mint + send once more. Any failure to mint a token
 * short-circuits to that error. No exception escapes.
 */
const execute = async <T>(
  deps: AuthedClientDeps,
  method: string,
  path: string,
  payload: RequestBody,
  opts: AuthedRequestOpts<T>,
): Promise<Result<T, FrameworkError>> => {
  const first = await deps.tokens.get();
  if (!first.ok) return err(first.error);

  const outcome = await sendOnce(deps, method, path, first.value, payload, opts);
  if (outcome.tag === "ok") return ok(outcome.value);
  if (outcome.tag === "error") return err(outcome.error);

  // outcome.tag === "unauthorized": invalidate, re-mint, retry exactly once.
  deps.tokens.invalidate();
  const second = await deps.tokens.get();
  if (!second.ok) return err(second.error);

  const retry = await sendOnce(deps, method, path, second.value, payload, opts);
  if (retry.tag === "ok") return ok(retry.value);
  if (retry.tag === "error") return err(retry.error);
  // A second consecutive 401 — surface as a non-retriable auth failure rather
  // than looping. The credentials/token are not included (NFR-010).
  return err(makeNodeCrashError(`Authentication failed after token refresh: ${method} ${path} returned 401`));
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an `AuthedHttpCapability` over an injected token provider and fetch
 * seam. Exported for testing — `createHttpAuthAdapter` is the production entry
 * point that owns provider construction and lifecycle.
 */
export const createAuthedHttpClient = (deps: AuthedClientDeps): AuthedHttpCapability => ({
  get: <T>(path: string, opts: AuthedRequestOpts<T>) =>
    execute(deps, "GET", path, NO_BODY, opts),
  post: <T>(path: string, opts: AuthedBodyRequestOpts<T>) =>
    execute(deps, "POST", path, { body: opts.body, contentType: opts.contentType }, opts),
  put: <T>(path: string, opts: AuthedBodyRequestOpts<T>) =>
    execute(deps, "PUT", path, { body: opts.body, contentType: opts.contentType }, opts),
  patch: <T>(path: string, opts: AuthedBodyRequestOpts<T>) =>
    execute(deps, "PATCH", path, { body: opts.body, contentType: opts.contentType }, opts),
  delete: <T>(path: string, opts: AuthedRequestOpts<T>) =>
    execute(deps, "DELETE", path, NO_BODY, opts),
});

export { CLIENT_NODE_ID };
