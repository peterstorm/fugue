/**
 * Tests for the agent client credentials env-map adapter
 * (adapters/agent-client-credentials.ts).
 *
 * @satisfies FR-004 — hit returns the credential; miss is fail-closed (undefined).
 * @satisfies NFR-014 — the credential type is sensitive and must never leak via
 *   a logging-friendly toString/toJSON.
 */

import { describe, it, expect } from "bun:test";
import type { AgentClientId } from "../../domain/auth.js";
import type { KeycloakClientCredentialConfig } from "../../domain/config.js";
import { createAgentClientCredentials } from "../agent-client-credentials.js";

// These tests exercise the CREDENTIALS resolver, which is keyed on a branded
// real Keycloak client id (`AgentClientId`). The dagId→client mapping
// (`agentClientIdForDag`) is tested in domain/run-context; here we just need a
// branded client id to look up, so a tiny local brand helper stands in.
const clientId = (s: string): AgentClientId => s as AgentClientId;

const map: Readonly<Record<string, KeycloakClientCredentialConfig>> = {
  "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "s3cr3t-mail" },
  "fugue-agent-sites": { clientId: "kc-sites", clientSecret: "s3cr3t-sites" },
};

describe("createAgentClientCredentials — lookup", () => {
  it("returns the credential for a configured agent client (hit)", () => {
    const resolve = createAgentClientCredentials(map);
    const cred = resolve(clientId("fugue-agent-mail"));
    expect(cred).toEqual({ clientId: "kc-mail", clientSecret: "s3cr3t-mail" });
  });

  it("returns undefined for an unconfigured agent client (miss → fail-closed, FR-004)", () => {
    const resolve = createAgentClientCredentials(map);
    expect(resolve(clientId("unknown-agent"))).toBeUndefined();
  });

  it("returns undefined for EVERY lookup against an empty map (unconfigured host)", () => {
    const resolve = createAgentClientCredentials({});
    expect(resolve(clientId("fugue-agent-mail"))).toBeUndefined();
    expect(resolve(clientId("anything"))).toBeUndefined();
  });

  it("does NOT resolve inherited Object.prototype keys to a credential (fail-closed)", () => {
    const resolve = createAgentClientCredentials(map);
    expect(resolve(clientId("toString"))).toBeUndefined();
    expect(resolve(clientId("constructor"))).toBeUndefined();
    expect(resolve(clientId("hasOwnProperty"))).toBeUndefined();
  });
});

describe("createAgentClientCredentials — immutability / defensive snapshot", () => {
  it("is unaffected by later mutation of the source map", () => {
    const mutable: Record<string, KeycloakClientCredentialConfig> = {
      "fugue-agent-mail": { clientId: "kc-mail", clientSecret: "s3cr3t-mail" },
    };
    const resolve = createAgentClientCredentials(mutable);
    // Mutate the source AFTER building the resolver.
    delete mutable["fugue-agent-mail"];
    mutable["fugue-agent-evil"] = { clientId: "evil", clientSecret: "pwned" };

    expect(resolve(clientId("fugue-agent-mail"))).toEqual({
      clientId: "kc-mail",
      clientSecret: "s3cr3t-mail",
    });
    expect(resolve(clientId("fugue-agent-evil"))).toBeUndefined();
  });

  it("returns a frozen credential (cannot be mutated by a caller)", () => {
    const resolve = createAgentClientCredentials(map);
    const cred = resolve(clientId("fugue-agent-mail"));
    expect(cred).toBeDefined();
    expect(Object.isFrozen(cred)).toBe(true);
  });
});

describe("KeycloakClientCredential — sensitivity (NFR-014)", () => {
  it("has NO custom toString that exposes the secret", () => {
    const resolve = createAgentClientCredentials(map);
    const cred = resolve(clientId("fugue-agent-mail"))!;
    // Default Object coercion must NOT surface the secret. It yields the generic
    // "[object Object]" — proving there is no logging-friendly toString override.
    expect(String(cred)).toBe("[object Object]");
    expect(`${cred}`).not.toContain("s3cr3t-mail");
  });

  it("has NO custom toJSON (JSON.stringify is not made convenient/lossy)", () => {
    const resolve = createAgentClientCredentials(map);
    const cred = resolve(clientId("fugue-agent-mail"))!;
    // We are NOT asserting it's safe to stringify (it isn't — callers must never
    // log it); we assert there is no custom toJSON masking that the object simply
    // IS its fields. Greppability: the secret only ever lives in the field.
    expect("toJSON" in cred).toBe(false);
  });
});
