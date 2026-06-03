/**
 * Built-in HTTP capability — ships with the framework because every AI
 * workflow does HTTP calls. Returns `Result<T, FrameworkError>` and validates
 * responses against Zod schemas.
 *
 * Nodes declare `requires: ["http"]` to access `ctx.http`.
 */

import type { z } from "zod";
import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";

/**
 * Options for HTTP requests.
 */
export interface HttpRequestOpts<T> {
  /** Zod schema to validate the response body against. */
  readonly schema: z.ZodType<T>;
  /** Additional headers to include in the request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Options for HTTP requests that include a body.
 */
export interface HttpBodyRequestOpts<T> extends HttpRequestOpts<T> {
  /**
   * Content-Type header override. Defaults to "application/json".
   *
   * Note: this changes the *header only* — the request body is always
   * `JSON.stringify`'d by the built-in capability. Non-JSON request bodies
   * (form-encoded, multipart, raw text) are not supported here; create a
   * custom capability adapter for those.
   */
  readonly contentType?: string;
}

/**
 * Built-in HTTP capability interface. All methods return `Result` — no
 * exceptions escape. Response bodies are Zod-validated before returning.
 *
 * This capability is intentionally minimal — it covers the 80% case of
 * "call a JSON API and parse the response." For advanced HTTP needs
 * (streaming, multipart, WebSockets), create a custom capability adapter.
 */
export interface HttpCapability {
  /**
   * Perform a GET request. Response body is validated against the provided schema.
   */
  get<T>(url: string, opts: HttpRequestOpts<T>): Promise<Result<T, FrameworkError>>;

  /**
   * Perform a POST request with a JSON body. Response validated against schema.
   */
  post<T>(url: string, body: unknown, opts: HttpBodyRequestOpts<T>): Promise<Result<T, FrameworkError>>;

  /**
   * Perform a PUT request with a JSON body. Response validated against schema.
   */
  put<T>(url: string, body: unknown, opts: HttpBodyRequestOpts<T>): Promise<Result<T, FrameworkError>>;

  /**
   * Perform a PATCH request with a JSON body. Response validated against schema.
   */
  patch<T>(url: string, body: unknown, opts: HttpBodyRequestOpts<T>): Promise<Result<T, FrameworkError>>;

  /**
   * Perform a DELETE request. Response validated against schema.
   */
  delete<T>(url: string, opts: HttpRequestOpts<T>): Promise<Result<T, FrameworkError>>;
}
