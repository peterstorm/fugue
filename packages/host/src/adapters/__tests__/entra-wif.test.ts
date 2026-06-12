/**
 * Tests for the Entra Workload Identity Federation (WIF) exchange
 * (adapters/entra-wif.ts).
 *
 * The security-critical invariants under test:
 *   - SC-011 — NO static Entra secret/certificate: the request carries the
 *     Keycloak SA token as the `client_assertion` and NO `client_secret`/cert.
 *   - FR-W4-004 — the assertion is presented in a `client_credentials` request;
 *     the assertion type is the jwt-bearer URN; the assertion audience is PINNED
 *     to `api://AzureADTokenExchange`.
 *   - FR-W4-005 — the requested scope targets the resource's `.default`, narrowing
 *     where the app-only token can act.
 *   - FR-X-002 — FIC mismatch / WIF rejection / resource-scoping denial collapse
 *     into one `downstream-denied`; a transient reach failure is `infra-unreachable`,
 *     kept DISTINCT.
 *
 * Everything below runs against an injected fake HTTP transport — NO live network,
 * NO `fetch` mock. The live WIF round-trip is SKIPPED unless `ENTRA_LIVE` is set.
 */

import { describe, it, expect } from "bun:test";
import {
  createEntraWifExchange,
  buildWifFormBody,
  mapWifResponse,
  wifTokenEndpoint,
  AZURE_AD_TOKEN_EXCHANGE_AUDIENCE,
  JWT_BEARER_ASSERTION_TYPE,
  type EntraWifConfig,
  type HttpPost,
  type HttpPostResponse,
  type WifExchangeRequest,
} from "../entra-wif.js";
import { parseScope, type DownstreamScope } from "../../domain/capability-scope.js";

const cfg: EntraWifConfig = { tenantId: "tenant-123", clientId: "fugue-agents" };

const mailScope = (): DownstreamScope => {
  const r = parseScope("msgraph:mail.send");
  if (r === undefined) throw new Error("parse failed");
  return r;
};

const req = (over?: Partial<WifExchangeRequest>): WifExchangeRequest => ({
  clientAssertion: "keycloak-sa-token",
  scope: mailScope(),
  audience: "https://graph.microsoft.com",
  ...over,
});

/** A call-recording fake transport returning a scripted response. */
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

// ── Request shape: audience pin, assertion type, NO secret (SC-011/FR-W4-004) ─

describe("entra-wif — request shape pins the WIF assertion (SC-011/FR-W4-004)", () => {
  it("the assertion audience constant is pinned to api://AzureADTokenExchange", () => {
    expect(AZURE_AD_TOKEN_EXCHANGE_AUDIENCE).toBe("api://AzureADTokenExchange");
  });

  it("the client_assertion_type is the OAuth jwt-bearer URN", () => {
    expect(JWT_BEARER_ASSERTION_TYPE).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
  });

  it("the form body presents the SA token as client_assertion with the jwt-bearer type and NO secret/cert", () => {
    const body = buildWifFormBody(cfg, req({ clientAssertion: "the-sa-token" }));
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("fugue-agents");
    expect(params.get("client_assertion")).toBe("the-sa-token"); // the SA token IS the credential
    expect(params.get("client_assertion_type")).toBe(JWT_BEARER_ASSERTION_TYPE);
    // SC-011: NO static secret/certificate field of any kind in the request.
    expect(params.get("client_secret")).toBeNull();
    expect(params.get("client_assertion_certificate")).toBeNull();
    expect(body.toLowerCase()).not.toContain("secret");
    expect(body.toLowerCase()).not.toContain("certificate");
  });

  it("the requested scope is the resource .default (FR-W4-005 narrowing)", () => {
    const body = buildWifFormBody(cfg, req({ audience: "https://graph.microsoft.com" }));
    const params = new URLSearchParams(body);
    expect(params.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  it("the exchange POSTs to the tenant-scoped v2.0 token endpoint", async () => {
    const { http, calls } = recordingHttp({ status: 200, json: { access_token: "app-only", expires_in: 3600 } });
    const exchange = createEntraWifExchange(cfg, http);
    await exchange.exchange(req());
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(wifTokenEndpoint(cfg));
    expect(calls[0]?.url).toBe("https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token");
  });
});

// ── Construction-time tenant validation (URL-injection defense) ──────────────

describe("entra-wif — tenantId is validated ONCE at construction, never per-exchange", () => {
  it("wifTokenEndpoint THROWS on a path-traversal tenantId — a hostile value can never be interpolated into the token URL", () => {
    expect(() => wifTokenEndpoint({ tenantId: "x/../evil", clientId: "c" })).toThrow(/invalid tenantId/);
  });

  it.each([
    ["a path separator", "tenant/extra"],
    ["a query string", "tenant?x=1"],
    ["a fragment", "tenant#frag"],
    ["an empty string", ""],
    ["whitespace", "tenant id"],
    // Length upper bound: the `{1,128}` quantifier rejects 129 chars, so an
    // over-long (likely hostile/garbage) value fails loudly instead of building
    // a token URL from it.
    ["a 129-char tenant (one over the max)", "a".repeat(129)],
  ])("wifTokenEndpoint rejects %s", (_label, tenantId) => {
    expect(() => wifTokenEndpoint({ tenantId, clientId: "c" })).toThrow(/invalid tenantId/);
  });

  it.each([
    ["a GUID", "0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["a verified domain", "contoso.onmicrosoft.com"],
    ["a well-known alias", "organizations"],
    // Length bounds of the `{1,128}` quantifier: a single char and exactly 128
    // chars are both accepted (the boundary, not just a mid-range GUID).
    ["a single-character tenant (min length)", "a"],
    ["a 128-char tenant (max length)", "a".repeat(128)],
  ])("wifTokenEndpoint accepts %s and builds the v2.0 endpoint", (_label, tenantId) => {
    expect(wifTokenEndpoint({ tenantId, clientId: "c" })).toBe(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    );
  });

  it("createEntraWifExchange THROWS AT CONSTRUCTION on an invalid tenantId — a boot-wiring defect fails the boot loudly, not per-exchange as a retriable infra-unreachable", () => {
    const { http, calls } = recordingHttp({ status: 200, json: {} });
    expect(() =>
      createEntraWifExchange({ tenantId: "x/../evil", clientId: "c" }, http),
    ).toThrow(/invalid tenantId/);
    // Nothing was ever posted — the defect never reached the transport.
    expect(calls.length).toBe(0);
  });

  it("a valid tenantId constructs fine and `exchange` works (Result channel, never a throw)", async () => {
    const { http, calls } = recordingHttp({ status: 200, json: { access_token: "app-only", expires_in: 3600 } });
    const exchange = createEntraWifExchange({ tenantId: "contoso.onmicrosoft.com", clientId: "fugue-agents" }, http);

    const r = await exchange.exchange(req());

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.accessToken).toBe("app-only");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
  });
});

// ── Success mapping ──────────────────────────────────────────────────────────

describe("entra-wif — success maps to an app-only token", () => {
  it("200 with access_token/expires_in → ok(AppOnlyToken)", async () => {
    const { http } = recordingHttp({ status: 200, json: { access_token: "app-only-tok", expires_in: 1234 } });
    const exchange = createEntraWifExchange(cfg, http);
    const r = await exchange.exchange(req());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.accessToken).toBe("app-only-tok");
    expect(r.value.expiresInSec).toBe(1234);
  });

  it("200 with a malformed body → infra-unreachable (not a usable answer)", () => {
    const r = mapWifResponse("https://graph.microsoft.com", { status: 200, json: { nope: true } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
  });

  // A14: `expires_in` must parse to POSITIVE FINITE seconds — NaN/Infinity/
  // negative/string would mint a born-stale or never-expiring cache entry
  // downstream, so each is a malformed 2xx → infra-unreachable, never ok.
  it.each([
    ["NaN", Number.NaN],
    ["negative", -3600],
    ["zero", 0],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "3600"],
  ])("200 with %s expires_in → infra-unreachable (no born-stale/never-expiring token)", (_label, expiresIn) => {
    const r = mapWifResponse("https://graph.microsoft.com", {
      status: 200,
      json: { access_token: "app-only-tok", expires_in: expiresIn },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
  });
});

// ── Denial mapping (FR-X-002): FIC mismatch / WIF rejection / resource denial ─

describe("entra-wif — denials collapse into downstream-denied (FR-X-002)", () => {
  it.each([
    [400, "interaction_required", "FIC subject/issuer mismatch"],
    [401, "invalid_client", "WIF assertion rejected"],
    [403, "authorization_denied", "resource scoping (Sites.Selected) denied"],
  ])("HTTP %p → downstream-denied with the audience + Entra reason", (status, error, description) => {
    const r = mapWifResponse("https://graph.microsoft.com", {
      status,
      json: { error, error_description: description },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected denial");
    expect(r.error.kind).toBe("downstream-denied");
    if (r.error.kind === "downstream-denied") {
      expect(r.error.resource).toBe("https://graph.microsoft.com");
      expect(r.error.reason).toBe(description);
    }
  });

  it("falls back to the error code when no description is present", () => {
    const r = mapWifResponse("https://graph.microsoft.com", { status: 403, json: { error: "denied" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected denial");
    if (r.error.kind === "downstream-denied") expect(r.error.reason).toBe("denied");
  });
});

// ── Transient mapping (FR-X-002): kept DISTINCT from a denial ─────────────────

describe("entra-wif — transient reach failures are infra-unreachable (distinct from denial)", () => {
  it("a 5xx → infra-unreachable (retriable), NOT downstream-denied", () => {
    const r = mapWifResponse("https://graph.microsoft.com", { status: 503, json: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
  });

  it.each([429, 503])("HTTP %p names the THROTTLE in the message — operators read the rate-limit, not a generic 'unreachable'", (status) => {
    const r = mapWifResponse("https://graph.microsoft.com", { status, json: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("federation");
      expect(r.error.hop).toBe("entra-wif");
      expect(r.error.message).toBe(`Entra WIF throttled (HTTP ${status})`);
    }
  });

  it.each([500, 502])("a generic %p names the unexpected status — distinct message from the throttle branch", (status) => {
    const r = mapWifResponse("https://graph.microsoft.com", { status, json: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.message).toBe(`Entra WIF unreachable or unexpected status (HTTP ${status})`);
      expect(r.error.message).not.toContain("throttled");
    }
  });

  it("a transport-level rejection → infra-unreachable", async () => {
    const { http } = recordingHttp(() => {
      throw new Error("socket hang up");
    });
    const exchange = createEntraWifExchange(cfg, http);
    const r = await exchange.exchange(req());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("federation");
      expect(r.error.hop).toBe("entra-wif");
      expect(r.error.message).toContain("socket hang up");
    }
  });
});

// ── Live WIF round-trip — SKIPPED unless ENTRA_LIVE is set ────────────────────

describe.skipIf(!process.env.ENTRA_LIVE)("entra-wif — LIVE WIF round-trip (requires ENTRA_LIVE + a real fugue-agents FIC)", () => {
  it("exchanges a real Keycloak SA token for an app-only Graph token over real HTTP", async () => {
    // Documented PLACEHOLDER — there is NO live transport behind this gate yet.
    // It is not skipped-but-implemented; it is an unwritten test that throws to
    // make the gap loud if someone sets ENTRA_LIVE expecting it to work. Wiring it
    // requires a real tenant, the `fugue-agents` app with a federated credential
    // trusting the Keycloak issuer, a minted SA token, and a real HTTP transport.
    throw new Error("live WIF round-trip is an unimplemented placeholder (no live transport exists; set ENTRA_LIVE only after wiring one)");
  });
});
