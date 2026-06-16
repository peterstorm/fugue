/**
 * Tests for the LIVE Keycloak token endpoint (adapters/keycloak-token-endpoint-http.ts).
 *
 * Mirrors the `entra-wif.test.ts` structure: pure body-builders + pure
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
 */

import { describe, it, expect } from "bun:test";
import {
  createKeycloakTokenEndpoint,
  buildClientCredentialsBody,
  buildExchangeV2Body,
  mapKeycloakTokenResponse,
  TOKEN_EXCHANGE_GRANT_TYPE,
  REQUESTED_TOKEN_TYPE_ACCESS,
  SUBJECT_TOKEN_TYPE_ACCESS,
} from "../keycloak-token-endpoint-http.js";
import type { HttpPost, HttpPostResponse } from "../entra-wif.js";
import type { KeycloakClientCredential, AgentClientCredentials } from "../agent-client-credentials.js";
import type { AgentClientId } from "../../domain/auth.js";
import { markSubjectToken, type SubjectToken } from "../../domain/auth.js";
import { parseScope, type DownstreamScope } from "../../domain/capability-scope.js";

/** A verified user JWT branded as the RFC 8693 subject_token proof (FR-030). */
const subjectToken: SubjectToken = markSubjectToken("header.payload.signature-user-123");

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

// ── Pure body-builders (exact form, no extra params) ─────────────────────────

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
    // No extra params: exactly these five keys.
    expect([...params.keys()].sort()).toEqual(
      ["audience", "client_id", "client_secret", "grant_type", "scope"],
    );
  });
});

describe("buildExchangeV2Body — exact RFC 8693 form body presenting the subject_token (FR-030/FR-031)", () => {
  it("emits the token-exchange grant, client creds, subject_token + type, requested_token_type, scope, audience — and nothing else", () => {
    const body = buildExchangeV2Body(cred, {
      userSub: "user-123",
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
      subjectToken,
    });
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
    expect(params.get("client_id")).toBe("kc-client-id");
    expect(params.get("client_secret")).toBe("kc-super-secret");
    expect(params.get("requested_token_type")).toBe(REQUESTED_TOKEN_TYPE_ACCESS);
    expect(params.get("scope")).toBe("msgraph:mail.send");
    expect(params.get("audience")).toBe("https://graph.microsoft.com");
    // FR-030: the user's ACTUAL verified JWT is presented as the subject_token proof,
    // so Keycloak preserves the user as `sub` (FR-031). The client_id is the agent =
    // the exchanged token's `azp`.
    expect(params.get("subject_token")).toBe("header.payload.signature-user-123");
    expect(params.get("subject_token_type")).toBe(SUBJECT_TOKEN_TYPE_ACCESS);
    // EXACTLY these seven keys — no extra params (mirrors the client_credentials test).
    expect([...params.keys()].sort()).toEqual(
      [
        "audience",
        "client_id",
        "client_secret",
        "grant_type",
        "requested_token_type",
        "scope",
        "subject_token",
        "subject_token_type",
      ],
    );
  });
});

// ── Pure response-mapper: status → Result ────────────────────────────────────

describe("mapKeycloakTokenResponse — status → Result", () => {
  it("200 with access_token + positive expires_in → ok(MintedToken)", () => {
    const r = mapKeycloakTokenResponse("aud", "mint", "client-credentials", {
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
    ["NaN expires_in", { access_token: "t", expires_in: Number.NaN }],
    ["negative expires_in", { access_token: "t", expires_in: -1 }],
    ["zero expires_in", { access_token: "t", expires_in: 0 }],
    ["Infinity expires_in", { access_token: "t", expires_in: Number.POSITIVE_INFINITY }],
    ["string expires_in", { access_token: "t", expires_in: "900" }],
  ])("200 with %s → infra-unreachable (no born-stale/never-expiring token)", (_label, json) => {
    const r = mapKeycloakTokenResponse("aud", "mint", "client-credentials", { status: 200, json });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
  });

  it.each([400, 401, 403])("HTTP %p → downstream-denied with the audience + Keycloak reason", (status) => {
    const r = mapKeycloakTokenResponse("https://graph.microsoft.com", "mint", "client-credentials", {
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
    const r = mapKeycloakTokenResponse("aud", "mint", "client-credentials", {
      status: 401,
      json: { error: "invalid_client" },
    });
    if (r.ok) throw new Error("expected denial");
    if (r.error.kind === "downstream-denied") expect(r.error.reason).toBe("invalid_client");
  });

  it.each([429, 503])("HTTP %p → infra-unreachable naming the throttle, carrying the hop", (status) => {
    const r = mapKeycloakTokenResponse("aud", "exchange", "token-exchange", { status, json: {} });
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("exchange");
      expect(r.error.hop).toBe("token-exchange");
      expect(r.error.message).toBe(`Keycloak token endpoint throttled (HTTP ${status})`);
    }
  });

  it.each([500, 502])("a generic %p → infra-unreachable, distinct message from the throttle branch", (status) => {
    const r = mapKeycloakTokenResponse("aud", "mint", "client-credentials", { status, json: {} });
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
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
      expect(r.error.reason).not.toContain("kc-super-secret");
      expect(r.error.reason).toContain("dag-UNGRANTED");
    }
  });

  it("a KNOWN agent client mints over the transport and maps the 200 to a token", async () => {
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
    // The secret is in the wire body (and only there).
    expect(calls[0]?.body).toContain("kc-super-secret");
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
    }
  });

  it("exchangeV2 presents the user's subject_token over the transport and maps the 200 to a token (FR-030/FR-031)", async () => {
    const { http, calls } = recordingHttp({ status: 200, json: { access_token: "exchanged-tok", expires_in: 3600 } });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.exchangeV2({
      userSub: "user-1",
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
      subjectToken,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.accessToken).toBe("exchanged-tok");
    // Exactly one egress, and the user's verified JWT was presented as the
    // subject_token proof (FR-030) — Keycloak preserves the user as `sub`.
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(deps().config.tokenUrl);
    const wireParams = new URLSearchParams(calls[0]?.body ?? "");
    expect(wireParams.get("subject_token")).toBe("header.payload.signature-user-123");
    expect(wireParams.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
    // The agent client (azp) authenticates the exchange; the user JWT is the subject.
    expect(wireParams.get("client_id")).toBe("kc-client-id");
  });

  it("exchangeV2 fails closed on an UNKNOWN agent client with NO egress — never presents the user JWT (FR-012/NFR-014)", async () => {
    const { http, calls } = recordingHttp({ status: 200, json: { access_token: "x", expires_in: 1 } });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.exchangeV2({
      userSub: "user-1",
      agentClientId: "dag-UNGRANTED",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
      subjectToken,
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.error.kind).toBe("downstream-denied");
    // ZERO egress: no credential → nothing to authenticate the exchange AS → the
    // user JWT is never sent anywhere.
    expect(calls.length).toBe(0);
    // NFR-014: neither the secret nor the user JWT leaks into the refusal reason.
    if (r.error.kind === "downstream-denied") {
      expect(r.error.reason).not.toContain("kc-super-secret");
      expect(r.error.reason).not.toContain("header.payload.signature-user-123");
    }
  });

  it("exchangeV2 maps a Keycloak 4xx denial to downstream-denied (a settled exchange refusal)", async () => {
    const { http } = recordingHttp({ status: 400, json: { error_description: "subject_token expired" } });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.exchangeV2({
      userSub: "user-1",
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
      subjectToken,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected denial");
    expect(r.error.kind).toBe("downstream-denied");
  });

  it("exchangeV2 maps a transport-level rejection to infra-unreachable on the exchange hop (never throws)", async () => {
    const { http } = recordingHttp(() => {
      throw new Error("socket hang up");
    });
    const endpoint = createKeycloakTokenEndpoint(deps({ http, credentials: resolverFor("dag-mail") }));

    const r = await endpoint.exchangeV2({
      userSub: "user-1",
      agentClientId: "dag-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
      subjectToken,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("exchange");
      expect(r.error.hop).toBe("token-exchange");
      // The user JWT is never echoed into the diagnostic message (NFR-014).
      expect(r.error.message).not.toContain("header.payload.signature-user-123");
    }
  });
});
