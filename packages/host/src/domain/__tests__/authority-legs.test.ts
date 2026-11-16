/**
 * Tests for the pure authority-leg plan (domain/authority-legs.ts): AD-3
 * config-presence gating decided from config alone, and the one boot warning
 * naming the unwired legs (FR-011).
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { planAuthorityLegs, unwiredLegsWarning } from "../authority-legs.js";

const ISSUER = "https://kc.example.com/realms/fugue-platform";
const CREDS = { "dag-mail": { clientId: "kc-client", clientSecret: "sekret-value" } };

type LegConfig = Parameters<typeof planAuthorityLegs>[0];

const config = (overrides: Partial<LegConfig> = {}): LegConfig => ({
  KEYCLOAK_AGENT_CLIENT_CREDENTIALS: {},
  KEYCLOAK_TOKEN_URL: undefined,
  ENTRA_TENANT_ID: undefined,
  ENTRA_CLIENT_ID: undefined,
  ...overrides,
});

describe("planAuthorityLegs — each leg wired only by its own config", () => {
  it("no leg config → both legs unwired, each naming the config that would wire it", () => {
    expect(planAuthorityLegs(config(), ISSUER)).toEqual({
      keycloak: { kind: "unwired", missing: "KEYCLOAK_AGENT_CLIENT_CREDENTIALS" },
      entra: { kind: "unwired", missing: "ENTRA_TENANT_ID and ENTRA_CLIENT_ID" },
    });
  });

  it("credentials present → the Keycloak leg is wired with the token URL derived from the issuer", () => {
    const legs = planAuthorityLegs(config({ KEYCLOAK_AGENT_CLIENT_CREDENTIALS: CREDS }), `${ISSUER}/`);
    expect(legs.keycloak).toEqual({
      kind: "wired",
      tokenUrl: `${ISSUER}/protocol/openid-connect/token`,
      credentials: CREDS,
    });
    expect(legs.entra.kind).toBe("unwired");
  });

  it("an explicit KEYCLOAK_TOKEN_URL wins over the issuer-derived one", () => {
    const legs = planAuthorityLegs(
      config({ KEYCLOAK_AGENT_CLIENT_CREDENTIALS: CREDS, KEYCLOAK_TOKEN_URL: "https://kc.internal/token" }),
      ISSUER,
    );
    expect(legs.keycloak.kind === "wired" && legs.keycloak.tokenUrl).toBe("https://kc.internal/token");
  });

  it("the Entra pair present → the Entra leg is wired with exactly that pair", () => {
    const legs = planAuthorityLegs(config({ ENTRA_TENANT_ID: "tenant", ENTRA_CLIENT_ID: "fugue-agents" }), ISSUER);
    expect(legs.entra).toEqual({ kind: "wired", tenantId: "tenant", clientId: "fugue-agents" });
    expect(legs.keycloak.kind).toBe("unwired");
  });

  it("the legs are independent: one leg's config never changes the other leg's plan", () => {
    const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
    fc.assert(
      fc.property(fc.boolean(), maybe(fc.webUrl()), maybe(fc.string()), maybe(fc.string()), (hasCreds, url, tenant, client) => {
        const full = config({
          KEYCLOAK_AGENT_CLIENT_CREDENTIALS: hasCreds ? CREDS : {},
          KEYCLOAK_TOKEN_URL: url,
          ENTRA_TENANT_ID: tenant,
          ENTRA_CLIENT_ID: client,
        });
        const keycloakOnly = config({ KEYCLOAK_AGENT_CLIENT_CREDENTIALS: full.KEYCLOAK_AGENT_CLIENT_CREDENTIALS, KEYCLOAK_TOKEN_URL: url });
        const entraOnly = config({ ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: client });
        const legs = planAuthorityLegs(full, ISSUER);
        expect(legs.keycloak).toEqual(planAuthorityLegs(keycloakOnly, ISSUER).keycloak);
        expect(legs.entra).toEqual(planAuthorityLegs(entraOnly, ISSUER).entra);
        expect(legs.keycloak.kind === "wired").toBe(hasCreds);
        expect(legs.entra.kind === "wired").toBe(tenant !== undefined && client !== undefined);
      }),
    );
  });
});

describe("unwiredLegsWarning — exactly one warning naming only the unwired legs (FR-011)", () => {
  it("both legs wired → no warning", () => {
    const legs = planAuthorityLegs(
      config({ KEYCLOAK_AGENT_CLIENT_CREDENTIALS: CREDS, ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c" }),
      ISSUER,
    );
    expect(unwiredLegsWarning(legs)).toBeUndefined();
  });

  it("both legs unwired → one warning naming both legs' config", () => {
    expect(unwiredLegsWarning(planAuthorityLegs(config(), ISSUER))).toBe(
      "capability authority leg(s) not wired — remain fail-closed (assigned scopes surface infra-unreachable): " +
        "Keycloak token endpoint (set KEYCLOAK_AGENT_CLIENT_CREDENTIALS); " +
        "Entra WIF exchange + Graph transport (set ENTRA_TENANT_ID and ENTRA_CLIENT_ID)",
    );
  });

  it("only the Entra leg unwired → the warning names it alone and never a credential value (NFR-014)", () => {
    const warning = unwiredLegsWarning(planAuthorityLegs(config({ KEYCLOAK_AGENT_CLIENT_CREDENTIALS: CREDS }), ISSUER));
    expect(warning).toContain("ENTRA_TENANT_ID");
    expect(warning).not.toContain("KEYCLOAK_AGENT_CLIENT_CREDENTIALS");
    expect(warning).not.toContain("sekret-value");
  });
});
