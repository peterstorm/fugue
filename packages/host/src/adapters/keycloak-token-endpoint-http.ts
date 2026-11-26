/**
 * createKeycloakTokenEndpoint — the LIVE `KeycloakTokenEndpoint` over an injected
 * HTTP transport. This is the FIRST egress in the broker's authority path: it
 * mints a Keycloak service-account token via `client_credentials` (FR-010), which
 * the broker then presents to the Entra WIF exchange (`adapters/entra-wif.ts`) as
 * the `client_assertion` to obtain the app-only downstream token. The WIF leg is a
 * SEPARATE port — this module never reaches Entra.
 *
 * Mirrors the `adapters/entra-wif.ts` split EXACTLY:
 *   - a pure body-builder (`buildClientCredentialsBody`) that emits the exact
 *     `application/x-www-form-urlencoded` form with NO extra params, so a test
 *     asserts the wire shape with zero network;
 *   - a pure response-mapper (`mapKeycloakTokenResponse`) mapping status → Result
 *     (200 → minted token, 4xx → `downstream-denied`, 5xx/transient →
 *     `infra-unreachable`), kept DISTINCT so retry policy branches on kind alone;
 *   - a thin I/O shell that calls the injected `HttpPost` (the shared
 *     `createFetchHttpPost` transport, AD-2) and NEVER throws across the boundary.
 *
 * SECURITY / fail-closed (FR-012, NFR-010): the agent's per-client credential is
 * resolved through the injected `AgentClientCredentials` lookup. A MISS (an
 * unknown / unconfigured agent client) returns `undefined`, so the endpoint has
 * NOTHING to present and refuses at THIS hop with `downstream-denied` BEFORE any
 * HTTP egress — there is no shared/defaulted secret, and the WIF leg downstream is
 * never reached (zero Entra egress). NFR-014: the client secret is sent only in
 * the POST body; it is NEVER logged, returned, or placed in an error message.
 *
 * Only the agent's own identity is ever presented (INV-1, FR-002, FR-003): the
 * one grant this module builds is `client_credentials` AS the agent client. It
 * performs no user token exchange for any run origin.
 *
 * @satisfies FR-010 — mint a Keycloak SA token via `client_credentials`.
 * @satisfies FR-012 / NFR-010 — an un-granted/unknown agent client is refused at
 *   the Keycloak hop with zero downstream (Entra) egress.
 * @satisfies NFR-014 — the client secret is never logged or surfaced.
 */

import type { Result, FrameworkError } from "@fuguejs/framework";
import { err, safeErrorMessage } from "@fuguejs/framework";
import { scopeName } from "../domain/capability-scope.js";
import { agentClientIdFromFrameworkOrigin } from "../domain/auth.js";
import type { HttpPost, HttpPostResponse } from "./fetch-http-post.js";
import type {
  KeycloakTokenEndpoint,
  MintedToken,
  ClientCredentialsRequest,
} from "./keycloak-token-endpoint.js";
import type { KeycloakClientCredential, AgentClientCredentials } from "./agent-client-credentials.js";
import { parseOAuthTokenBody, oauthErrorDescription } from "./oauth-token-body.js";

/** Static config for the live Keycloak token endpoint — just the token URL. */
interface KeycloakTokenEndpointConfig {
  /**
   * The Keycloak realm token endpoint the agent-client mint POSTs to
   * (`.../protocol/openid-connect/token`). Already validated https at boot
   * (`KEYCLOAK_TOKEN_URL`) — the agent client secret is sent here.
   */
  readonly tokenUrl: string;
}

/**
 * Build a reach failure on the client-credentials mint hop, the only egress this
 * module performs.
 */
const mintUnreachable = (message: string): FrameworkError => ({
  kind: "infra-unreachable",
  operation: "mint",
  hop: "client-credentials",
  message,
});

// ───────────────────────────────────────────────────────────────────────────
// Pure body-builder — emits the EXACT form body with NO extra params
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the URL-encoded `client_credentials` form body for a Keycloak SA-token
 * mint (FR-010). PURE and exported so a test asserts the EXACT wire shape with
 * zero network:
 *   - `grant_type=client_credentials`,
 *   - `client_id` / `client_secret` — the per-agent-client credential (the SA
 *     identity the token is minted AS),
 *   - `scope` — the requested downstream scope name (narrowing),
 *   - `audience` — the downstream resource the SA token is narrowed to.
 * NO other params are emitted. The secret appears ONLY in this body (NFR-014).
 */
export const buildClientCredentialsBody = (
  cred: KeycloakClientCredential,
  req: ClientCredentialsRequest,
): string => {
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", cred.clientId);
  params.set("client_secret", cred.clientSecret);
  params.set("scope", scopeName(req.scope));
  params.set("audience", req.audience);
  return params.toString();
};

// ───────────────────────────────────────────────────────────────────────────
// Pure response-mapper — status → Result
// ───────────────────────────────────────────────────────────────────────────

/**
 * Map a Keycloak token-endpoint response to the framework error/Result channel.
 * PURE and exported so the status → kind mapping is unit-testable. Every
 * `infra-unreachable` is attributed to the client-credentials mint hop.
 *
 * - `200` with `access_token` + positive-finite `expires_in` → `ok(MintedToken)`.
 *   A 200 with a MALFORMED body (missing/NaN/Infinity/non-positive `expires_in`)
 *   is treated as a reach failure (`infra-unreachable`), never a half-built token
 *   (mirrors `mapWifResponse`): a born-stale / never-expiring cache entry is worse
 *   than a retry.
 * - `400`/`401`/`403` → `downstream-denied`: a settled authorization "no" (bad
 *   client credential, scope/audience not permitted), carrying the Keycloak
 *   `error_description` (or `error`) as `reason` and the audience as `resource`.
 * - `429`/`503` throttling → `infra-unreachable`, message NAMES the throttle so
 *   operators read the rate-limit, not a generic "unreachable".
 * - any other status (other 5xx, surprising) → `infra-unreachable` (retriable).
 */
export const mapKeycloakTokenResponse = (
  audience: string,
  res: HttpPostResponse,
): Result<MintedToken, FrameworkError> => {
  if (res.status === 200) {
    const token = parseOAuthTokenBody(res.json);
    if (token.ok) return token;
    return err(mintUnreachable("Keycloak token endpoint returned 200 without a usable access_token/expires_in"));
  }

  // A settled authorization "no" — bad credential / scope or audience not
  // permitted for this client. A denial is an answer, not an outage.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const reason = oauthErrorDescription(res.json) ?? `Keycloak token endpoint denied (HTTP ${res.status})`;
    return err({ kind: "downstream-denied", resource: audience, reason });
  }

  // Throttling (429) / service-unavailable (503): a retriable reach failure, but
  // name the throttle so operators read the right cause.
  if (res.status === 429 || res.status === 503) {
    return err(mintUnreachable(`Keycloak token endpoint throttled (HTTP ${res.status})`));
  }

  // Anything else (other 5xx, surprising status) — a reach failure, retriable.
  return err(mintUnreachable(`Keycloak token endpoint unreachable or unexpected status (HTTP ${res.status})`));
};

// ───────────────────────────────────────────────────────────────────────────
// Live implementation over an injected HTTP transport
// ───────────────────────────────────────────────────────────────────────────

/** Dependencies for the live Keycloak token endpoint — all I/O injected. */
interface KeycloakTokenEndpointDeps {
  /** Static config: the realm token URL (https-validated at boot). */
  readonly config: KeycloakTokenEndpointConfig;
  /** The injected HTTP POST transport (the shared `createFetchHttpPost`, AD-2). */
  readonly http: HttpPost;
  /**
   * Per-agent-client credential resolver. A MISS returns `undefined`, so the
   * mint refuses at this hop with zero egress (FR-012 / NFR-010 fail-closed).
   */
  readonly credentials: AgentClientCredentials;
}

/**
 * Build a `downstream-denied` for an un-granted/unknown agent client. The refusal
 * happens BEFORE any HTTP egress (FR-012), so the WIF leg downstream is never
 * reached. `reason` names the missing credential WITHOUT echoing any secret.
 */
const noCredentialRefusal = (agentClientId: string, audience: string): FrameworkError => ({
  kind: "downstream-denied",
  resource: audience,
  reason: `no Keycloak client credential configured for agent client '${agentClientId}'`,
});

/**
 * Construct the live Keycloak token endpoint over the injected transport +
 * credential resolver. The mint resolves the agent credential, refuses BEFORE any
 * egress if there is none, POSTs the `client_credentials` body and maps the
 * response. It returns on the Result channel and NEVER throws across the
 * boundary: a transport-level rejection (the `post` promise rejecting, e.g.
 * DNS/socket) is mapped to `infra-unreachable` rendering only the transport
 * error's own text, never the request body (NFR-014); a settled HTTP response is
 * mapped by `mapKeycloakTokenResponse`.
 */
export const createKeycloakTokenEndpoint = (
  deps: KeycloakTokenEndpointDeps,
): KeycloakTokenEndpoint => {
  const { config, http, credentials } = deps;

  return {
    mintClientCredentials: async (req: ClientCredentialsRequest) => {
      const cred = credentials(agentClientIdFromFrameworkOrigin(req.agentClientId));
      if (cred === undefined) {
        return err(noCredentialRefusal(req.agentClientId, req.audience));
      }
      let res: HttpPostResponse;
      try {
        res = await http.post(config.tokenUrl, buildClientCredentialsBody(cred, req));
      } catch (e) {
        // Transport-level failure (DNS/socket) — we never reached an answer.
        return err(mintUnreachable(`Keycloak token endpoint transport failure: ${safeErrorMessage(e)}`));
      }
      return mapKeycloakTokenResponse(req.audience, res);
    },
  };
};
