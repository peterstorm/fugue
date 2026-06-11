/**
 * Unwired EntraWifExchange — the fail-closed default used until the live Entra
 * `fugue-agents` federated-credential trust is stood up against a real tenant.
 * Mirrors `unwired-token-endpoint.ts`: an ASSIGNED scope whose Keycloak mint
 * succeeded but whose WIF hop is not yet wired surfaces `infra-unreachable` (a
 * transient "we never reached an answer"), NEVER a silent success and never a
 * token.
 *
 * Crucially, this is only ever reached AFTER the broker's fail-closed policy
 * gate AND a successful Keycloak mint — an unassigned scope is refused before
 * either egress — so wiring this default preserves the zero-Entra-egress
 * guarantee for unauthorized requests (SC-006) while keeping authorized-but-not-
 * yet-wired requests on the retriable `infra-unreachable` channel.
 *
 * SC-011 holds trivially here: there is NO credential of any kind — no secret,
 * no certificate — because there is no exchange at all yet.
 */

import { err } from "@fuguejs/framework";
import type { EntraWifExchange } from "./entra-wif.js";
import type { GraphHttp } from "./graph-capability.js";

/**
 * Build the unwired WIF exchange. The single `exchange` method returns
 * `infra-unreachable` tagged with the `entra-wif` operation, so the audit trail
 * pinpoints the unwired hop.
 */
export const createUnwiredEntraWifExchange = (): EntraWifExchange => ({
  exchange: async () =>
    err({
      kind: "infra-unreachable",
      operation: "entra-wif",
      message: "Entra WIF exchange is not wired (awaiting live fugue-agents federated credential)",
    }),
});

/**
 * The matching unwired Graph HTTP transport. With the WIF exchange unwired, no
 * app-only token is ever minted, so a handle is never built and this transport
 * is never `request`ed — but the broker requires a non-undefined `graphHttp`, so
 * this fail-closed default stands in. If it were ever reached it returns a 503
 * (→ `infra-unreachable`) rather than performing a live `fetch`, preserving the
 * zero-uncontrolled-egress posture of the unwired host.
 */
export const createUnwiredGraphHttp = (): GraphHttp => ({
  request: async () => ({
    status: 503,
    json: { error: { code: "unwired", message: "Graph transport is not wired (awaiting live WIF)" } },
  }),
});
