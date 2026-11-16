/**
 * Authority Legs — the pure config → decision core of the capability broker's
 * AD-3 config-presence gating (FR-011).
 *
 * The live broker reaches downstream authority over two legs, each wired LIVE
 * only when ITS OWN config is present (there is no single global enable flag):
 *   - the Keycloak SA-mint leg ⟸ `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` non-empty;
 *     its token URL is the explicit `KEYCLOAK_TOKEN_URL` (https-validated at
 *     boot) or, when unset, derived from the realm issuer;
 *   - the Entra WIF exchange + Graph transport leg ⟸ `ENTRA_TENANT_ID` AND
 *     `ENTRA_CLIENT_ID` (validated as an inseparable pair at boot).
 * A leg without its config stays on its fail-closed unwired stub.
 *
 * This module only DECIDES: each leg is a union of `wired` (carrying exactly
 * the config the live adapter is built from) or `unwired` (carrying the config
 * an operator must set). The host shell (`host.ts`) builds the adapters from
 * the decision and logs `unwiredLegsWarning`.
 *
 * @satisfies FR-011
 */

import type { HostConfig, KeycloakClientCredentialConfig } from "./config.js";

export type KeycloakLeg =
  | {
      readonly kind: "wired";
      readonly tokenUrl: string;
      readonly credentials: Readonly<Record<string, KeycloakClientCredentialConfig>>;
    }
  | { readonly kind: "unwired"; readonly missing: "KEYCLOAK_AGENT_CLIENT_CREDENTIALS" };

export type EntraLeg =
  | { readonly kind: "wired"; readonly tenantId: string; readonly clientId: string }
  | { readonly kind: "unwired"; readonly missing: "ENTRA_TENANT_ID and ENTRA_CLIENT_ID" };

export type AuthorityLegs = {
  readonly keycloak: KeycloakLeg;
  readonly entra: EntraLeg;
};

type LegConfig = Pick<
  HostConfig,
  "KEYCLOAK_AGENT_CLIENT_CREDENTIALS" | "KEYCLOAK_TOKEN_URL" | "ENTRA_TENANT_ID" | "ENTRA_CLIENT_ID"
>;

const planKeycloakLeg = (config: LegConfig, realmIssuer: string): KeycloakLeg =>
  Object.keys(config.KEYCLOAK_AGENT_CLIENT_CREDENTIALS).length === 0
    ? { kind: "unwired", missing: "KEYCLOAK_AGENT_CLIENT_CREDENTIALS" }
    : {
        kind: "wired",
        tokenUrl:
          config.KEYCLOAK_TOKEN_URL ?? `${realmIssuer.replace(/\/$/, "")}/protocol/openid-connect/token`,
        credentials: config.KEYCLOAK_AGENT_CLIENT_CREDENTIALS,
      };

const planEntraLeg = (config: LegConfig): EntraLeg =>
  config.ENTRA_TENANT_ID !== undefined && config.ENTRA_CLIENT_ID !== undefined
    ? { kind: "wired", tenantId: config.ENTRA_TENANT_ID, clientId: config.ENTRA_CLIENT_ID }
    : { kind: "unwired", missing: "ENTRA_TENANT_ID and ENTRA_CLIENT_ID" };

/** Decide, from config alone, which authority legs this boot wires live. Pure. */
export const planAuthorityLegs = (config: LegConfig, realmIssuer: string): AuthorityLegs => ({
  keycloak: planKeycloakLeg(config, realmIssuer),
  entra: planEntraLeg(config),
});

/**
 * The ONE boot warning naming every unwired leg and the config that would wire
 * it, or `undefined` when both legs are wired (FR-011). The message names config
 * keys only — never a credential value (NFR-014).
 */
export const unwiredLegsWarning = (legs: AuthorityLegs): string | undefined => {
  const unwired = [
    ...(legs.keycloak.kind === "unwired" ? [`Keycloak token endpoint (set ${legs.keycloak.missing})`] : []),
    ...(legs.entra.kind === "unwired" ? [`Entra WIF exchange + Graph transport (set ${legs.entra.missing})`] : []),
  ];
  return unwired.length === 0
    ? undefined
    : "capability authority leg(s) not wired — remain fail-closed (assigned scopes surface " +
        `infra-unreachable): ${unwired.join("; ")}`;
};
