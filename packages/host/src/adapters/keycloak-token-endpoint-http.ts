/**
 * createKeycloakTokenEndpoint — the LIVE `KeycloakTokenEndpoint` over an injected
 * HTTP transport. This is the FIRST egress in the broker's authority path: it
 * mints a Keycloak service-account token via `client_credentials` (FR-010), which
 * the broker then presents to the Entra WIF exchange (`adapters/entra-wif.ts`) as
 * the `client_assertion` to obtain the app-only downstream token. The WIF leg is a
 * SEPARATE port — this module never reaches Entra.
 *
 * Mirrors the `adapters/entra-wif.ts` split EXACTLY:
 *   - pure body-builders (`buildClientCredentialsBody` / `buildExchangeV2Body`)
 *     that emit the exact `application/x-www-form-urlencoded` form with NO extra
 *     params, so a test asserts the wire shape with zero network;
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
 * The USER `subject_token` exchange is now LIVE (FR-030/FR-031): `exchangeV2`
 * presents the user's verified JWT (`req.subjectToken`, branded — produced only at
 * the verify seam and threaded host-side) as the RFC 8693 `subject_token` via the
 * pure `buildExchangeV2Body`, so Keycloak preserves the user as `sub` and sets
 * `azp` to the agent client. It fails closed on a creds-miss exactly like the mint
 * path — there is no proof-less impersonation grant; the broker has already
 * refused locally when no subject token is resolvable for the run.
 *
 * @satisfies FR-010 — mint a Keycloak SA token via `client_credentials`.
 * @satisfies FR-012 / NFR-010 — an un-granted/unknown agent client is refused at
 *   the Keycloak hop with zero downstream (Entra) egress.
 * @satisfies FR-030/FR-031 — the user exchange presents the verified user JWT as
 *   `subject_token`; the exchanged token preserves `sub`=user, `azp`=agent.
 * @satisfies NFR-014 — the client secret AND the user JWT are never logged or surfaced.
 */

import type { Result, FrameworkError } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { DownstreamScope } from "../domain/capability-scope.js";
import { agentClientIdFromFrameworkOrigin } from "../domain/auth.js";
import type { HttpPost, HttpPostResponse } from "./fetch-http-post.js";
import type {
  KeycloakTokenEndpoint,
  MintedToken,
  ClientCredentialsRequest,
  ExchangeV2Request,
} from "./keycloak-token-endpoint.js";
import type { KeycloakClientCredential, AgentClientCredentials } from "./agent-client-credentials.js";

/**
 * The OAuth 2.0 Token Exchange grant URN (RFC 8693). Fixed and structural — the
 * only grant Keycloak's Standard Token Exchange V2 accepts.
 */
export const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;

/**
 * The RFC 8693 `requested_token_type` for an access token — the exchange returns
 * a downstream-narrowed access token, never an id/refresh token.
 */
export const REQUESTED_TOKEN_TYPE_ACCESS =
  "urn:ietf:params:oauth:token-type:access_token" as const;

/**
 * The RFC 8693 `subject_token_type` for the user's inbound access token presented
 * as the `subject_token` proof. The user authenticates to the host with a realm
 * access token, so the subject token's type is `access_token` (Keycloak Standard
 * Token Exchange V2 reads the `sub` off it and preserves it on the exchanged
 * downstream token — FR-031).
 */
export const SUBJECT_TOKEN_TYPE_ACCESS =
  "urn:ietf:params:oauth:token-type:access_token" as const;

/** Static config for the live Keycloak token endpoint — just the token URL. */
interface KeycloakTokenEndpointConfig {
  /**
   * The Keycloak realm token endpoint the agent-client legs POST to
   * (`.../protocol/openid-connect/token`). Already validated https at boot
   * (`KEYCLOAK_TOKEN_URL`) — the agent client secret is sent here.
   */
  readonly tokenUrl: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure body-builders — emit the EXACT form body with NO extra params
// ───────────────────────────────────────────────────────────────────────────

/**
 * The canonical `"<provider>:<operation>"` scope string Keycloak narrows the SA
 * token to. Pure; mirrors the broker's `scopeName` (kept local so this module
 * carries no broker dependency).
 */
const scopeName = (scope: DownstreamScope): string => `${scope.provider}:${scope.operation}`;

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

/**
 * Build the URL-encoded RFC 8693 Standard Token Exchange V2 form body for the
 * USER-initiated path (FR-030/FR-031). PURE and exported so a test asserts the
 * EXACT wire shape with zero network. It presents the user's verified JWT as the
 * `subject_token` proof, so Keycloak preserves the user as `sub` and sets `azp` to
 * the agent client, narrowed to `scope`/`audience`.
 *
 * Emits EXACTLY:
 *   - `grant_type` — the token-exchange URN,
 *   - `client_id` / `client_secret` — the agent client's credential (the `azp`
 *     the exchanged token is minted for — FR-031),
 *   - `subject_token` — the user's verified compact JWT (the FR-030 proof),
 *   - `subject_token_type` — access token,
 *   - `requested_token_type` — access token,
 *   - `scope` / `audience` — the downstream narrowing.
 * NO other params are emitted. The user JWT and the client secret appear ONLY in
 * this body (NFR-014) — never logged, returned, or placed in an error.
 */
export const buildExchangeV2Body = (
  cred: KeycloakClientCredential,
  req: ExchangeV2Request,
): string => {
  const params = new URLSearchParams();
  params.set("grant_type", TOKEN_EXCHANGE_GRANT_TYPE);
  params.set("client_id", cred.clientId);
  params.set("client_secret", cred.clientSecret);
  // The FR-030 proof: the user's ACTUAL verified JWT. Keycloak reads `sub` off it
  // and preserves it on the exchanged downstream token (FR-031). `req.subjectToken`
  // is branded — only the verify seam could have produced it.
  params.set("subject_token", req.subjectToken);
  params.set("subject_token_type", SUBJECT_TOKEN_TYPE_ACCESS);
  params.set("requested_token_type", REQUESTED_TOKEN_TYPE_ACCESS);
  params.set("scope", scopeName(req.scope));
  params.set("audience", req.audience);
  return params.toString();
};

// ───────────────────────────────────────────────────────────────────────────
// Pure response-mapper — status → Result
// ───────────────────────────────────────────────────────────────────────────

/**
 * Map a Keycloak token-endpoint response to the framework error/Result channel.
 * PURE and exported so the status → kind mapping is unit-testable.
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
 *
 * `operation`/`hop` are passed in so the SAME mapper serves both the mint
 * (`mint`/`client-credentials`) and exchange (`exchange`/`token-exchange`) hops,
 * keeping each `infra-unreachable` attributed to the egress that produced it.
 */
export const mapKeycloakTokenResponse = (
  audience: string,
  operation: "mint" | "exchange",
  hop: string,
  res: HttpPostResponse,
): Result<MintedToken, FrameworkError> => {
  if (res.status === 200) {
    const accessToken = res.json.access_token;
    const expiresIn = res.json.expires_in;
    // `expires_in` must parse to POSITIVE FINITE seconds at this boundary: a
    // NaN/Infinity/non-positive lifetime would mint a born-stale or
    // never-expiring cache entry downstream, so it is malformed, not usable.
    if (
      typeof accessToken === "string" &&
      typeof expiresIn === "number" &&
      Number.isFinite(expiresIn) &&
      expiresIn > 0
    ) {
      return ok({ accessToken, expiresInSec: expiresIn });
    }
    return err({
      kind: "infra-unreachable",
      operation,
      hop,
      message: "Keycloak token endpoint returned 200 without a usable access_token/expires_in",
    });
  }

  // A settled authorization "no" — bad credential / scope or audience not
  // permitted for this client. A denial is an answer, not an outage.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const description = res.json.error_description;
    const error = res.json.error;
    const reason =
      typeof description === "string"
        ? description
        : typeof error === "string"
          ? error
          : `Keycloak token endpoint denied (HTTP ${res.status})`;
    return err({ kind: "downstream-denied", resource: audience, reason });
  }

  // Throttling (429) / service-unavailable (503): a retriable reach failure, but
  // name the throttle so operators read the right cause.
  if (res.status === 429 || res.status === 503) {
    return err({
      kind: "infra-unreachable",
      operation,
      hop,
      message: `Keycloak token endpoint throttled (HTTP ${res.status})`,
    });
  }

  // Anything else (other 5xx, surprising status) — a reach failure, retriable.
  return err({
    kind: "infra-unreachable",
    operation,
    hop,
    message: `Keycloak token endpoint unreachable or unexpected status (HTTP ${res.status})`,
  });
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
 * credential resolver. Both methods return on the Result channel and NEVER throw
 * across the boundary: a transport-level rejection (the `post` promise rejecting,
 * e.g. DNS/socket) is mapped to `infra-unreachable`; a settled HTTP response is
 * mapped by `mapKeycloakTokenResponse`.
 */
export const createKeycloakTokenEndpoint = (
  deps: KeycloakTokenEndpointDeps,
): KeycloakTokenEndpoint => {
  const { config, http, credentials } = deps;

  return {
    mintClientCredentials: async (
      req: ClientCredentialsRequest,
    ): Promise<Result<MintedToken, FrameworkError>> => {
      // Fail closed BEFORE any egress on an unknown/unconfigured agent client:
      // no credential → nothing to present → refuse at the Keycloak hop with
      // ZERO downstream (Entra) egress (FR-012 / NFR-010).
      const cred = credentials(agentClientIdFromFrameworkOrigin(req.agentClientId));
      if (cred === undefined) {
        return err(noCredentialRefusal(req.agentClientId, req.audience));
      }
      const body = buildClientCredentialsBody(cred, req);
      let res: HttpPostResponse;
      try {
        res = await http.post(config.tokenUrl, body);
      } catch (e) {
        // Transport-level failure (DNS/socket) — we never reached an answer.
        return err({
          kind: "infra-unreachable",
          operation: "mint",
          hop: "client-credentials",
          message: `Keycloak token endpoint transport failure: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return mapKeycloakTokenResponse(req.audience, "mint", "client-credentials", res);
    },

    exchangeV2: async (
      req: ExchangeV2Request,
    ): Promise<Result<MintedToken, FrameworkError>> => {
      // Fail closed BEFORE any egress on an unknown/unconfigured agent client:
      // no credential → nothing to authenticate the exchange AS → refuse at the
      // Keycloak hop with ZERO downstream (Entra) egress (FR-012 / NFR-010). The
      // `req.subjectToken` (the user's verified JWT) is REQUIRED by the type, so
      // the user's proof is always present here — the broker refused locally if it
      // could not resolve one (FR-030); this never mints a proof-less token.
      const cred = credentials(agentClientIdFromFrameworkOrigin(req.agentClientId));
      if (cred === undefined) {
        return err(noCredentialRefusal(req.agentClientId, req.audience));
      }
      // Present the user's verified JWT as the RFC 8693 `subject_token` so the
      // exchanged token preserves `sub`=user and sets `azp`=agent (FR-030/FR-031).
      const body = buildExchangeV2Body(cred, req);
      let res: HttpPostResponse;
      try {
        res = await http.post(config.tokenUrl, body);
      } catch (e) {
        // Transport-level failure (DNS/socket) — we never reached an answer. The
        // message never echoes the secret or the user JWT (NFR-014).
        return err({
          kind: "infra-unreachable",
          operation: "exchange",
          hop: "token-exchange",
          message: `Keycloak token endpoint transport failure: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return mapKeycloakTokenResponse(req.audience, "exchange", "token-exchange", res);
    },
  };
};
