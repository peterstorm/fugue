/**
 * Unwired KeycloakTokenEndpoint — the fail-closed default used until the real
 * JWKS/HTTP-backed token endpoint is stood up (a later wave). Mirrors how the
 * host leaves the `realmJwt` group undefined so the JWT inbound path fails closed:
 * here, the broker's minting path fails closed too, but DISTINGUISHABLY from a
 * policy refusal — every call returns `infra-unreachable` (a transient "we never
 * reached an answer"), never `policy-refusal` (a settled "no") and never a token.
 *
 * Crucially, this endpoint is only ever reached for an ASSIGNED scope — the
 * broker's local policy gate refuses unassigned scopes before any endpoint call —
 * so wiring this default preserves the fail-closed, zero-Entra-egress guarantee
 * for unauthorized requests (SC-006) while keeping authorized-but-not-yet-wired
 * requests on the retriable `infra-unreachable` channel rather than silently
 * succeeding.
 */

import { err } from "@fuguejs/framework";
import type { KeycloakTokenEndpoint } from "./keycloak-token-endpoint.js";

/**
 * Build the unwired endpoint. Both methods return `infra-unreachable` tagged with
 * the operation that was attempted, so the audit trail pinpoints the unwired hop.
 */
export const createUnwiredTokenEndpoint = (): KeycloakTokenEndpoint => ({
  mintClientCredentials: async () =>
    err({
      kind: "infra-unreachable",
      operation: "mint",
      hop: "client-credentials",
      message: "Keycloak token endpoint is not wired (awaiting JWKS/token HTTP adapter)",
    }),
  exchangeV2: async () =>
    err({
      kind: "infra-unreachable",
      operation: "exchange",
      hop: "token-exchange",
      message: "Keycloak token endpoint is not wired (awaiting JWKS/token HTTP adapter)",
    }),
});
