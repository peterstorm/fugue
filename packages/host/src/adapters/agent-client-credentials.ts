/**
 * Agent client credentials port + env-map adapter.
 *
 * The capability broker's live Keycloak token endpoint mints/exchanges tokens
 * AS a per-agent Keycloak client, using that client's client-credentials. This
 * port resolves the credential for a given `AgentClientId`; the only adapter is
 * a pure lookup over the parsed `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` map.
 *
 * Fail-closed (FR-004): a miss returns `undefined`. An unknown / unconfigured
 * agent client therefore yields NO credential, so the endpoint adapter has
 * nothing to present and the leg fails closed with zero egress — never a
 * silently-shared or defaulted secret.
 *
 * NFR-014 (never logged): `KeycloakClientCredential` carries a client secret. It
 * is a plain readonly data type with NO custom `toString`/`toJSON` — callers
 * that need to log MUST log only `clientId`, never the credential object. The
 * adapter itself performs no logging.
 *
 * @satisfies FR-004 — per-agent-client credential lookup; miss is fail-closed (undefined).
 * @satisfies NFR-014 — the credential type is sensitive and must never be logged.
 */

import type { AgentClientId } from "../domain/auth.js";
import type { KeycloakClientCredentialConfig } from "../domain/config.js";

/**
 * A single Keycloak agent-client credential. SENSITIVE: `clientSecret` MUST
 * NEVER appear in logs, traces, audit records, or error messages (NFR-014).
 *
 * Deliberately a bare readonly record with no logging-friendly `toString` — the
 * default `[object Object]` is uninformative on accidental string coercion, and
 * there is no `toJSON`, so a careless `JSON.stringify` of a wrapper does not
 * conveniently surface the secret.
 */
export interface KeycloakClientCredential {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Resolve the Keycloak client credential an agent acts AS, keyed on the branded
 * `AgentClientId` (never a bare string — the brand is the broker's identity).
 * A miss returns `undefined` (fail-closed, FR-004).
 */
export type AgentClientCredentials = (agentClientId: AgentClientId) => KeycloakClientCredential | undefined;

/**
 * Build the env-map credential resolver from the parsed
 * `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` config map (keyed by agent client id).
 *
 * Pure: closes over a defensive snapshot of the map and performs a plain
 * lookup. An absent key — including the empty-map (unconfigured) case — returns
 * `undefined`, so the caller fails closed with no egress.
 *
 * @param credentialsByAgentClientId map of `agentClientId → { clientId, clientSecret }`
 *   as produced by `HostConfig.KEYCLOAK_AGENT_CLIENT_CREDENTIALS`.
 */
export const createAgentClientCredentials = (
  credentialsByAgentClientId: Readonly<Record<string, KeycloakClientCredentialConfig>>,
): AgentClientCredentials => {
  // Defensive snapshot: freeze a copy so a later mutation of the source map (or
  // its entries) cannot retroactively change what the resolver returns. The
  // resolver is then a pure function of its closed-over data.
  const snapshot: Record<string, KeycloakClientCredential> = {};
  for (const [agentClientId, cred] of Object.entries(credentialsByAgentClientId)) {
    snapshot[agentClientId] = Object.freeze({ clientId: cred.clientId, clientSecret: cred.clientSecret });
  }
  Object.freeze(snapshot);

  return (agentClientId: AgentClientId): KeycloakClientCredential | undefined => {
    // `Object.prototype` keys (e.g. "constructor", "toString") must not resolve
    // to inherited members — only OWN configured entries are valid credentials.
    if (!Object.prototype.hasOwnProperty.call(snapshot, agentClientId)) return undefined;
    return snapshot[agentClientId];
  };
};
