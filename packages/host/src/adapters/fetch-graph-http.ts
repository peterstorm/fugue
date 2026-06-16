/**
 * createFetchGraphHttp — the live `fetch`-backed transport behind the Graph
 * capability handles (`adapters/graph-capability.ts`). Unlike the form-POST
 * transport (AD-2), Graph gets its OWN transport (AD-4 split): it presents a
 * BEARER token, does GET *and* POST, sends/receives JSON bodies, and targets the
 * ABSOLUTE URLs the handle builders compute (`https://graph.microsoft.com/...`).
 * It implements the existing `GraphHttp` port so the operation bodies'
 * bearer-presentation + 4xx→`downstream-denied` mapping stay provable against a
 * recorded fake — ONLY this module touches the network.
 *
 * `fetch` is INJECTED (defaulting to the global) so this module's tests are
 * network-free.
 *
 * CONTRACT WITH THE CALLER (mirrors `createFetchHttpPost`, NFR-020):
 *   - A SETTLED HTTP response RESOLVES to `{ status, json }`; a non-JSON / empty
 *     body resolves with `json = {}` so `runGraph`/`mapGraphError` classify by
 *     STATUS (4xx → denied, 5xx → unreachable) — a parse hiccup never looks like
 *     a transport fault.
 *   - A TRANSPORT-LEVEL fault REJECTS (per the port docs) so `runGraph`'s
 *     `try/catch` maps it to `infra-unreachable`. The bearer is presented as
 *     `Authorization: Bearer <token>` and a POST body is JSON-encoded with the
 *     matching `Content-Type`.
 *
 * @satisfies FR-002 — a live transport for downstream Graph calls.
 * @satisfies AD-4 — Graph's own bearer GET/POST transport over absolute URLs,
 *   distinct from the shared form-POST `HttpPost`.
 * @satisfies NFR-020 — settled responses surface as typed `{ status, json }`; a
 *   transport fault propagates for `runGraph`'s typed mapping.
 */

import type { GraphHttp, GraphRequest, GraphResponse } from "./graph-capability.js";
import { parseJsonObject } from "./parse-json-object.js";

/** The minimal `fetch` surface the Graph transport uses — injected for network-free tests. */
export type GraphFetchLike = (
  input: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

/**
 * Build the live `GraphHttp` transport over an injected `fetch` (default: global
 * `fetch`). The bearer is presented as `Authorization: Bearer <token>`; a POST
 * carries its JSON body with `Content-Type: application/json`; a GET sends no
 * body. RESOLVES on any settled response, REJECTS only on a transport fault.
 */
export const createFetchGraphHttp = (
  fetchImpl: GraphFetchLike = globalThis.fetch as GraphFetchLike,
): GraphHttp => ({
  request: async (req: GraphRequest): Promise<GraphResponse> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${req.bearer}`,
      Accept: "application/json",
    };
    // Only a POST carries a body; encode it as JSON with the matching content
    // type. A GET sends none (Graph rejects a GET with a body on some paths).
    const init =
      req.method === "POST" && req.body !== undefined
        ? {
            method: req.method,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
          }
        : { method: req.method, headers };

    // Transport-level fault propagates untouched — `runGraph` owns the
    // `infra-unreachable` mapping (NFR-020).
    const res = await fetchImpl(req.url, init);
    const text = await res.text();
    return { status: res.status, json: parseJsonObject(text) };
  },
});
