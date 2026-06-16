/**
 * Tests for the Entra / Keycloak agent-client config additions
 * (domain/config.ts).
 *
 * @satisfies FR-001 — the host accepts Entra tenant/client, Keycloak agent
 *   credentials, and a Dynamics org host, and REJECTS internally-inconsistent
 *   combinations (tenant without client) at boot.
 * @satisfies SC-001 — a host with NONE of the new fields set boots unchanged
 *   (zero-regression baseline).
 */

import { describe, it, expect } from "bun:test";
import { parseHostConfig } from "../config.js";

/** A minimal env that parses successfully (no security config set). */
const baseEnv = (): Record<string, string | undefined> => ({
  DAGS_REPO_URL: "https://example.com/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "0123456789abcdef-admin-token",
  ANTHROPIC_API_KEY: "sk-ant-test",
});

describe("HostConfig — zero-regression baseline (SC-001)", () => {
  it("boots with NONE of the new security fields set", () => {
    const result = parseHostConfig(baseEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ENTRA_TENANT_ID).toBeUndefined();
    expect(result.value.ENTRA_CLIENT_ID).toBeUndefined();
    expect(result.value.KEYCLOAK_TOKEN_URL).toBeUndefined();
    expect(result.value.DYNAMICS_ORG_HOST).toBeUndefined();
    // Unset credentials → empty map (fail-closed default).
    expect(result.value.KEYCLOAK_AGENT_CLIENT_CREDENTIALS).toEqual({});
  });
});

describe("HostConfig — Entra tenant/client pairing (FR-001)", () => {
  it("accepts tenant + client set together", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      ENTRA_TENANT_ID: "tenant-uuid",
      ENTRA_CLIENT_ID: "client-uuid",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ENTRA_TENANT_ID).toBe("tenant-uuid");
    expect(result.value.ENTRA_CLIENT_ID).toBe("client-uuid");
  });

  it("rejects tenant WITHOUT client (internally inconsistent)", () => {
    const result = parseHostConfig({ ...baseEnv(), ENTRA_TENANT_ID: "tenant-uuid" });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("ENTRA_CLIENT_ID");
  });

  it("rejects client WITHOUT tenant (internally inconsistent)", () => {
    const result = parseHostConfig({ ...baseEnv(), ENTRA_CLIENT_ID: "client-uuid" });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("ENTRA_TENANT_ID");
  });
});

describe("HostConfig — KEYCLOAK_AGENT_CLIENT_CREDENTIALS (JSON, sensitive)", () => {
  it("parses a well-formed credential map", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "secret" },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.KEYCLOAK_AGENT_CLIENT_CREDENTIALS).toEqual({
      "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "secret" },
    });
  });

  it("rejects invalid JSON at boot", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: "{not json",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("valid JSON");
  });

  it("rejects a credential missing clientSecret at boot", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail" },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("clientId, clientSecret");
  });

  it("rejects an empty clientSecret at boot (non-empty strings required)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "" },
      }),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown extra key in a credential (.strict — no silent widening)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "secret", extra: "nope" },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
  });
});

describe("HostConfig — KEYCLOAK_TOKEN_URL must be https (NFR-014)", () => {
  it("accepts an https token url", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_TOKEN_URL: "https://kc.example.com/realms/x/protocol/openid-connect/token",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-url token url", () => {
    const result = parseHostConfig({ ...baseEnv(), KEYCLOAK_TOKEN_URL: "not-a-url" });
    expect(result.ok).toBe(false);
  });

  it("rejects a well-formed cleartext http token url (secret leak, NFR-014)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_TOKEN_URL: "http://kc.example.com/realms/x/protocol/openid-connect/token",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("KEYCLOAK_TOKEN_URL");
    expect(result.error.message).toContain("https://");
  });
});

describe("HostConfig — derived Keycloak token URL must be https (NFR-014)", () => {
  it("rejects creds + unset KEYCLOAK_TOKEN_URL + http:// REALM_JWT_ISSUER (derived URL leaks secret)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      // creds present → the agent client secret WILL be POSTed
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "secret" },
      }),
      // no explicit token url → the live endpoint derives it from the issuer
      // KEYCLOAK_TOKEN_URL intentionally unset
      REALM_JWT_ISSUER: "http://kc.example.com/realms/x",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("REALM_JWT_ISSUER");
    expect(result.error.message).toContain("https://");
  });

  it("accepts creds + unset KEYCLOAK_TOKEN_URL + https:// REALM_JWT_ISSUER (derived URL is https)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "secret" },
      }),
      REALM_JWT_ISSUER: "https://kc.example.com/realms/x",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an http:// REALM_JWT_ISSUER with NO agent creds (JWKS-only, no secret POSTed — no regression)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      // KEYCLOAK_AGENT_CLIENT_CREDENTIALS intentionally unset → no secret is POSTed
      REALM_JWT_ISSUER: "http://localhost:8080/realms/x",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.REALM_JWT_ISSUER).toBe("http://localhost:8080/realms/x");
  });

  it("allows creds + http:// REALM_JWT_ISSUER when KEYCLOAK_TOKEN_URL is an explicit https override (its own guard covers the secret)", () => {
    const result = parseHostConfig({
      ...baseEnv(),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: JSON.stringify({
        "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "secret" },
      }),
      KEYCLOAK_TOKEN_URL: "https://kc.example.com/realms/x/protocol/openid-connect/token",
      REALM_JWT_ISSUER: "http://kc.example.com/realms/x",
    });
    expect(result.ok).toBe(true);
  });
});

describe("HostConfig — REALM_JWT_AUDIENCE (non-empty, FR-W3-006)", () => {
  it("defaults to fugue-host when unset", () => {
    const result = parseHostConfig(baseEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.REALM_JWT_AUDIENCE).toBe("fugue-host");
  });

  it("accepts an explicit non-empty audience", () => {
    const result = parseHostConfig({ ...baseEnv(), REALM_JWT_AUDIENCE: "my-host" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.REALM_JWT_AUDIENCE).toBe("my-host");
  });

  it("REJECTS an explicitly-empty audience at boot (an empty expectation neuters the aud check)", () => {
    // `audienceMatches` treats "" as trivially satisfied by any token's aud
    // (a string aud equals "" never, but an array `aud.includes("")` would be
    // false too — yet a single-string expectation of "" collapses the check's
    // intent). Rather than reason about each branch, reject the weakening config
    // at boot so the audience guard can never be silently disarmed by env.
    const result = parseHostConfig({ ...baseEnv(), REALM_JWT_AUDIENCE: "" });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "config-invalid") throw new Error("expected config-invalid");
    expect(result.error.message).toContain("REALM_JWT_AUDIENCE");
  });
});

describe("HostConfig — DYNAMICS_ORG_HOST", () => {
  it("accepts and surfaces the org host when set", () => {
    const result = parseHostConfig({ ...baseEnv(), DYNAMICS_ORG_HOST: "org.crm4.dynamics.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.DYNAMICS_ORG_HOST).toBe("org.crm4.dynamics.com");
  });
});
