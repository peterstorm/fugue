/**
 * EntraWifExchange — the Workload Identity Federation (WIF) port the broker
 * reaches AFTER a successful Keycloak mint to obtain an app-only Microsoft
 * Graph / Dynamics token. This is the SECOND egress in the authority path, and
 * like `KeycloakTokenEndpoint` it is an INJECTED port — never a hardcoded
 * `fetch` — so the security invariants are provable against a call-recording
 * fake with NO live network.
 *
 * THE HEADLINE INVARIANT — no static Entra credential exists (SC-011). The
 * Keycloak service-account token IS the credential: it is presented as the
 * `client_assertion` in a `client_credentials` request to Entra (the federated
 * identity credential / WIF trust the `fugue-agents` app declares). There is NO
 * `client_secret` and NO certificate anywhere on this path.
 *
 * Two HOST-SIDE structural guarantees this module actually emits and a test can
 * assert against the form body: (1) the assertion type is the OAuth jwt-bearer
 * URN, and (2) NO `client_secret`/certificate parameter is ever present (SC-011).
 * Neither is configurable, so a request can never accidentally widen them.
 *
 * The assertion's OWN `aud` claim (`api://AzureADTokenExchange`) is NOT a field
 * this host emits — it is stamped into the Keycloak SA token by the
 * `entra-exchange` protocol mapper at mint time (FR-W4-003) and enforced
 * Azure-side by the `fugue-agents` federated-identity-credential (FIC) config.
 * `AZURE_AD_TOKEN_EXCHANGE_AUDIENCE` below is the reference value those two sides
 * must agree on (informational), not a request parameter.
 *
 * Error mapping (FR-X-002): an Entra FIC subject/issuer mismatch, a WIF
 * rejection, or a resource-scoping denial all collapse into one
 * `downstream-denied` (a settled authorization "no", carrying `resource` +
 * `reason` for the audit). A transient reach failure (DNS/socket/5xx, "we never
 * got an answer") surfaces as `infra-unreachable`, kept DISTINCT so retry policy
 * can branch on the kind alone. The port NEVER throws across the boundary.
 *
 * @satisfies US7 — a node reaches Graph/Dynamics through a narrowed handle over
 *   an app-only token minted via WIF; no static Entra secret exists.
 * @satisfies FR-W4-004 — the Keycloak SA token is presented as `client_assertion`
 *   in a `client_credentials` request to Entra; an app-only token is returned;
 *   no stored Entra secret or certificate.
 * @satisfies FR-X-002 — FIC mismatch / WIF rejection / resource-scoping denial
 *   collapse into `downstream-denied`, kept distinct from `infra-unreachable`.
 * @satisfies SC-011 — 0 static Entra secrets/certificates on this path.
 */

import type { Result, FrameworkError } from "@fuguejs/framework";
import { err } from "@fuguejs/framework";
import type { DownstreamScope } from "../domain/capability-scope.js";
import type { HttpPost, HttpPostResponse } from "./fetch-http-post.js";
import { parseOAuthTokenBody } from "./oauth-token-body.js";

/**
 * The reference `aud` value an Entra federated-credential `client_assertion` must
 * carry. This is the Azure AD token-exchange audience. NOTE: this host does NOT
 * emit it — the assertion's `aud` is stamped into the Keycloak SA token by the
 * `entra-exchange` protocol mapper (FR-W4-003) and validated Azure-side by the
 * `fugue-agents` FIC. This constant is the single value those two sides must
 * AGREE on, kept here as the documented reference (informational), so a drift
 * between the Keycloak mapper and the Azure FIC has one canonical anchor.
 */
export const AZURE_AD_TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange" as const;

/**
 * The OAuth 2.0 `client_assertion_type` URN for a JWT bearer assertion
 * (RFC 7523). Fixed and structural — the only assertion type WIF accepts.
 */
export const JWT_BEARER_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" as const;

/**
 * An app-only downstream token returned by the WIF exchange, together with its
 * lifetime in seconds (Entra `expires_in`). Mirrors `MintedToken` from the
 * Keycloak port — the broker converts `expiresInSec` to absolute expiry via the
 * pure token-cache arithmetic; this port stays oblivious to the cache.
 */
export interface AppOnlyToken {
  readonly accessToken: string;
  /** Token lifetime in SECONDS (Entra `expires_in`); the broker converts to absolute expiry. */
  readonly expiresInSec: number;
}

/**
 * Inputs for one WIF exchange. The Keycloak SA token is the credential
 * (`clientAssertion`); `scope` names the downstream operation and `audience` the
 * Graph/Dynamics resource the app-only token is narrowed to.
 */
export interface WifExchangeRequest {
  /**
   * The Keycloak service-account access token, presented verbatim as the Entra
   * `client_assertion`. THIS is the credential — there is no secret/cert.
   */
  readonly clientAssertion: string;
  /** The parsed downstream scope being requested — exactly what `requires` named. */
  readonly scope: DownstreamScope;
  /** The downstream resource/audience the app-only token is narrowed to (Graph/Dynamics). */
  readonly audience: string;
}

/**
 * The WIF exchange port. One method — `exchange` — returning
 * `Result<AppOnlyToken, FrameworkError>`; it never throws. The broker calls this
 * ONLY after a successful Keycloak mint for an assigned scope, so a fail-closed
 * policy refusal never reaches it (the no-egress guarantee extends to this
 * second egress, asserted against a call-recording fake).
 */
export interface EntraWifExchange {
  readonly exchange: (req: WifExchangeRequest) => Promise<Result<AppOnlyToken, FrameworkError>>;
}

// ───────────────────────────────────────────────────────────────────────────
// Live implementation over an injected HTTP transport
//
// The real exchange POSTs an application/x-www-form-urlencoded body to the
// `fugue-agents` Entra token endpoint. The transport is INJECTED (the shared
// `HttpPost` from `fetch-http-post.ts`), so unit tests drive the exact form body
// and response mapping with NO live network and NO `fetch` mock. The body is
// built PURELY by `buildWifFormBody`, exported so a test can assert the audience
// pin, the assertion-type URN, and the absence of any `client_secret`/cert field.
// ───────────────────────────────────────────────────────────────────────────

/** Static config for the live exchange — tenant + the one `fugue-agents` client id. */
export interface EntraWifConfig {
  /** Entra tenant id — selects the token endpoint host path. */
  readonly tenantId: string;
  /** The single `fugue-agents` Entra app (client) id (AD-3 — one app per trust boundary). */
  readonly clientId: string;
}

/**
 * A tenant id Entra accepts AND that is safe to interpolate into the token URL:
 * a GUID, a verified domain (`contoso.onmicrosoft.com`), or a well-known alias
 * (`common`/`organizations`/`consumers`). The charset `[A-Za-z0-9.-]` admits all
 * three and ADMITS NO path separator, query, or fragment — so a typo'd or hostile
 * value cannot inject extra URL segments rather than failing loudly (review
 * suggestion).
 */
const TENANT_ID_RE = /^[A-Za-z0-9.-]{1,128}$/;

/**
 * Build the v2.0 token endpoint URL for the configured tenant. Exported for the
 * live round-trip test's assertion; pure. Throws on a structurally-invalid tenant
 * id (a boot-wiring defect — `EntraWifConfig` comes from host config), so a bad
 * value can never be interpolated into the endpoint URL unchecked.
 */
export const wifTokenEndpoint = (cfg: EntraWifConfig): string => {
  if (!TENANT_ID_RE.test(cfg.tenantId)) {
    throw new Error(
      `wifTokenEndpoint: invalid tenantId '${cfg.tenantId}' — must be a GUID, a verified domain, ` +
        `or a well-known alias (charset [A-Za-z0-9.-]); refusing to build a token URL from it`,
    );
  }
  return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
};

/**
 * Build the URL-encoded `client_credentials` form body for a WIF exchange. PURE
 * and exported so a test asserts, with zero network, the HOST-SIDE structural
 * guarantees this body actually emits:
 *   - `client_assertion_type` is the jwt-bearer URN (structural, emitted here).
 *   - NO `client_secret` and NO certificate field appear (SC-011, emitted here):
 *     the caller-provided Keycloak SA token IS the credential.
 *   - the requested `scope` is the downstream resource's `.default` (app-only) —
 *     the host-side `.default` request half of FR-W4-005's narrowing (the
 *     operation-method/URL half lives in graph-capability.ts).
 *
 * NOT emitted here: the assertion's `aud` claim
 * (`api://AzureADTokenExchange`). That pin is an AZURE-SIDE federated-credential
 * (FIC) constraint, mirrored Keycloak-side by the `entra-exchange` protocol
 * mapper that stamps `aud` into the SA assertion at mint time (FR-W4-003) — it is
 * a property of the assertion token, not a field this request carries.
 */
export const buildWifFormBody = (cfg: EntraWifConfig, req: WifExchangeRequest): string => {
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", cfg.clientId);
  // The Keycloak SA token IS the credential — presented as the assertion. There
  // is deliberately NO client_secret / client certificate parameter (SC-011).
  params.set("client_assertion_type", JWT_BEARER_ASSERTION_TYPE);
  params.set("client_assertion", req.clientAssertion);
  // App-only: request the resource's `.default` scope; the resource audience
  // narrows where the union-permission token can act (FR-W4-005).
  params.set("scope", `${req.audience}/.default`);
  return params.toString();
};

/**
 * Map an Entra token response to the framework error/Result channel. PURE and
 * exported so the FIC-mismatch / WIF-rejection / resource-denial → `downstream-denied`
 * mapping and the transient → `infra-unreachable` mapping are unit-testable.
 *
 * - `200` with an `access_token` → `ok(AppOnlyToken)`.
 * - a 4xx authorization status (`400`/`401`/`403`) → `downstream-denied`: a
 *   settled "no" (FIC mismatch, WIF rejection, resource-scoping denial all
 *   collapse here per FR-X-002). `reason` carries Entra's `error_description`
 *   (or `error`), `resource` the audience that was refused.
 * - `429`/`503` throttling → `infra-unreachable`, but with a message NAMING the
 *   throttle/rate-limit so operators aren't misdirected by a generic "unreachable"
 *   line. Retry semantics are identical to any other `infra-unreachable`.
 * - any other status (5xx, unexpected) → `infra-unreachable`: "we never got an
 *   answer", retriable, distinct from a denial.
 */
export const mapWifResponse = (
  audience: string,
  res: HttpPostResponse,
): Result<AppOnlyToken, FrameworkError> => {
  if (res.status === 200) {
    const token = parseOAuthTokenBody(res.json);
    if (token.ok) return token;
    // 200 but a malformed body — treat as a reach failure, not a denial: we did
    // not get a usable answer. A4 (intentional, documented): a 2xx without a
    // usable token is mapped to the retriable `infra-unreachable` channel rather
    // than surfacing a half-built `AppOnlyToken` — read-handle tolerance is
    // deliberately NOT attempted here.
    return err({
      kind: "infra-unreachable",
      operation: "federation",
      hop: "entra-wif",
      message: "Entra WIF returned 200 without a usable access_token/expires_in",
    });
  }

  // A settled authorization "no" — FIC mismatch / WIF rejection / resource denial
  // all collapse into one `downstream-denied` (FR-X-002).
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const described = [res.json.error_description, res.json.error]
      .find((value): value is string => typeof value === "string");
    const reason = described ?? `Entra WIF denied (HTTP ${res.status})`;
    return err({ kind: "downstream-denied", resource: audience, reason });
  }

  // Throttling (429) / service-unavailable (503): still a retriable reach failure
  // (`infra-unreachable`), but name the throttle so operators read the right cause
  // rather than a generic "unreachable". Retry policy is unchanged.
  if (res.status === 429 || res.status === 503) {
    return err({
      kind: "infra-unreachable",
      operation: "federation",
      hop: "entra-wif",
      message: `Entra WIF throttled (HTTP ${res.status})`,
    });
  }

  // Anything else (other 5xx, surprising status) is a reach failure — retriable.
  return err({
    kind: "infra-unreachable",
    operation: "federation",
    hop: "entra-wif",
    message: `Entra WIF unreachable or unexpected status (HTTP ${res.status})`,
  });
};

/**
 * Construct the live WIF exchange over an injected HTTP transport + static
 * config. THROWS at construction on a structurally-invalid `tenantId` (a
 * genuine boot-wiring defect, surfaced at boot — never per-exchange), so the
 * returned port keeps its contract: a transport-level rejection (the `post`
 * promise rejecting) is a reach failure → `infra-unreachable`; a settled HTTP
 * response is mapped by `mapWifResponse`. The `exchange` method itself NEVER
 * throws across the boundary.
 */
export const createEntraWifExchange = (
  cfg: EntraWifConfig,
  http: HttpPost,
): EntraWifExchange => {
  // Validate ONCE at construction: a deterministic config typo must fail the
  // boot loudly, not surface per-exchange as a retriable `infra-unreachable`
  // through the broker's port fence (it would be retried, counted against the
  // circuit, and reported as a transient outage).
  const url = wifTokenEndpoint(cfg);
  return {
    exchange: async (req) => {
      const body = buildWifFormBody(cfg, req);
      let res: HttpPostResponse;
      try {
        res = await http.post(url, body);
      } catch (e) {
        // Transport-level failure (DNS/socket) — we never reached an answer.
        return err({
          kind: "infra-unreachable",
          operation: "federation",
          hop: "entra-wif",
          message: `Entra WIF transport failure: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return mapWifResponse(req.audience, res);
    },
  };
};
