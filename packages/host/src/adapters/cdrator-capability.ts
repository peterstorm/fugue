/**
 * CDRator / Oister `authedHttp` capability wiring (host boot).
 *
 * Translates the validated host `CDRATOR_*` env config into the generic
 * `@fuguejs/http-auth` capability, configured for the Oister/CDRator REST API.
 * The generic capability itself is API-agnostic (FR-060): all auth + location
 * config arrives via its factory, nothing is read from `process.env` there. This
 * adapter is the one place that maps THIS host's env into THAT factory's shape.
 *
 * The capability registers under the key `authedHttp`, so a DAG declaring
 * `requires: ["authedHttp"]` resolves once CDRator is configured.
 *
 * Gating: returns `undefined` when CDRator is not configured (CDRATOR_URL unset),
 * mirroring the optional `documents` adapter — the capability is then simply not
 * registered and a `requires: ["authedHttp"]` DAG fails the boot-time capability
 * check (zero regression). When configured, `HostConfigSchema`'s superRefine has
 * already guaranteed the required fields are present, so the non-null reads below
 * are sound by construction (parse, don't validate).
 *
 * NFR-010: the operator credentials and client secret flow ONLY from config into
 * the factory; nothing here logs them and the generic capability never surfaces
 * the minted token.
 *
 * @satisfies FR-060, NFR-010
 */

import { createHttpAuthAdapter } from "@fuguejs/http-auth";
import type { CapabilityHandle } from "@fuguejs/framework";
import type { HostConfig } from "../domain/config.js";

/**
 * Build the CDRator `authedHttp` capability handle from host config, or
 * `undefined` when CDRator is not configured.
 *
 * Pure: no I/O. Constructing the handle does NOT mint a token (that happens in
 * the handle's `connect()` at boot), so this is network-free and trivially
 * testable. `fetchOverride` is a test seam threaded into the generic capability's
 * fetch slot; production omits it (the platform `fetch` is used).
 */
export const buildCdratorCapability = (
  config: HostConfig,
  fetchOverride?: import("@fuguejs/http-auth").FetchLike,
): CapabilityHandle<"authedHttp"> | undefined => {
  // CDRATOR_URL is the gate. The superRefine in HostConfigSchema guarantees that
  // when it is set, the auth URL / brand key / operator credentials are all set.
  if (config.CDRATOR_URL === undefined) return undefined;

  const brandKey = config.CDRATOR_BRAND_KEY!;

  return createHttpAuthAdapter({
    baseUrl: config.CDRATOR_URL,
    // X-RATOR-brand-key scopes the request to the operator's brand.
    //
    // Accept-Language "DK" is the MARKET/COUNTRY value the CDRator/Oister API
    // expects (flexii's client sends exactly `Accept-Language: DK`) — it is NOT a
    // standard BCP-47 language tag. Do NOT "correct" it to `da`: the API keys off
    // the country code "DK", not the language code, and `da` would not be honoured.
    defaultHeaders: {
      "X-RATOR-brand-key": brandKey,
      "Accept-Language": "DK",
    },
    auth: {
      tokenUrl: config.CDRATOR_AUTH_URL!,
      grantType: "operator_password",
      // The brand key is also a static form field on the grant body.
      params: { brand_key: brandKey },
      // HTTP Basic on the token request only when both client id + secret are set
      // (the superRefine enforces the pair). Omitted otherwise.
      ...(config.CDRATOR_CLIENT_ID !== undefined && config.CDRATOR_CLIENT_SECRET !== undefined
        ? { basicAuth: { username: config.CDRATOR_CLIENT_ID, password: config.CDRATOR_CLIENT_SECRET } }
        : {}),
      credentials: {
        username: config.CDRATOR_USERNAME!,
        password: config.CDRATOR_PASSWORD!,
      },
    },
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
};
