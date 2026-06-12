/**
 * Direct tests of the SHIPPED unwired defaults (review gap, 3/10):
 * `unwired-token-endpoint.ts` and `unwired-entra-wif.ts`.
 *
 * These are the fail-closed stand-ins the host boots with until the live
 * Keycloak/Entra adapters are wired. The contract under test: every method
 * surfaces a RETRIABLE `infra-unreachable` (a transient "we never reached an
 * answer") tagged with the operation ROLE + host hop that was attempted — never
 * a `policy-refusal` (a settled "no"), never a silent success, and never a
 * token. The audit trail must pinpoint the unwired hop from the error alone.
 *
 * The unwired Graph transport is the matching last line of defense: if it were
 * ever reached it answers 503 (→ `infra-unreachable` via the response mapping)
 * rather than performing a live `fetch` — preserving the zero-uncontrolled-
 * egress posture of the unwired host.
 */

import { describe, it, expect } from "bun:test";
import { createUnwiredTokenEndpoint } from "../unwired-token-endpoint.js";
import { createUnwiredEntraWifExchange, createUnwiredGraphHttp } from "../unwired-entra-wif.js";
import { parseScope, type DownstreamScope } from "../../domain/capability-scope.js";

const mailScope = (): DownstreamScope => {
  const r = parseScope("msgraph:mail.send");
  if (!r.ok) throw new Error("parse failed");
  return r.value;
};

describe("unwired-token-endpoint — every method fails closed with a hop-tagged infra-unreachable", () => {
  it("mintClientCredentials → err infra-unreachable with operation 'mint' / hop 'client-credentials'", async () => {
    const endpoint = createUnwiredTokenEndpoint();

    const r = await endpoint.mintClientCredentials({
      agentClientId: "fugue-agent-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err — an unwired endpoint must never mint");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("mint");
      expect(r.error.hop).toBe("client-credentials");
      expect(r.error.message).toContain("not wired");
    }
  });

  it("exchangeV2 → err infra-unreachable with operation 'exchange' / hop 'token-exchange'", async () => {
    const endpoint = createUnwiredTokenEndpoint();

    const r = await endpoint.exchangeV2({
      userSub: "user-abc",
      agentClientId: "fugue-agent-mail",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err — an unwired endpoint must never exchange");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("exchange");
      expect(r.error.hop).toBe("token-exchange");
      expect(r.error.message).toContain("not wired");
    }
  });
});

describe("unwired-entra-wif — the WIF hop fails closed with operation 'federation' / hop 'entra-wif'", () => {
  it("exchange → err infra-unreachable, never a token (SC-011 holds trivially: no credential exists)", async () => {
    const wif = createUnwiredEntraWifExchange();

    const r = await wif.exchange({
      clientAssertion: "keycloak-sa-token",
      scope: mailScope(),
      audience: "https://graph.microsoft.com",
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err — an unwired WIF must never mint an app-only token");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("federation");
      expect(r.error.hop).toBe("entra-wif");
      expect(r.error.message).toContain("not wired");
    }
  });
});

describe("unwired-graph-http — the transport answers 503, never a live fetch", () => {
  it("request → status 503 with an 'unwired' error body (zero uncontrolled egress)", async () => {
    const graphHttp = createUnwiredGraphHttp();

    const res = await graphHttp.request({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/sites/root",
      bearer: "should-never-matter",
    });

    expect(res.status).toBe(503);
    const error = res.json.error as Record<string, unknown> | undefined;
    expect(error?.code).toBe("unwired");
  });
});
