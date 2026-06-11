/**
 * Tests for the live Keycloak-backed CapabilityBroker (adapters/keycloak-broker.ts).
 *
 * The security-critical invariants under test:
 *   - SC-006 / FR-W3-003 — fail closed, ZERO Entra egress: an unassigned scope
 *     is refused (`policy-refusal`) and the injected token endpoint's mint/exchange
 *     methods are NEVER called.
 *   - US4 / SC-007 — operation narrowing: the returned handle exposes only the
 *     named operation; no raw client/token field is reachable (type-level).
 *   - US4 / SC-008 — cache TTL: repeated (identity,audience,scope) within TTL →
 *     at most one mint call on the endpoint.
 *   - SC-010 / FR-W3-008/009 — exchange semantics: user origin → exactly one V2
 *     exchange (sub=user, azp=agent); agent origin → 0 exchanges, one
 *     client_credentials mint.
 *   - FR-X-004 / SC-009 — every mint AND refusal emits exactly one correlated
 *     record with sub/azp/runId/nodeId/scope.
 */

import { describe, it, expect } from "bun:test";
import { runId as makeRunId, nodeId as makeNodeId, err } from "@fuguejs/framework";
import type { Capability, Invocation, InvocationOrigin, Tracer } from "@fuguejs/framework";
import type { LogPort } from "../../ports.js";
import { createKeycloakBroker, scopeName, audienceForScope } from "../keycloak-broker.js";
import type {
  KeycloakTokenEndpoint,
  ClientCredentialsRequest,
  ExchangeV2Request,
} from "../keycloak-token-endpoint.js";
import type { EntraWifExchange, WifExchangeRequest } from "../entra-wif.js";
import type { GraphHttp, GraphRequest } from "../graph-capability.js";
import { parseScope } from "../../domain/capability-scope.js";

// ── Test spine ──────────────────────────────────────────────────────────────

const runId = makeRunId("run-001");
const nodeId = makeNodeId("node-a");

/** A tracer that just runs the span body — enough to exercise the audit path. */
const passTracer: Tracer = { withSpan: async (_n, _t, fn) => fn() };

const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger: LogPort = {
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
  return { logger, logs };
};

/**
 * A call-recording fake token endpoint. Every method push-logs its inputs so a
 * test can assert egress count and shape — and, crucially, assert ZERO calls on a
 * fail-closed refusal (the no-egress guarantee). `ttlSec` controls token lifetime
 * for the cache test.
 */
const recordingEndpoint = (opts?: { ttlSec?: number }) => {
  const ccCalls: ClientCredentialsRequest[] = [];
  const exCalls: ExchangeV2Request[] = [];
  let mintCounter = 0;
  const ttlSec = opts?.ttlSec ?? 3600;
  const endpoint: KeycloakTokenEndpoint = {
    mintClientCredentials: async (req) => {
      ccCalls.push(req);
      mintCounter += 1;
      return { ok: true, value: { accessToken: `cc-token-${mintCounter}`, expiresInSec: ttlSec } };
    },
    exchangeV2: async (req) => {
      exCalls.push(req);
      mintCounter += 1;
      // Simulate the exchanged token's claims so SC-010 (sub stays user, azp
      // becomes agent) is assertable from the recorded request inputs.
      return { ok: true, value: { accessToken: `ex-token-${mintCounter}`, expiresInSec: ttlSec } };
    },
  };
  return { endpoint, ccCalls, exCalls, egressCount: () => ccCalls.length + exCalls.length };
};

/**
 * A call-recording fake WIF exchange. By default it succeeds, returning an
 * app-only token whose value WITNESSES the Keycloak SA token it received as the
 * `client_assertion` (so a test can prove the SA token was presented to WIF, not
 * a secret). Records every request so a test can assert ZERO WIF calls on a
 * fail-closed refusal — the no-egress guarantee extends to this second egress.
 */
const recordingWif = (opts?: { ttlSec?: number }) => {
  const calls: WifExchangeRequest[] = [];
  const ttlSec = opts?.ttlSec ?? 3600;
  let counter = 0;
  const wif: EntraWifExchange = {
    exchange: async (req) => {
      calls.push(req);
      counter += 1;
      return {
        ok: true,
        value: { accessToken: `app-only-${counter}-from(${req.clientAssertion})`, expiresInSec: ttlSec },
      };
    },
  };
  return { wif, calls, wifCount: () => calls.length };
};

/**
 * A WIF exchange that DENIES every request with a settled `downstream-denied`
 * (FIC mismatch / WIF rejection / resource denial collapse). Records requests so
 * a test can assert the SA token reached WIF before the denial.
 */
const denyingWif = (resource: string, reason: string) => {
  const calls: WifExchangeRequest[] = [];
  const wif: EntraWifExchange = {
    exchange: async (req) => {
      calls.push(req);
      return err({ kind: "downstream-denied" as const, resource, reason });
    },
  };
  return { wif, calls };
};

/**
 * A WIF exchange that fails TRANSIENTLY with `infra-unreachable` on every call —
 * exactly what the shipping `unwired-entra-wif.ts` default does. Records requests
 * so a test can assert the SA token reached the (unwired) WIF hop before the
 * transient failure surfaced.
 */
const transientWif = (message: string) => {
  const calls: WifExchangeRequest[] = [];
  const wif: EntraWifExchange = {
    exchange: async (req) => {
      calls.push(req);
      return err({ kind: "infra-unreachable" as const, operation: "entra-wif" as const, message });
    },
  };
  return { wif, calls, wifCount: () => calls.length };
};

/**
 * A call-recording fake Graph transport. Returns a 202 Accepted by default (the
 * Graph `sendMail` shape) and records every request so a test can assert the
 * app-only WIF token was presented as the bearer.
 */
const recordingGraphHttp = () => {
  const requests: GraphRequest[] = [];
  const graphHttp: GraphHttp = {
    request: async (req) => {
      requests.push(req);
      return { status: 202, json: {} };
    },
  };
  return { graphHttp, requests };
};

const agentOrigin = (agentClientId: string): InvocationOrigin => ({ kind: "agent", agentClientId });
const userOrigin = (sub: string, agentClientId: string): InvocationOrigin => ({ kind: "user", sub, agentClientId });

const invocationFor = (origin: InvocationOrigin): Invocation => ({
  origin,
  runId,
  dagId: "dag-x" as Invocation["dagId"],
  nodeId,
});

const cap = (name: string): Capability => name as Capability;

/**
 * Construct a broker, defaulting the two T10 egress ports (`entraWif`,
 * `graphHttp`) to passing recording fakes when a test does not care about them.
 * A test that asserts WIF behaviour passes its own `entraWif`/`graphHttp`. This
 * keeps every pre-T10 test construction green while threading the new ports.
 */
type BrokerArgs = Parameters<typeof createKeycloakBroker>[0];
const mkBroker = (deps: Omit<BrokerArgs, "entraWif" | "graphHttp"> & Partial<Pick<BrokerArgs, "entraWif" | "graphHttp">>) =>
  createKeycloakBroker({
    entraWif: deps.entraWif ?? recordingWif().wif,
    graphHttp: deps.graphHttp ?? recordingGraphHttp().graphHttp,
    ...deps,
  });

// ── Fail-closed no-egress (SC-006 / FR-W3-003) ──────────────────────────────

describe("keycloak-broker — fail closed before any Entra call (SC-006/FR-W3-003)", () => {
  it("refuses an UNASSIGNED scope with policy-refusal and ZERO egress (Keycloak AND WIF)", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, wifCount } = recordingWif();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      // agent has NO scopes assigned → must fail closed
      assignedScopes: () => new Set<string>(),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("msgraph:mail.send")]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.kind).toBe("policy-refusal");
    if (result.error.kind === "policy-refusal") {
      expect(result.error.scope).toBe("msgraph:mail.send");
      expect(result.error.agentClientId).toBe("fugue-agent-mail");
    }
    // THE no-egress assertion: NEITHER egress was reached. The WIF hop is the
    // SECOND egress (after the Keycloak mint) — a fail-closed refusal returns
    // before either, so both call logs are empty.
    expect(egressCount()).toBe(0);
    expect(wifCount()).toBe(0);
  });

  it("refuses an UNRECOGNISED scope name with policy-refusal and ZERO egress (no agentClientId at parse)", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["whatever:thing"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("not-a-scope")]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.kind).toBe("policy-refusal");
    if (result.error.kind === "policy-refusal") {
      // Parse-time refusal: client id is unknown at parse, so the field is absent.
      expect(result.error.agentClientId).toBeUndefined();
    }
    expect(egressCount()).toBe(0);
  });
});

// ── Operation narrowing (US4 / SC-007) ──────────────────────────────────────

describe("keycloak-broker — operation narrowing (US4/SC-007)", () => {
  it("returns a handle exposing ONLY the named operation, no raw client/token field", async () => {
    const { endpoint } = recordingEndpoint();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("msgraph:mail.send")]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mint");
    const handle = result.value["msgraph:mail.send" as Capability] as unknown as Record<string, unknown>;
    expect(typeof handle.sendMail).toBe("function");
    // SC-007: no raw client / token / apiKey field is reachable on the handle.
    expect(handle.client).toBeUndefined();
    expect(handle.token).toBeUndefined();
    expect(handle.apiKey).toBeUndefined();
    // The only enumerable own key is the operation method.
    expect(Object.keys(handle)).toEqual(["sendMail"]);
  });
});

// ── Cache TTL (US4 / SC-008) ────────────────────────────────────────────────

describe("keycloak-broker — token cache TTL dedup (US4/SC-008)", () => {
  it("mints at most once per (identity,audience,scope) within the TTL window", async () => {
    const { endpoint, egressCount } = recordingEndpoint({ ttlSec: 3600 });
    const { logger } = collectLogs();
    let clock = 0;
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => clock,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    clock = 1000; // still well within the 3600s TTL
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    clock = 2000;
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);

    // Three resolutions, one mint — the cache deduped the latter two.
    expect(egressCount()).toBe(1);
  });

  it("re-mints once the cached token has expired (past TTL)", async () => {
    const { endpoint, egressCount } = recordingEndpoint({ ttlSec: 1 });
    // The app-only cache short-circuits the SA mint while the app-only token is
    // fresh, so to exercise the SA RE-mint path both caches must lapse together:
    // give the WIF the same short TTL as the SA token.
    const { wif } = recordingWif({ ttlSec: 1 });
    const { logger } = collectLogs();
    let clock = 0;
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => clock,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // expiresAt = 1000ms
    clock = 1000; // at expiry → stale (half-open window)
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);

    expect(egressCount()).toBe(2);
  });

  it("dedups the SECOND egress too: ≤ 1 WIF exchange per (identity,audience,scope) within TTL (SC-008)", async () => {
    // The WIF exchange IS a token request — caching only the SA token would leak a
    // fresh WIF egress on every resolution. Mirror the Keycloak `egressCount()` TTL
    // test for the app-only/WIF hop: three resolutions, one WIF exchange.
    const { endpoint, egressCount } = recordingEndpoint({ ttlSec: 3600 });
    const { wif, wifCount } = recordingWif({ ttlSec: 3600 });
    const { logger } = collectLogs();
    let clock = 0;
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => clock,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    clock = 1000; // within both the 3600s SA TTL and the 3600s app-only TTL
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    clock = 2000;
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);

    // Three resolutions, ONE WIF exchange — the app-only cache deduped the latter
    // two (skipping the second egress entirely).
    expect(wifCount()).toBe(1);
    // …and the app-only cache hit short-circuits the FIRST egress too: one SA mint.
    expect(egressCount()).toBe(1);
  });

  it("re-exchanges WIF once the cached app-only token has expired (past its OWN TTL)", async () => {
    // The app-only token carries its own Entra `expires_in`; once it lapses the
    // broker re-mints AND re-exchanges, proving the app-only cache honours the WIF
    // token's lifetime, not the SA token's.
    const { endpoint } = recordingEndpoint({ ttlSec: 3600 }); // SA token long-lived
    const { wif, wifCount } = recordingWif({ ttlSec: 1 }); // app-only token expires fast
    const { logger } = collectLogs();
    let clock = 0;
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => clock,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // app-only expiresAt = 1000ms
    clock = 1000; // at the app-only expiry → stale (half-open window)
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);

    expect(wifCount()).toBe(2);
  });
});

// ── Exchange semantics (SC-010 / FR-W3-008/009) ─────────────────────────────

describe("keycloak-broker — exchange semantics (SC-010/FR-W3-008/009)", () => {
  it("USER origin → exactly one Token Exchange V2; sub stays user, azp becomes agent; 0 client_credentials", async () => {
    const { endpoint, ccCalls, exCalls } = recordingEndpoint();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(userOrigin("user-abc", "fugue-frontend")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(true);
    expect(exCalls.length).toBe(1);
    expect(ccCalls.length).toBe(0); // 0 client_credentials on the user path
    expect(exCalls[0]?.userSub).toBe("user-abc"); // sub stays the user
    expect(exCalls[0]?.agentClientId).toBe("fugue-frontend"); // azp becomes the agent
    // SC-007 / FR-W3-004 — narrowing AT EGRESS: the exact scope+audience that
    // was requested is threaded into the exchange call, not a broader grant.
    const exReq = exCalls[0];
    if (exReq === undefined) throw new Error("expected one exchange call");
    expect(scopeName(exReq.scope)).toBe("msgraph:mail.send");
    expect(exReq.audience).toBe(audienceForScope(exReq.scope));
    expect(exReq.audience).toBe("https://graph.microsoft.com");
  });

  it("AGENT origin → exactly one client_credentials mint; 0 exchanges (FR-W3-009)", async () => {
    const { endpoint, ccCalls, exCalls } = recordingEndpoint();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:sites.read"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-sites")),
      [cap("msgraph:sites.read")],
    );

    expect(result.ok).toBe(true);
    expect(ccCalls.length).toBe(1);
    expect(exCalls.length).toBe(0); // agent hops perform ZERO exchanges
    expect(ccCalls[0]?.agentClientId).toBe("fugue-agent-sites");
    // SC-007 / FR-W3-004 — narrowing AT EGRESS for the agent (client_credentials)
    // path: the requested scope+audience are threaded verbatim into the mint.
    const ccReq = ccCalls[0];
    if (ccReq === undefined) throw new Error("expected one client_credentials call");
    expect(scopeName(ccReq.scope)).toBe("msgraph:sites.read");
    expect(ccReq.audience).toBe(audienceForScope(ccReq.scope));
    expect(ccReq.audience).toBe("https://graph.microsoft.com");
  });
});

// ── Audit coverage (FR-X-004 / SC-009) ──────────────────────────────────────

describe("keycloak-broker — correlated audit on every mint AND refusal (FR-X-004/SC-009)", () => {
  it("a successful mint emits exactly one record with sub/azp/runId/nodeId/scope", async () => {
    const { endpoint } = recordingEndpoint();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    await broker.mintFor(invocationFor(userOrigin("user-abc", "fugue-frontend")), [cap("msgraph:mail.send")]);

    const mintRecords = logs.filter((l) => l.data?.result === "mint");
    expect(mintRecords.length).toBe(1);
    const rec = mintRecords[0]?.data ?? {};
    expect(rec.sub).toBe("user-abc");
    expect(rec.azp).toBe("fugue-frontend");
    expect(rec.runId).toBe(runId as string);
    expect(rec.nodeId).toBe(nodeId as string);
    expect(rec.scope).toBe("msgraph:mail.send");
    expect(rec.via).toBe("token-exchange-v2");
  });

  it("a fail-closed refusal emits exactly one record with the five fields (agent hop → no sub)", async () => {
    const { endpoint } = recordingEndpoint();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("msgraph:mail.send")]);

    const refusalRecords = logs.filter((l) => l.data?.result === "refusal");
    expect(refusalRecords.length).toBe(1);
    const rec = refusalRecords[0]?.data ?? {};
    expect(rec.azp).toBe("fugue-agent-mail");
    expect(rec.runId).toBe(runId as string);
    expect(rec.nodeId).toBe(nodeId as string);
    expect(rec.scope).toBe("msgraph:mail.send");
    expect(rec.reason).toBe("scope-not-assigned");
    expect("sub" in rec).toBe(false); // agent hop has no end-user subject
  });
});

// ── Endpoint-denial branch — refusal audit + Result surfacing (A3 / SC-009) ─

/**
 * A token endpoint that DENIES every mint/exchange with a settled
 * `downstream-denied`. Exercises the broker's `mint-failed:<kind>` refusal-audit
 * branch (keycloak-broker.ts ~261-265) which the always-`ok:true` recording fake
 * never reaches — closing the SC-009 "100% of refusals audited" coverage gap.
 */
const denyingEndpoint = (resource: string, reason: string) => {
  const denial = err({ kind: "downstream-denied" as const, resource, reason });
  const endpoint: KeycloakTokenEndpoint = {
    mintClientCredentials: async () => denial,
    exchangeV2: async () => denial,
  };
  return { endpoint };
};

describe("keycloak-broker — endpoint denial surfaces + audits as refusal (A3/SC-009)", () => {
  it("surfaces the exact downstream-denied error AND emits one correlated refusal record", async () => {
    const { endpoint } = denyingEndpoint("https://graph.microsoft.com", "audience not permitted");
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      // Scope IS assigned — so the local gate passes and the endpoint is reached,
      // where it denies. This is the post-gate, endpoint-side denial path.
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    // (a) the exact typed error is surfaced VERBATIM on the Result channel.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.error.kind).toBe("downstream-denied");
    if (result.error.kind === "downstream-denied") {
      expect(result.error.resource).toBe("https://graph.microsoft.com");
      expect(result.error.reason).toBe("audience not permitted");
    }

    // (b) exactly one correlated refusal record with all five fields + a
    //     mint-failed reason that names the kind.
    const refusalRecords = logs.filter((l) => l.data?.result === "refusal");
    expect(refusalRecords.length).toBe(1);
    const rec = refusalRecords[0]?.data ?? {};
    expect(rec.azp).toBe("fugue-agent-mail");
    expect(rec.runId).toBe(runId as string);
    expect(rec.nodeId).toBe(nodeId as string);
    expect(rec.scope).toBe("msgraph:mail.send");
    expect(rec.reason).toBe("mint-failed:downstream-denied");
    // No mint record was emitted — the denial never minted.
    expect(logs.filter((l) => l.data?.result === "mint").length).toBe(0);
  });
});

// ── WIF second-egress hop (T10 / FR-W4-004 / SC-011 / FR-X-002 / SC-009) ────

describe("keycloak-broker — Entra WIF second egress after the Keycloak mint (T10)", () => {
  it("presents the Keycloak SA token as the WIF client_assertion, narrowed to the scope+audience", async () => {
    const { endpoint } = recordingEndpoint();
    const { wif, calls } = recordingWif();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(true);
    // Exactly one WIF exchange, AFTER the Keycloak mint: the SA token minted by
    // the (recording) Keycloak endpoint is the `client_assertion` — NOT a secret.
    expect(calls.length).toBe(1);
    const wifReq = calls[0];
    if (wifReq === undefined) throw new Error("expected one WIF exchange");
    expect(wifReq.clientAssertion).toBe("cc-token-1"); // the SA token from the mint
    expect(scopeName(wifReq.scope)).toBe("msgraph:mail.send");
    expect(wifReq.audience).toBe("https://graph.microsoft.com");
  });

  it("builds the handle over the APP-ONLY token (not the SA token) and exposes only the operation", async () => {
    const { endpoint } = recordingEndpoint();
    const { wif } = recordingWif();
    const { graphHttp, requests } = recordingGraphHttp();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      graphHttp,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mint");
    const handle = result.value["msgraph:mail.send" as Capability] as unknown as Record<string, unknown>;
    // SC-007: only the operation method — no client/token/apiKey field.
    expect(Object.keys(handle)).toEqual(["sendMail"]);

    // Driving the operation presents the APP-ONLY WIF token as the bearer (the
    // app-only value witnesses the SA token it was exchanged from), never the SA
    // token directly and never a stored secret.
    await (handle.sendMail as (m: unknown) => Promise<unknown>)({ to: "a@b.c", subject: "s", body: "b" });
    expect(requests.length).toBe(1);
    expect(requests[0]?.bearer).toBe("app-only-1-from(cc-token-1)");
  });

  it("surfaces a WIF downstream-denied VERBATIM and audits it as a mint-failed refusal (FR-X-002/SC-009)", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, calls } = denyingWif("https://graph.microsoft.com", "FIC subject mismatch");
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      // Scope IS assigned and the Keycloak mint SUCCEEDS — the denial is at the WIF
      // hop, AFTER the first egress. This is the post-mint, WIF-side denial path.
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    // The Keycloak mint DID happen (first egress); the WIF exchange was reached
    // and denied (second egress).
    expect(egressCount()).toBe(1);
    expect(calls.length).toBe(1);

    // (a) the exact typed error is surfaced verbatim on the Result channel.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected WIF denial");
    expect(result.error.kind).toBe("downstream-denied");
    if (result.error.kind === "downstream-denied") {
      expect(result.error.resource).toBe("https://graph.microsoft.com");
      expect(result.error.reason).toBe("FIC subject mismatch");
    }

    // (b) the WIF denial is audited as a mint-failed refusal — SC-009 stays 100%
    //     across BOTH hops. No mint record is emitted (the handle never built).
    const refusalRecords = logs.filter((l) => l.data?.result === "refusal");
    expect(refusalRecords.length).toBe(1);
    const rec = refusalRecords[0]?.data ?? {};
    expect(rec.scope).toBe("msgraph:mail.send");
    expect(rec.reason).toBe("mint-failed:downstream-denied");
    expect(logs.filter((l) => l.data?.result === "mint").length).toBe(0);
  });

  it("surfaces a WIF infra-unreachable VERBATIM and audits it as mint-failed:infra-unreachable (the unwired default path)", async () => {
    // This is the path the SHIPPING `unwired-entra-wif.ts` default exercises: an
    // assigned scope whose Keycloak mint succeeds but whose WIF hop is not wired
    // surfaces a retriable `infra-unreachable`, NEVER a silent success or a token.
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, calls } = transientWif("Entra WIF exchange is not wired");
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    // The Keycloak mint DID happen (first egress); the WIF exchange was reached
    // and failed transiently (second egress), distinct from a settled denial.
    expect(egressCount()).toBe(1);
    expect(calls.length).toBe(1);

    // (a) the exact typed error is surfaced verbatim on the Result channel.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected WIF transient failure");
    expect(result.error.kind).toBe("infra-unreachable");
    if (result.error.kind === "infra-unreachable") {
      expect(result.error.operation).toBe("entra-wif");
      expect(result.error.message).toBe("Entra WIF exchange is not wired");
    }

    // (b) the transient is audited as a mint-failed refusal naming the kind —
    //     SC-009 stays 100%. No mint record (the handle never built).
    const refusalRecords = logs.filter((l) => l.data?.result === "refusal");
    expect(refusalRecords.length).toBe(1);
    expect(refusalRecords[0]?.data?.reason).toBe("mint-failed:infra-unreachable");
    expect(logs.filter((l) => l.data?.result === "mint").length).toBe(0);
  });

  it("an AGENT-path successful resolution audits the mint with via === client_credentials", async () => {
    // The user-path `via === "token-exchange-v2"` is checked in the audit-coverage
    // suite; this closes the agent-path half — the agent hop mints via
    // `client_credentials` (NO token exchange, FR-W3-009) and the audit witnesses it.
    const { endpoint } = recordingEndpoint();
    const { wif } = recordingWif();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("msgraph:mail.send")]);

    const mintRecords = logs.filter((l) => l.data?.result === "mint");
    expect(mintRecords.length).toBe(1);
    expect(mintRecords[0]?.data?.via).toBe("client_credentials");
    expect("sub" in (mintRecords[0]?.data ?? {})).toBe(false); // agent hop → no subject
  });
});

// ── Audit never alters control flow (A2) ────────────────────────────────────

describe("keycloak-broker — a throwing audit sink never breaks mintFor's Result (A2)", () => {
  it("returns the ok handle on SUCCESS even when the tracer throws inside the mint audit", async () => {
    const { endpoint } = recordingEndpoint();
    const { logger } = collectLogs();
    // A tracer that throws — the success-path audit (`audit.mint`) runs AFTER the
    // token is minted+cached, so a throw here must NOT surface as a rejection.
    const throwingTracer: Tracer = {
      withSpan: async () => {
        throw new Error("tracer exploded");
      },
    };
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: throwingTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    // The minted token survives: mintFor resolves to the ok handle, not a reject.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mint despite throwing tracer");
    const handle = result.value["msgraph:mail.send" as Capability] as unknown as Record<string, unknown>;
    expect(typeof handle.sendMail).toBe("function");
  });

  it("returns the typed err on REFUSAL even when the logger throws inside the refusal audit", async () => {
    const { endpoint } = recordingEndpoint();
    // A logger that throws on warn (the refusal log line). The refusal must still
    // surface as a typed policy-refusal on the Result channel, not a rejection.
    const throwingLogger: LogPort = {
      info: () => {},
      warn: () => {
        throw new Error("logger exploded");
      },
      error: () => {},
    };
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(), // unassigned → fail closed
      tracer: passTracer,
      logger: throwingLogger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal despite throwing logger");
    expect(result.error.kind).toBe("policy-refusal");
  });
});

// ── Pure helpers (round-trip / audience mapping) ────────────────────────────

describe("keycloak-broker — pure scope helpers", () => {
  it("scopeName round-trips parseScope for every recognised scope", () => {
    for (const name of ["msgraph:mail.send", "msgraph:sites.read", "dynamics:read"]) {
      const parsed = parseScope(name);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(scopeName(parsed.value)).toBe(name);
    }
  });

  it("audienceForScope maps each provider to its downstream resource", () => {
    const mail = parseScope("msgraph:mail.send");
    const dyn = parseScope("dynamics:read");
    if (!mail.ok || !dyn.ok) throw new Error("parse failed");
    expect(audienceForScope(mail.value)).toBe("https://graph.microsoft.com");
    expect(audienceForScope(dyn.value)).toBe("https://dynamics.microsoft.com");
  });
});
