/**
 * Tests for the operation-narrowed Graph capability handles
 * (adapters/graph-capability.ts).
 *
 * The security-critical invariants under test:
 *   - SC-007 — a handle exposes ONLY its named operation; NO raw client/token/
 *     apiKey field is reachable (type-level + runtime own-keys check).
 *   - FR-W4-005 — the operation presents the app-only WIF token as the bearer and
 *     targets the specific Graph resource/operation.
 *   - FR-X-002 — a Graph 4xx is a settled `downstream-denied`; a transport
 *     rejection / 5xx is `infra-unreachable`, kept DISTINCT.
 *
 * All HTTP egress goes through an injected fake transport — NO live network.
 */

import { describe, it, expect } from "bun:test";
import { match } from "ts-pattern";
import {
  buildGraphHandle,
  buildMailSendHandle,
  buildSitesReadHandle,
  buildDynamicsReadHandle,
  type GraphHttp,
  type GraphRequest,
  type GraphResponse,
} from "../graph-capability.js";
import { parseScope, type MailSendHandle, type SitesReadHandle, type DynamicsReadHandle } from "../../domain/capability-scope.js";

/** Configured per-org Dynamics/Dataverse host (FR-042) — the handle targets
 *  `https://<DYN_HOST>/api/data/v9.2`, never a hardcoded placeholder. */
const DYN_HOST = "org.crm4.dynamics.com";

/** A call-recording fake transport returning a scripted response per call. */
const recordingHttp = (response: GraphResponse | (() => never)) => {
  const requests: GraphRequest[] = [];
  const http: GraphHttp = {
    request: async (r) => {
      requests.push(r);
      if (typeof response === "function") return response();
      return response;
    },
  };
  return { http, requests };
};

// ── SC-007: only the named operation is reachable (type-level + runtime) ──────

type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type _Expect<T extends true> = T;
// A graph-capability handle's static type exposes EXACTLY its operation method.
type _MailExact = _Expect<_Equal<keyof MailSendHandle, "sendMail">>;
type _SitesExact = _Expect<_Equal<keyof SitesReadHandle, "readSite">>;
type _DynExact = _Expect<_Equal<keyof DynamicsReadHandle, "read">>;
const _mailOk: _MailExact = true;
const _sitesOk: _SitesExact = true;
const _dynOk: _DynExact = true;

describe("graph-capability — SC-007: only the operation is reachable, no raw client/token", () => {
  it("type-level: each handle's key set is exactly its operation", () => {
    expect(_mailOk && _sitesOk && _dynOk).toBe(true);
  });

  it("runtime: built handles expose only the operation own-key (no client/token/apiKey)", () => {
    const { http } = recordingHttp({ status: 202, json: {} });
    const mail = buildMailSendHandle("app-only-tok", http) as unknown as Record<string, unknown>;
    const sites = buildSitesReadHandle("app-only-tok", http) as unknown as Record<string, unknown>;
    const dyn = buildDynamicsReadHandle("app-only-tok", http, DYN_HOST) as unknown as Record<string, unknown>;
    expect(Object.keys(mail)).toEqual(["sendMail"]);
    expect(Object.keys(sites)).toEqual(["readSite"]);
    expect(Object.keys(dyn)).toEqual(["read"]);
    // No field reaches the raw token / client.
    for (const h of [mail, sites, dyn]) {
      expect(h.token).toBeUndefined();
      expect(h.client).toBeUndefined();
      expect(h.apiKey).toBeUndefined();
    }
  });

  it("type-level: accessing .token / .client on a handle is a compile error", () => {
    const { http } = recordingHttp({ status: 202, json: {} });
    const mail: MailSendHandle = buildMailSendHandle("tok", http);
    // @ts-expect-error — SC-007: no raw token is reachable from the handle.
    void mail.token;
    // @ts-expect-error — SC-007: no raw client is reachable from the handle.
    void mail.client;
    expect(typeof mail.sendMail).toBe("function");
  });
});

// ── FR-W4-005: the app-only token is presented as the bearer at egress ────────

describe("graph-capability — presents the WIF token as the bearer (FR-W4-005)", () => {
  it("sendMail POSTs to /users/{from}/sendMail (app-only — NOT /me) with the WIF token as Authorization bearer", async () => {
    const { http, requests } = recordingHttp({ status: 202, json: {} });
    const handle = buildMailSendHandle("app-only-xyz", http);
    const r = await handle.sendMail({ from: "agent@contoso.com", to: "a@b.c", subject: "hi", body: "body" });
    expect(r.ok).toBe(true);
    expect(requests.length).toBe(1);
    expect(requests[0]?.method).toBe("POST");
    // App-only tokens cannot use /me; the sender mailbox is in the path (C2).
    expect(requests[0]?.url).toContain("/users/agent%40contoso.com/sendMail");
    expect(requests[0]?.url).not.toContain("/me/sendMail");
    expect(requests[0]?.bearer).toBe("app-only-xyz"); // the WIF token, never a stored secret
  });

  it("sendMail synthesises the receipt from a 202 body id when Graph supplies one", async () => {
    const { http } = recordingHttp({ status: 202, json: { id: "req-abc-123" } });
    const handle = buildMailSendHandle("tok", http);
    const r = await handle.sendMail({ from: "agent@contoso.com", to: "a@b.c", subject: "hi", body: "body" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.messageId).toBe("req-abc-123");
  });

  it("sendMail falls back to the 'accepted' sentinel on an id-less 202 (A3 — Graph guarantees no message id)", async () => {
    const { http } = recordingHttp({ status: 202, json: {} });
    const handle = buildMailSendHandle("tok", http);
    const r = await handle.sendMail({ from: "agent@contoso.com", to: "a@b.c", subject: "hi", body: "body" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.messageId).toBe("accepted");
  });

  it("sendMail ignores a non-string 202 body id (sentinel, not a coerced number)", async () => {
    const { http } = recordingHttp({ status: 202, json: { id: 42 } });
    const handle = buildMailSendHandle("tok", http);
    const r = await handle.sendMail({ from: "agent@contoso.com", to: "a@b.c", subject: "hi", body: "body" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.messageId).toBe("accepted");
  });

  it("readSite GETs the site resource with the app-only token bearer", async () => {
    const { http, requests } = recordingHttp({ status: 200, json: { displayName: "Contoso Team" } });
    const handle = buildSitesReadHandle("app-only-xyz", http);
    const r = await handle.readSite("site-42");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.siteId).toBe("site-42");
    expect(r.value.title).toBe("Contoso Team");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.bearer).toBe("app-only-xyz");
  });

  it("dynamics read GETs the entity with the bearer and shapes the rows", async () => {
    const { http, requests } = recordingHttp({ status: 200, json: { value: [{ id: 1 }, { id: 2 }] } });
    const handle = buildDynamicsReadHandle("app-only-xyz", http, DYN_HOST);
    const r = await handle.read({ entity: "accounts" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.rows.length).toBe(2);
    expect(requests[0]?.bearer).toBe("app-only-xyz");
    // No filter supplied → no query string at all (not an empty `?$filter=`).
    expect(requests[0]?.url).not.toContain("?");
  });

  it("dynamics read WITH a filter encodes it as the $filter query parameter (URL-encoded, no raw OData chars)", async () => {
    const { http, requests } = recordingHttp({ status: 200, json: { value: [{ id: 1 }] } });
    const handle = buildDynamicsReadHandle("app-only-xyz", http, DYN_HOST);
    const filter = "name eq 'Contoso & Sons' and revenue gt 1000";
    const r = await handle.read({ entity: "accounts", filter });
    expect(r.ok).toBe(true);
    expect(requests.length).toBe(1);
    const url = requests[0]?.url ?? "";
    // The filter rides as $filter=, percent-encoded exactly once.
    expect(url).toBe(
      `https://${DYN_HOST}/api/data/v9.2/accounts?$filter=${encodeURIComponent(filter)}`,
    );
    expect(url).toContain("?$filter=name%20eq%20'Contoso%20%26%20Sons'%20and%20revenue%20gt%201000");
    // Raw spaces / ampersands never reach the wire un-encoded.
    expect(url).not.toContain(" ");
    expect(url).not.toContain("& ");
  });
});

// ── FR-X-002: 4xx → downstream-denied; transient → infra-unreachable ──────────

describe("graph-capability — error mapping (FR-X-002)", () => {
  it.each([400, 401, 403, 404])("a Graph %p → downstream-denied with the resource + Graph reason", async (status) => {
    const { http } = recordingHttp({ status, json: { error: { code: "denied", message: "insufficient privileges" } } });
    const handle = buildMailSendHandle("tok", http);
    const r = await handle.sendMail({ from: "agent@contoso.com", to: "a@b.c", subject: "s", body: "b" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected denial");
    expect(r.error.kind).toBe("downstream-denied");
    if (r.error.kind === "downstream-denied") {
      expect(r.error.resource).toContain("/users/agent%40contoso.com/sendMail");
      expect(r.error.reason).toBe("insufficient privileges");
    }
  });

  it("a Graph 5xx → infra-unreachable (retriable, distinct from a denial)", async () => {
    const { http } = recordingHttp({ status: 503, json: {} });
    const handle = buildSitesReadHandle("tok", http);
    const r = await handle.readSite("site-1");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
  });

  it("a Graph 429 → infra-unreachable NAMING the throttle — distinct message from the generic 5xx", async () => {
    const { http } = recordingHttp({ status: 429, json: {} });
    const handle = buildSitesReadHandle("tok", http);
    const r = await handle.readSite("site-1");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("downstream");
      expect(r.error.hop).toBe("graph");
      expect(r.error.message).toBe("Graph throttled (HTTP 429)");
    }
  });

  it("a generic Graph 500 carries the unexpected-status message, NOT the throttle wording", async () => {
    const { http } = recordingHttp({ status: 500, json: {} });
    const handle = buildSitesReadHandle("tok", http);
    const r = await handle.readSite("site-1");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.message).toBe("Graph unreachable or unexpected status (HTTP 500)");
      expect(r.error.message).not.toContain("throttled");
    }
  });

  it("a transport rejection → infra-unreachable", async () => {
    const { http } = recordingHttp(() => {
      throw new Error("ECONNRESET");
    });
    const handle = buildSitesReadHandle("tok", http);
    const r = await handle.readSite("site-1");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("downstream");
      expect(r.error.hop).toBe("graph");
      expect(r.error.message).toContain("ECONNRESET");
    }
  });
});

// ── Malformed 2xx bodies map to infra-unreachable (A4 precedent / A12 / A8) ───

describe("graph-capability — malformed 2xx bodies are infra-unreachable, never a silent success", () => {
  it("readSite 2xx with no displayName/name → infra-unreachable, not a blank site", async () => {
    const { http } = recordingHttp({ status: 200, json: { unexpected: "shape" } });
    const handle = buildSitesReadHandle("tok", http);
    const r = await handle.readSite("site-42");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("downstream");
      expect(r.error.hop).toBe("graph");
      expect(r.error.message).toContain("site-42");
    }
  });

  it("dynamics 2xx WITHOUT a 'value' array → infra-unreachable, not zero rows", async () => {
    const { http } = recordingHttp({ status: 200, json: { notValue: [] } });
    const handle = buildDynamicsReadHandle("tok", http, DYN_HOST);
    const r = await handle.read({ entity: "accounts" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.message).toContain("accounts");
    }
  });

  it("dynamics 2xx with a NON-OBJECT row in 'value' → infra-unreachable, not a silently smaller result (A8)", async () => {
    const { http } = recordingHttp({
      status: 200,
      json: { value: [{ id: 1 }, "not-a-row", null, { id: 2 }] },
    });
    const handle = buildDynamicsReadHandle("tok", http, DYN_HOST);
    const r = await handle.read({ entity: "accounts" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.error.kind).toBe("infra-unreachable");
    if (r.error.kind === "infra-unreachable") {
      expect(r.error.operation).toBe("downstream");
      expect(r.error.hop).toBe("graph");
      expect(r.error.message).toContain("2 non-object row(s)");
    }
  });

  it("dynamics 2xx with an EMPTY 'value' array stays a legitimate zero-row success", async () => {
    const { http } = recordingHttp({ status: 200, json: { value: [] } });
    const handle = buildDynamicsReadHandle("tok", http, DYN_HOST);
    const r = await handle.read({ entity: "accounts" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.rows).toEqual([]);
  });
});

// ── buildGraphHandle dispatches the right narrowed handle per scope ───────────

describe("graph-capability — buildGraphHandle selects the handle per parsed scope", () => {
  it("maps each recognised scope to its operation-only handle", () => {
    const { http } = recordingHttp({ status: 202, json: {} });
    for (const [name, op] of [
      ["msgraph:mail.send", "sendMail"],
      ["msgraph:sites.read", "readSite"],
      ["dynamics:read", "read"],
    ] as const) {
      const parsed = parseScope(name);
      if (parsed === undefined) throw new Error(`parse failed for ${name}`);
      const handle = buildGraphHandle(parsed, "tok", http, "org.crm4.dynamics.com") as unknown as Record<string, unknown>;
      expect(Object.keys(handle)).toEqual([op]);
      // The dispatch is exhaustive — exercise the value to keep ts-pattern honest.
      match(parsed)
        .with({ provider: "msgraph", operation: "mail.send" }, () => expect(op).toBe("sendMail"))
        .with({ provider: "msgraph", operation: "sites.read" }, () => expect(op).toBe("readSite"))
        .with({ provider: "dynamics", operation: "read" }, () => expect(op).toBe("read"))
        .exhaustive();
    }
  });

  it("msgraph builders ignore an undefined org host (their resource is the fixed Graph host)", () => {
    const { http } = recordingHttp({ status: 202, json: {} });
    for (const [name, op] of [
      ["msgraph:mail.send", "sendMail"],
      ["msgraph:sites.read", "readSite"],
    ] as const) {
      const parsed = parseScope(name);
      if (parsed === undefined) throw new Error(`parse failed for ${name}`);
      const handle = buildGraphHandle(parsed, "tok", http, undefined) as unknown as Record<string, unknown>;
      expect(Object.keys(handle)).toEqual([op]);
    }
  });

  it("FAILS CLOSED building a dynamics:read handle with no org host (no `https:///api/data/v9.2`)", () => {
    const { http } = recordingHttp({ status: 200, json: { value: [] } });
    const parsed = parseScope("dynamics:read");
    if (parsed === undefined) throw new Error("parse failed for dynamics:read");
    // An UNSET host must not silently synthesise an empty-host Dataverse URL.
    expect(() => buildGraphHandle(parsed, "tok", http, undefined)).toThrow(/DYNAMICS_ORG_HOST/);
    expect(() => buildGraphHandle(parsed, "tok", http, "")).toThrow(/DYNAMICS_ORG_HOST/);
  });
});
