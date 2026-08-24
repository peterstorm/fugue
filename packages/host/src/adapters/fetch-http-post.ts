/**
 * createFetchHttpPost — the ONE live `fetch`-backed transport behind every OAuth
 * form-POST egress in this package: both the Keycloak token endpoint AND the
 * Entra WIF exchange (`adapters/entra-wif.ts`). Both POST an
 * `application/x-www-form-urlencoded` body and consume the SAME `{ status, json }`
 * response shape, so they share ONE transport rather than each hardcoding `fetch`
 * (AD-2). The transport is itself the injected `HttpPost` port the exchanges take
 * — so a unit test drives the exact form body + response mapping with a recorded
 * fake, and ONLY this module ever touches the network.
 *
 * `fetch` is INJECTED (defaulting to the global) so this module's own tests are
 * network-free: a fake `fetch` records the request and returns a scripted
 * Response, with no socket opened.
 *
 * CONTRACT WITH THE CALLER (NFR-020 — no swallowed errors, no bare throws across
 * the seam):
 *   - A SETTLED HTTP response (any status, parseable or not) RESOLVES to
 *     `{ status, json }`. A non-JSON / empty body resolves with `json = {}` so
 *     the caller's pure `mapWifResponse`/Keycloak mapper still classifies it by
 *     STATUS (a 4xx with an HTML error page is a denial, a 5xx a reach failure) —
 *     a parse hiccup never masquerades as a transport failure.
 *   - A TRANSPORT-LEVEL failure (DNS/socket/`fetch` reject) REJECTS, exactly as
 *     the `HttpPost` port documents: the caller's `try/catch` maps it to
 *     `infra-unreachable`. This module deliberately does NOT translate to the
 *     framework error channel — the per-egress caller owns that mapping (it knows
 *     its own `hop`/`operation`), and re-throwing keeps this transport a single
 *     responsibility: speak HTTP, surface what HTTP did.
 *
 * @satisfies FR-002 — a live transport for OAuth form-POST exchanges (Keycloak + Entra).
 * @satisfies AD-2 — ONE `HttpPost` reused by both form-POST egresses.
 * @satisfies NFR-020 — settled responses surface as typed `{ status, json }`; a
 *   transport fault propagates (not swallowed) for the caller's typed mapping.
 */

import { parseJsonObject } from "./parse-json-object.js";

/**
 * A minimal HTTP POST transport — the SHARED port behind every OAuth form-POST
 * egress in this package (the Keycloak token endpoint AND the Entra WIF
 * exchange). Declared here, with its one live `fetch`-backed implementation
 * (`createFetchHttpPost`), rather than in either egress's adapter — so neither
 * Keycloak nor Entra depends on the other for this foundational transport type.
 */
export interface HttpPost {
  /**
   * POST `body` (already URL-encoded) to `url` with `application/x-www-form-urlencoded`.
   * Resolves to the status + parsed JSON body, or rejects on a transport-level
   * failure (DNS/socket) which the live impl maps to `infra-unreachable`.
   */
  readonly post: (url: string, body: string) => Promise<HttpPostResponse>;
}

/** The response shape the live impl consumes from the transport. */
export interface HttpPostResponse {
  readonly status: number;
  /** The parsed JSON body. Endpoints return `access_token`/`expires_in` on success, `error*` on denial. */
  readonly json: Record<string, unknown>;
}

/** The minimal `fetch` surface this transport uses — injected for network-free tests. */
export type FetchLike = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    // A request-deadline signal. Optional so a recording fake can ignore it; the
    // live impl always passes `AbortSignal.timeout(...)` (see `createFetchHttpPost`).
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

/**
 * The default request deadline (ms) for an OAuth form-POST egress. Bounds the
 * `await` so a black-holed Keycloak/Entra endpoint can never wedge the broker
 * indefinitely (and stall every single-flight waiter behind it). The resulting
 * `AbortError` rejection is mapped by the caller's `try/catch` to the retriable
 * `infra-unreachable` — the same channel a DNS/socket fault uses (NFR-020).
 */
const DEFAULT_HTTP_POST_TIMEOUT_MS = 30_000;

/**
 * Build the live `HttpPost` transport over an injected `fetch`. The default is
 * the global `fetch`; tests pass a recording fake so no socket is opened. The
 * returned `post` RESOLVES on any settled HTTP response (mapping the body to a
 * JSON object) and REJECTS only on a transport-level fault — exactly the contract
 * `createEntraWifExchange` / the Keycloak exchange rely on. A hung endpoint REJECTS
 * with an `AbortError` once `timeoutMs` elapses (mapped to `infra-unreachable`).
 */
export const createFetchHttpPost = (
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  timeoutMs: number = DEFAULT_HTTP_POST_TIMEOUT_MS,
): HttpPost => ({
  post: async (url: string, body: string): Promise<HttpPostResponse> => {
    // A transport-level fault (DNS/socket/reject) OR a timeout abort propagates
    // untouched — the caller's `try/catch` owns the `infra-unreachable` mapping
    // (it knows its hop). Swallowing it here would erase the distinction (NFR-020).
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, json: parseJsonObject(text) };
  },
});
