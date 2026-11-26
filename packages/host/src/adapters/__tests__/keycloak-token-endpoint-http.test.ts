/**
 * Tests for the LIVE Keycloak token endpoint (adapters/keycloak-token-endpoint-http.ts).
 *
 * Mirrors the `entra-wif.test.ts` structure: pure body-builder + pure
 * response-mapper + thin shell over an injected call-recording transport. NO live
 * network, NO `fetch` mock.
 *
 * Security-critical invariants under test:
 *   - FR-010 — the `client_credentials` body presents the per-client credential,
 *     scope, and audience — and NO extra params.
 *   - FR-012 / NFR-010 — an un-granted/unknown agent client (no credential) is
 *     refused at the Keycloak hop with ZERO egress (the recording transport sees
 *     no call).
 *   - mapKeycloakTokenResponse — status → Result: 200 → ok token, 4xx → denied,
 *     5xx/transient → unreachable, distinct.
 *   - NFR-014 — the client secret appears ONLY in the POST body, never in an
 *     error / refusal.
 *   - INV-1 / FR-003 — the endpoint offers no RFC 8693 user exchange: the module
 *     exports no exchange body-builder or grant URN, and the endpoint has one
 *     method, the agent's own `client_credentials` mint.
 */

import { describe, it, expect } from "bun:test";
import * as keycloakTokenEndpointHttp from "../keycloak-token-endpoint-http.js";
import {
  createKeycloakTokenEndpoint,
  buildClientCredentialsBody,
  mapKeycloakTokenResponse,
} from "../keycloak-token-endpoint-http.js";
import type { HttpPost, HttpPostResponse } from "../fetch-http-post.js";
import type { KeycloakClientCredential, AgentClientCredentials } from "../agent-client-credentials.js";
import type { AgentClientId } from "../../domain/auth.js";
import { parseScope, type DownstreamScope } from "../../domain/capability-scope.js";

const mailScope = (): DownstreamScope => {
  const r = parseScope("msgraph:mail.send");
  if (r === undefined) throw new Error("parse failed");
  return r;
};

const cred: KeycloakClientCredential = { clientId: "kc-client-id", clientSecret: "kc-super-secret" };

/** A call-recording fake transport returning a scripted response (or throwing). */
const recordingHttp = (response: HttpPostResponse | (() => never)) => {
  const calls: { url: string; body: string }[] = [];
  const http: HttpPost = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (typeof response === "function") return response();
      return response;
    },
  };
  return { http, calls };
};

/** A credential resolver that returns `cred` for the given clientId and misses otherwise. */
const resolverFor = (knownClientId: string): AgentClientCredentials =>
  (id: AgentClientId) => (id === (knownClientId as unknown as AgentClientId) ? cred : undefined);

const deps = (over?: { http?: HttpPost; credentials?: AgentClientCredentials }) => ({
  config: { tokenUrl: "https://kc.example.com/realms/fugue-platform/protocol/openid-connect/token" },
  http: over?.http ?? recordingHttp({ status: 200, json: { access_token: "sa-tok", expires_in: 3600 } }).http,
  credentials: over?.credentials ?? resolverFor("dag-mail"),
});

// ── No RFC 8693 surface (INV-1 / FR-002 / FR-003) ────────────────────────────

describe("keycloak-token-endpoint-http — no RFC 8693 user exchange (INV-1, FR-003)", () => {
  it("exports no token-exchange body-builder, grant URN or subject/requested token types", () => {
    const exported = Object.keys(keycloakTokenEndpointHttp);
    expect(exported).not.toContain("buildExchangeV2Body");
    expect(exported).not.toContain("TOKEN_EXCHANGE_GRANT_TYPE");
    expect(exported).not.toContain("SUBJECT_TOKEN_TYPE_ACCESS");
    expect(exported).not.toContain("REQUESTED_TOKEN_TYPE_ACCESS");
  });

  it("the live endpoint exposes ONLY the agent's own client_credentials mint", () => {
    const endpoint = createKeycloakTokenEndpoint(deps());
    expect(Object.keys(endpoint)).toEqual(["mintClientCredentials"]);
  });
});

// ── Pure body-builder (exact form, no extra params) ──────────────────────────

describe("buildClientCredentialsBody — exact form body, no extra params (FR-010)", () => {
  it("emits grant_type, client_id, client_secret, scope, audience — and nothing else", () => {
    const body = buildClientCredentialsBody(cred, {
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("kc-client-id");
    expect(params.get("client_secret")).toBe("kc-super-secret");
    expect(params.get("scope")).toBe("msgraph:mail.send");
    expect(params.get("audience")).toBe("https://graph.microsoft.com");
    // No extra params: exactly these five keys (in particular, no subject_token).
    expect([...params.keys()].sort()).toEqual(
      ["audience", "client_id", "client_secret", "grant_type", "scope"],
    );
  });
});

// ── Pure response-mapper: status → Result ────────────────────────────────────

describe("mapKeycloakTokenResponse — status → Result", () => {
  it("200 with access_token + positive expires_in → ok(MintedToken)", () => {
    const r = mapKeycloakTokenResponse("aud", {
      status: 200,
      json: { access_token: "the-sa-token", expires_in: 900 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.accessToken).toBe("the-sa-token");
    expect(r.value.expiresInSec).toBe(900);
  });

  it.each([
    ["missing access_token", { expires_in: 900 }],
    ["empty access_token", { access_token: "", expires_in: 900 }],
    ["NaN expires_in", { access_token: "t", expires_in: Number.NaN }],
    ["negative expires_in", { access_token: "t", expires_in: -1 }],
    ["zero expires_in", { access_token: "t", expires_in: 0 }],
    ["Infinity expires_in", { access_token: "t", expires_in: Number.POSITIVE_INFINITY }],
    ["string expires_in", { access_token: "t", expires_in: "900" }],
  ])("200 with %s → infra-unreachable on the mint hop (no born-stale/never-expiring token)", (_label, json) => {
    const r = mapKeycloakTokenResponse("aud", { status: 200, json });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("mint");
      expect(r.error.hop).toBe("client-credentials");
    }
  });

  it.each([400, 401, 403])("HTTP %p → downstream-denied with the audience + Keycloak reason", (status) => {
    const r = mapKeycloakTokenResponse("https://graph.microsoft.com", {
      status,
      json: { error: "invalid_scope", error_description: "scope not assigned to client" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected denial");
    expect(r.error.kind).toBe("downstream-denied");
    if (r.error.kind === "downstream-denied") {
      expect(r.error.resource).toBe("https://graph.microsoft.com");
      expect(r.error.reason).toBe("scope not assigned to client");
    }
  });

  it("4xx falls back to the error code when no description present", () => {
    const r = mapKeycloakTokenResponse("aud", {
      status: 401,
      json: { error: "invalid_client" },
    });
    if (r.ok) throw new Error("expected denial");
    if (r.error.kind === "downstream-denied") expect(r.error.reason).toBe("invalid_client");
  });

  it.each([429, 503])("HTTP %p → infra-unreachable naming the throttle, on the client-credentials mint hop", (status) => {
    const r = mapKeycloakTokenResponse("aud", { status, json: {} });
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("mint");
      expect(r.error.hop).toBe("client-credentials");
      expect(r.error.message).toBe(`Keycloak token endpoint throttled (HTTP ${status})`);
    }
  });

  it.each([500, 502])("a generic %p → infra-unreachable, distinct message from the throttle branch", (status) => {
    const r = mapKeycloakTokenResponse("aud", { status, json: {} });
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("mint");
      expect(r.error.hop).toBe("client-credentials");
      expect(r.error.message).toBe(`Keycloak token endpoint unreachable or unexpected status (HTTP ${status})`);
      expect(r.error.message).not.toContain("throttled");
    }
  });
});

// ── Live shell: fail-closed on creds-miss with ZERO egress (FR-012/NFR-010) ──

describe("createKeycloakTokenEndpoint — fail-closed on creds-miss, zero egress (FR-012/NFR-010)", () => {
  it("an UNKNOWN agent client (no credential) is refused with downstream-denied and NO HTTP call", async () => {
    const { http, calls } = recordingHttp({ status: 200, json: { access_token: "x", expires_in: 1 } });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.mintClientCredentials({
      agentClientId: "dag-UNGRANTED",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.error.kind).toBe("downstream-denied");
    // ZERO egress: the transport was never called — nothing reaches Keycloak,
    // so the WIF leg downstream is never reached either (zero Entra egress).
    expect(calls.length).toBe(0);
    // NFR-014: no secret leaks into the refusal reason.
    if (r.error.kind === "downstream-denied") {
      expect(r.error.resource).toBe("https://graph.microsoft.com");
      expect(r.error.reason).not.toContain("kc-super-secret");
      expect(r.error.reason).toContain("dag-UNGRANTED");
    }
  });

  it("a KNOWN agent client mints over the transport with the exact client_credentials body and maps the 200 to a token", async () => {
    const { http, calls } = recordingHttp({ status: 200, json: { access_token: "sa-token", expires_in: 3600 } });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.mintClientCredentials({
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.accessToken).toBe("sa-token");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(deps().config.tokenUrl);
    // The secret is in the wire body (and only there), and the body is exactly
    // the client_credentials form — never an exchange body.
    expect(calls[0]?.body).toContain("kc-super-secret");
    expect(calls[0]?.body).toBe(
      buildClientCredentialsBody(cred, {
        agentClientId: "dag-mail",
        scope: mailScope(),
        audience: "https://graph.microsoft.com",
      }),
    );
  });

  it("a 4xx from Keycloak → downstream-denied (an assigned-but-rejected scope is settled)", async () => {
    const { http } = recordingHttp({ status: 403, json: { error_description: "audience not permitted" } });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.mintClientCredentials({
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected denial");
    expect(r.error.kind).toBe("downstream-denied");
    if (r.error.kind === "downstream-denied") {
      expect(r.error.resource).toBe("https://graph.microsoft.com");
      expect(r.error.reason).toBe("audience not permitted");
    }
  });

  it("a transport-level rejection → infra-unreachable (never throws across the boundary)", async () => {
    const { http } = recordingHttp(() => {
      throw new Error("socket hang up");
    });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.mintClientCredentials({
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("mint");
      expect(r.error.hop).toBe("client-credentials");
      expect(r.error.message).toContain("socket hang up");
      // NFR-014: the request body (and the secret in it) is never echoed.
      expect(r.error.message).not.toContain("kc-super-secret");
    }
  });
});
