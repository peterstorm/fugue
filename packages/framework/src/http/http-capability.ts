/**
 * Built-in HTTP capability implementation using native `fetch`.
 *
 * Wraps the standard Fetch API with:
 * - Zod schema validation of response bodies
 * - Result-based error handling (no exceptions escape)
 * - Configurable base URL, default headers, and timeout
 * - FrameworkError mapping for network, timeout, and validation failures
 *
 * @example
 * ```ts
 * const httpHandle = createHttpCapability({
 *   baseUrl: "https://api.example.com",
 *   defaultHeaders: { "Authorization": `Bearer ${token}` },
 *   timeoutMs: 10_000,
 * });
 * ```
 */

import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import type { HttpCapability, HttpRequestOpts, HttpBodyRequestOpts } from "../types/http-capability.js";
import type { CapabilityHandle } from "../types/capability-handle.js";
import { nodeId } from "../types/ids.js";
import { frameworkError } from "../types/error-factories.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HttpCapabilityConfig {
  /** Base URL prepended to all relative paths. */
  readonly baseUrl?: string;
  /** Default headers applied to every request (overridable per-call). */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Default timeout in ms (overridable per-call). */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sentinel node ID for HTTP capability errors (not tied to a specific DAG node). */
const HTTP_NODE_ID = nodeId("http-capability");

const buildUrl = (baseUrl: string | undefined, url: string): string => {
  if (!baseUrl || url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}`;
};

// Route through the canonical `frameworkError.transient` factory so the
// `httpStatus` spread logic lives in exactly one place; this helper just pins
// the HTTP sentinel node id.
const makeTransientError = (message: string, httpStatus?: number): FrameworkError =>
  frameworkError.transient(HTTP_NODE_ID, message, httpStatus);

const makeNodeCrashError = (message: string): FrameworkError => ({
  kind: "node-crash",
  nodeId: HTTP_NODE_ID,
  message,
  retriability: "non-retriable",
});

async function executeRequest<T>(
  method: string,
  url: string,
  body: unknown | undefined,
  opts: HttpRequestOpts<T> | HttpBodyRequestOpts<T>,
  config: HttpCapabilityConfig,
): Promise<Result<T, FrameworkError>> {
  const fullUrl = buildUrl(config.baseUrl, url);
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;

  const headers: Record<string, string> = {
    ...config.defaultHeaders,
    ...opts.headers,
  };

  if (body !== undefined && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = (opts as HttpBodyRequestOpts<T>).contentType ?? "application/json";
  }

  // Build abort controller for timeout
  let controller: AbortController | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  const signal = opts.signal;

  if (timeoutMs != null || signal) {
    controller = new AbortController();
    const ctrl = controller;

    // If the signal is already aborted, abort immediately
    if (signal?.aborted) {
      return err({ kind: "aborted", reason: `HTTP request aborted: ${method} ${fullUrl}` });
    }

    if (timeoutMs != null) {
      timeoutId = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    }
    if (signal) {
      onExternalAbort = () => ctrl.abort(signal.reason);
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const response = await fetch(fullUrl, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });

    if (!response.ok) {
      // Best-effort body read for diagnostics — the status code is the signal.
      const text = await response.text().catch(() => "<body unreadable>");
      return err(makeTransientError(
        `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
        response.status,
      ));
    }

    // Distinguish transport/parse failure from schema failure: a malformed
    // body (truncated JSON, HTML gateway page) must not silently become
    // `null` and vanish into a nullable schema.
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (parseError) {
      return err(makeNodeCrashError(
        `Response body was not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)} (${method} ${fullUrl})`,
      ));
    }

    const parsed = opts.schema.safeParse(responseBody);

    if (!parsed.success) {
      return err(makeNodeCrashError(
        `Response validation failed: ${parsed.error.message}`,
      ));
    }

    return ok(parsed.data);
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message === "timeout" || error.name === "TimeoutError") {
        return err(makeTransientError(`HTTP request timed out after ${timeoutMs}ms: ${method} ${fullUrl}`));
      }
      if (error.name === "AbortError") {
        return err({ kind: "aborted", reason: `HTTP request aborted: ${method} ${fullUrl}` });
      }
      return err(makeTransientError(`HTTP request failed: ${error.message}`));
    }
    return err(makeTransientError(`HTTP request failed: ${String(error)}`));
  } finally {
    // Release timer and external-signal listener on every path — without
    // this, a long-lived shared parent signal accumulates listeners (and
    // their captured controllers) across requests.
    if (timeoutId != null) clearTimeout(timeoutId);
    if (signal && onExternalAbort) signal.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const createHttpClient = (config: HttpCapabilityConfig): HttpCapability => ({
  get: <T>(url: string, opts: HttpRequestOpts<T>) =>
    executeRequest("GET", url, undefined, opts, config),

  post: <T>(url: string, body: unknown, opts: HttpBodyRequestOpts<T>) =>
    executeRequest("POST", url, body, opts, config),

  put: <T>(url: string, body: unknown, opts: HttpBodyRequestOpts<T>) =>
    executeRequest("PUT", url, body, opts, config),

  patch: <T>(url: string, body: unknown, opts: HttpBodyRequestOpts<T>) =>
    executeRequest("PATCH", url, body, opts, config),

  delete: <T>(url: string, opts: HttpRequestOpts<T>) =>
    executeRequest("DELETE", url, undefined, opts, config),
});

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create the built-in HTTP capability handle.
 *
 * @example
 * ```ts
 * import { createHttpCapability } from "@fugue/framework";
 *
 * const http = createHttpCapability({
 *   baseUrl: "https://api.example.com",
 *   defaultHeaders: { Authorization: `Bearer ${token}` },
 *   timeoutMs: 10_000,
 * });
 *
 * // Pass to runtime or makeNodeContext:
 * const ctx = makeNodeContext({ runId: "r1", dagId: "d1", http: http.client });
 * ```
 */
export const createHttpCapability = (
  config: HttpCapabilityConfig = {},
): CapabilityHandle<"http"> => ({
  name: "http",
  client: createHttpClient(config),
  // HTTP capability is stateless (no connection pool) — no connect/close needed.
});

/**
 * Create a fake HTTP capability for testing. Accepts a response map that
 * matches URL patterns to canned responses. Route values are either the raw
 * response body, or a `FakeHttpRoute` (`{ status?, body }`) when you need to
 * simulate an error status — a `status` outside 2xx produces the same
 * `transient` error (with `httpStatus` set) as the real capability.
 *
 * @example
 * ```ts
 * const fakeHttp = createFakeHttpCapability({
 *   "GET /users/123": { id: "123", name: "Alice" },
 *   "POST /orders": { body: { orderId: "ord-1" } },
 *   "GET /users/999": { status: 404, body: "Not Found" },
 * });
 * ```
 */
export interface FakeHttpRoute {
  readonly status?: number;
  readonly body: unknown;
}

export const createFakeHttpCapability = (
  routes: Readonly<Record<string, FakeHttpRoute | unknown>>,
): CapabilityHandle<"http"> => {
  const client: HttpCapability = {
    get: async <T>(url: string, opts: HttpRequestOpts<T>) =>
      matchRoute("GET", url, opts.schema, routes),
    post: async <T>(url: string, _body: unknown, opts: HttpBodyRequestOpts<T>) =>
      matchRoute("POST", url, opts.schema, routes),
    put: async <T>(url: string, _body: unknown, opts: HttpBodyRequestOpts<T>) =>
      matchRoute("PUT", url, opts.schema, routes),
    patch: async <T>(url: string, _body: unknown, opts: HttpBodyRequestOpts<T>) =>
      matchRoute("PATCH", url, opts.schema, routes),
    delete: async <T>(url: string, opts: HttpRequestOpts<T>) =>
      matchRoute("DELETE", url, opts.schema, routes),
  };

  return { name: "http", client };
};

function matchRoute<T>(
  method: string,
  url: string,
  schema: z.ZodType<T>,
  routes: Readonly<Record<string, FakeHttpRoute | unknown>>,
): Result<T, FrameworkError> {
  const key = `${method} ${url}`;
  const route = routes[key] ?? routes[url];
  if (route == null) {
    return err(makeTransientError(`No fake route matched: ${key}`));
  }

  const isShapedRoute = typeof route === "object" && route !== null && "body" in route;

  // Mirror the real capability: a non-2xx status becomes a transient error
  // carrying `httpStatus`, so nodes branching on status are testable.
  if (isShapedRoute) {
    const status = (route as FakeHttpRoute).status;
    if (status != null && (status < 200 || status >= 300)) {
      const bodyText = String((route as FakeHttpRoute).body ?? "");
      return err(makeTransientError(`HTTP ${status}: ${bodyText.slice(0, 500)}`, status));
    }
  }

  const body = isShapedRoute ? (route as FakeHttpRoute).body : route;

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return err(makeNodeCrashError(`Fake route response validation failed: ${parsed.error.message}`));
  }
  return ok(parsed.data);
}
