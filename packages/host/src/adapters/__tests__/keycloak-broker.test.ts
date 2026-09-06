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
import type {
  Capability,
  Invocation,
  InvocationOrigin,
  ScopedCapabilityHandle,
  Tracer,
  RunId,
} from "@fuguejs/framework";
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
import { markSubjectToken, type SubjectToken } from "../../domain/auth.js";
import { collectLogs } from "./fixtures/log-capture.js";

// ── Test spine ──────────────────────────────────────────────────────────────

const runId = makeRunId("run-001");
const nodeId = makeNodeId("node-a");

/** A tracer that just runs the span body — enough to exercise the audit path. */
const passTracer: Tracer = { withSpan: async (_n, _t, fn) => fn() };

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
      return err({ kind: "infra-unreachable" as const, operation: "federation" as const, hop: "entra-wif", message });
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

const mintedClient = (
  scoped: ScopedCapabilityHandle,
  capability: Capability,
): unknown => {
  const binding = scoped[capability];
  if (binding?.clientKind !== "non-llm") {
    throw new Error(`expected non-LLM scoped binding for '${capability}'`);
  }
  return binding.client;
};

/**
 * Construct a broker, defaulting the two T10 egress ports (`entraWif`,
 * `graphHttp`) to passing recording fakes when a test does not care about them.
 * A test that asserts WIF behaviour passes its own `entraWif`/`graphHttp`. This
 * keeps every pre-T10 test construction green while threading the new ports.
 */
type BrokerArgs = Parameters<typeof createKeycloakBroker>[0];

/**
 * A fixed verified subject token the default `resolveSubjectToken` hands back for
 * every run — so the pre-T7 user-path tests (which assert the exchange SUCCEEDS)
 * keep exercising the proof-bearing path. Tests that pin the FR-030 fail-closed
 * behaviour override `resolveSubjectToken` with one that returns `undefined`.
 */
const TEST_SUBJECT_TOKEN: SubjectToken = markSubjectToken("user.jwt.proof");

const mkBroker = (
  deps: Omit<BrokerArgs, "entraWif" | "graphHttp" | "resolveSubjectToken"> &
    Partial<Pick<BrokerArgs, "entraWif" | "graphHttp" | "resolveSubjectToken">>,
) =>
  createKeycloakBroker({
    entraWif: deps.entraWif ?? recordingWif().wif,
    graphHttp: deps.graphHttp ?? recordingGraphHttp().graphHttp,
    resolveSubjectToken: deps.resolveSubjectToken ?? (() => TEST_SUBJECT_TOKEN),
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

  it("PASSES THROUGH an unrecognised scope-shaped name — provides() is false, so run-start validation owns it (A1)", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["whatever:thing"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    // Scope-shaped (`<provider>:<operation>`) but not a name the broker
    // `provides()`. mintFor skips EXACTLY the `parseScope(...) === undefined`
    // set, so the
    // two predicates agree: the broker mints precisely what `provides()` claims,
    // and an unparseable name is run-start-validated against the base context
    // (`missing-capability` there if unwired) — never policy-refused at dispatch.
    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("msgraph:nonexistent")]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected pass-through, got refusal");
    expect(Object.keys(result.value)).toEqual([]);
    expect(egressCount()).toBe(0);
    expect(broker.provides?.("msgraph:nonexistent" as Capability)).toBe(false);
    // No refusal record either — a pass-through is not a policy decision.
    expect(logs.filter((l) => l.data?.result === "refusal").length).toBe(0);
  });

  it("PASSES THROUGH a colon-named CUSTOM capability wired statically (ADR-0051) — the static client survives a live broker", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, wifCount } = recordingWif();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    // A consumer-augmented custom capability with a colon in its name (legal per
    // ADR-0051) is NOT a scope this broker provides: `provides()` is false, so
    // run-start validation demanded it on the boot-scoped base context, and
    // mintFor must pass it through so that static client survives — never refuse
    // it at dispatch (the old `name.includes(":")` ownership test would have).
    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("mycorp:widget"), cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mixed requires to resolve");
    // Only the broker-provided scope is minted; the custom name is skipped so
    // the framework merge keeps the base context's static client for it.
    expect(Object.keys(result.value)).toEqual(["msgraph:mail.send"]);
    expect(broker.provides?.("mycorp:widget" as Capability)).toBe(false);
    expect(broker.provides?.("msgraph:mail.send" as Capability)).toBe(true);
    // Exactly one egress pair — for the recognised scope, none for the custom name.
    expect(egressCount()).toBe(1);
    expect(wifCount()).toBe(1);
    expect(logs.filter((l) => l.data?.result === "refusal").length).toBe(0);
  });

  it("PASSES THROUGH a plain (non-scope-shaped) capability name — it is a base-context client, not a scope the broker mints (C1)", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    // A name without a `:` (e.g. the static `http`/`db` clients) is NOT a
    // downstream scope: the broker skips it (the base context supplies it and
    // the framework merges minted handles over that base). No refusal, no egress,
    // no handle minted for it — and `provides("http")` is false so run-start
    // validation still gates it against the base context.
    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("http")]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected pass-through, got refusal");
    expect(Object.keys(result.value)).toEqual([]);
    expect(egressCount()).toBe(0);
    expect(broker.provides?.("http" as Capability)).toBe(false);
    expect(broker.provides?.("msgraph:mail.send" as Capability)).toBe(true);
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
    const handle = mintedClient(
      result.value,
      cap("msgraph:mail.send"),
    ) as Record<string, unknown>;
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

    // ttlSec 1 → lifetime 1000ms, margin min(60_000, 500) = 500 → effective
    // expiry at 500ms (the half-lifetime floor), well before clock = 1000.
    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // effective expiresAt = 500ms
    clock = 1000; // past the 500ms effective expiry → stale
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

// ── Early-refresh skew margin (review I2 / A10) ─────────────────────────────

describe("keycloak-broker — early-refresh skew margin re-mints BEFORE real expiry (I2)", () => {
  it("a lookup inside the margin window (mint + lifetime − margin + ε) MISSES and re-mints; well inside the window it hits", async () => {
    // ttlSec 3600 → lifetime 3_600_000ms, margin 60_000ms → effective expiry at
    // 3_540_000ms. The margin exists so a token is never presented downstream
    // microseconds before it lapses (which would 401 → `downstream-denied`, the
    // never-retried category). Removing the margin would keep the second lookup
    // a cache HIT — this test pins the margin itself.
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

    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // mint at t=0

    clock = 3_500_000; // well inside the margin-adjusted window → HIT, no egress
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    expect(egressCount()).toBe(1);
    expect(wifCount()).toBe(1);

    clock = 3_540_001; // inside the RAW lifetime (< 3_600_000) but past the
    // margin-adjusted expiry → MISS → re-mint. Without the margin this would hit.
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    expect(egressCount()).toBe(2);
    expect(wifCount()).toBe(2);
  });
});

// ── Half-lifetime floor on the effective TTL (review gap, 5/10) ──────────────

describe("keycloak-broker — half-lifetime floor keeps a short-lived token usable (review: effectiveTtlMs)", () => {
  it("a ttlSec:1 token minted at t=0 is still a cache HIT at t=400ms — the margin is floored at lifetime/2, so the token is not born stale", async () => {
    // ttlSec 1 → lifetime 1000ms. Without the `Math.min(skew, lifetime/2)` floor
    // the 60_000ms skew margin would swallow the whole lifetime (effective TTL
    // −59_000ms): EVERY lookup would miss and re-mint — the token born stale.
    // With the floor, margin = 500ms → effective expiry 500ms, so t=400ms HITS.
    const { endpoint, egressCount } = recordingEndpoint({ ttlSec: 1 });
    const { wif, wifCount } = recordingWif({ ttlSec: 1 });
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

    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // mint at t=0, effective expiry 500ms
    clock = 400; // inside the floored window (400 < 500)
    const second = await broker.mintFor(inv, [cap("msgraph:mail.send")]);

    expect(second.ok).toBe(true);
    // Cache HIT on BOTH hops: one SA mint, one WIF exchange — the second
    // resolution added zero egress.
    expect(egressCount()).toBe(1);
    expect(wifCount()).toBe(1);
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
    expect(exReq.audience).toBe(audienceForScope(exReq.scope, undefined)!);
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
    expect(ccReq.audience).toBe(audienceForScope(ccReq.scope, undefined)!);
    expect(ccReq.audience).toBe("https://graph.microsoft.com");
  });
});

// ── User subject_token proof threading + fail-closed (T7 / FR-030/031/032) ───

describe("keycloak-broker — user exchange presents the resolved subject_token (FR-030/FR-031)", () => {
  it("USER branch passes the run's resolved subject_token into exchangeV2; sub stays user, azp becomes agent", async () => {
    const { endpoint, exCalls, ccCalls } = recordingEndpoint();
    const { logger } = collectLogs();
    const proof = markSubjectToken("verified.user.jwt");
    const seen: RunId[] = [];
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      // The side-channel hands back THIS run's verified token (the host-side
      // thread the run-context factory bound at run start, FR-032).
      resolveSubjectToken: (rid) => {
        seen.push(rid);
        return proof;
      },
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(userOrigin("user-abc", "fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(true);
    // Exactly one exchange, the resolved proof presented as the subject_token.
    expect(exCalls.length).toBe(1);
    expect(ccCalls.length).toBe(0); // 0 client_credentials on the user path
    expect(exCalls[0]?.subjectToken).toBe(proof);
    expect(exCalls[0]?.userSub).toBe("user-abc"); // sub stays user (FR-031)
    expect(exCalls[0]?.agentClientId).toBe("fugue-agent-mail"); // azp becomes agent
    // The resolver was keyed on the run's id (the host-side side-channel key).
    expect(seen).toEqual([runId]);
  });

  it("AGENT branch NEVER resolves nor presents a subject_token (FR-W3-009)", async () => {
    const { endpoint, ccCalls, exCalls } = recordingEndpoint();
    const { logger } = collectLogs();
    let resolverCalls = 0;
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:sites.read"]),
      // If the agent branch ever consulted the side-channel, this counter would tick.
      resolveSubjectToken: () => {
        resolverCalls += 1;
        return markSubjectToken("should-never-be-asked");
      },
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-sites")),
      [cap("msgraph:sites.read")],
    );

    expect(result.ok).toBe(true);
    expect(ccCalls.length).toBe(1); // client_credentials only
    expect(exCalls.length).toBe(0); // zero exchanges — and so zero subject tokens
    // The agent hop never even asks the side-channel for a subject token.
    expect(resolverCalls).toBe(0);
  });
});

describe("keycloak-broker — user exchange FAILS CLOSED with no resolvable subject_token (FR-030)", () => {
  it("refuses (policy-refusal) and performs ZERO egress when resolveSubjectToken returns undefined — no proof-less token", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, wifCount } = recordingWif();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      // The scope IS assigned — the local scope gate passes — but the user run has
      // NO resolvable verified token. The exchange MUST NOT proceed proof-less.
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      resolveSubjectToken: () => undefined,
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(userOrigin("user-abc", "fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    // Fail closed: a settled policy-refusal (NOT a token, NOT a silent success).
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail-closed refusal");
    expect(result.error.kind).toBe("policy-refusal");
    if (result.error.kind === "policy-refusal") {
      expect(result.error.scope).toBe("msgraph:mail.send");
      expect(result.error.agentClientId).toBe("fugue-agent-mail");
    }
    // NEVER issue a proof-less token: NO exchange egress AND no WIF egress.
    expect(egressCount()).toBe(0);
    expect(wifCount()).toBe(0);
    // The fail-closed outcome is audited as a mint-failed refusal (SC-009).
    const refusals = logs.filter((l) => l.data?.result === "refusal");
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.data?.reason).toBe("mint-failed:policy-refusal");
    // No mint record — nothing was minted.
    expect(logs.filter((l) => l.data?.result === "mint").length).toBe(0);
  });
});

describe("keycloak-broker — NFR-011: no raw subject_token reachable from a returned handle", () => {
  it("the minted user handle exposes ONLY the operation method — no token/subjectToken/client field", async () => {
    const { endpoint } = recordingEndpoint();
    const { wif } = recordingWif();
    const { graphHttp } = recordingGraphHttp();
    const { logger } = collectLogs();
    const proof = markSubjectToken("verified.user.jwt-NFR011");
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      graphHttp,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      resolveSubjectToken: () => proof,
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(userOrigin("user-abc", "fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mint");
    const handle = mintedClient(
      result.value,
      cap("msgraph:mail.send"),
    ) as Record<string, unknown>;
    // Only the operation method — no raw authority of ANY kind on the handle.
    expect(Object.keys(handle)).toEqual(["sendMail"]);
    expect(handle.token).toBeUndefined();
    expect(handle.subjectToken).toBeUndefined();
    expect(handle.client).toBeUndefined();
    // The raw subject token does not appear ANYWHERE in the handle's serialised form.
    expect(JSON.stringify(handle)).not.toContain("verified.user.jwt-NFR011");
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
    const handle = mintedClient(
      result.value,
      cap("msgraph:mail.send"),
    ) as Record<string, unknown>;
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
      expect(result.error.operation).toBe("federation");
      expect(result.error.hop).toBe("entra-wif");
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
    const handle = mintedClient(
      result.value,
      cap("msgraph:mail.send"),
    ) as Record<string, unknown>;
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
      expect(parsed).toBeDefined();
      if (parsed === undefined) continue;
      expect(scopeName(parsed)).toBe(name);
    }
  });

  it("audienceForScope maps each provider to its downstream resource (FR-042: Dynamics → per-org host)", () => {
    const mail = parseScope("msgraph:mail.send");
    const dyn = parseScope("dynamics:read");
    if (mail === undefined || dyn === undefined) throw new Error("parse failed");
    // msgraph never depends on the org host.
    expect(audienceForScope(mail, undefined)).toBe("https://graph.microsoft.com");
    expect(audienceForScope(mail, "org.crm4.dynamics.com")).toBe("https://graph.microsoft.com");
    // Dynamics targets the CONFIGURED per-org host; UNSET → undefined (fail-closed).
    expect(audienceForScope(dyn, "org.crm4.dynamics.com")).toBe("https://org.crm4.dynamics.com");
    expect(audienceForScope(dyn, undefined)).toBeUndefined();
  });
});

// ── Cross-identity cache isolation + single-flight (review C7 / SC-008) ──────

describe("keycloak-broker — cache keyed by IDENTITY, not just scope (C7.2)", () => {
  it("two user hops with DIFFERENT subs (same agent+scope, same TTL window) each mint their OWN token — no cross-identity reuse", async () => {
    const { endpoint, exCalls, egressCount } = recordingEndpoint({ ttlSec: 3600 });
    const { wif, wifCount } = recordingWif({ ttlSec: 3600 });
    const { graphHttp, requests } = recordingGraphHttp();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      graphHttp,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 1_000, // fixed clock → both calls inside the same freshness window
    });

    const a = await broker.mintFor(invocationFor(userOrigin("user-A", "fugue-agent-mail")), [cap("msgraph:mail.send")]);
    const b = await broker.mintFor(invocationFor(userOrigin("user-B", "fugue-agent-mail")), [cap("msgraph:mail.send")]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("expected both to resolve");

    // Distinct subjects ⇒ distinct cache identities ⇒ TWO exchanges + TWO WIF
    // hops. If the cache keyed on scope alone (or omitted the sub), user-B would
    // be served user-A's token and egress would be 1.
    expect(egressCount()).toBe(2);
    expect(wifCount()).toBe(2);
    expect(exCalls.map((c) => c.userSub).sort()).toEqual(["user-A", "user-B"]);

    // And the bearer each user's handle presents downstream is DISTINCT.
    const sendMailA = mintedClient(a.value, cap("msgraph:mail.send")) as {
      sendMail: (m: { from: string; to: string; subject: string; body: string }) => Promise<unknown>;
    };
    const sendMailB = mintedClient(b.value, cap("msgraph:mail.send")) as typeof sendMailA;
    await sendMailA.sendMail({ from: "a@x", to: "t@x", subject: "s", body: "b" });
    await sendMailB.sendMail({ from: "b@x", to: "t@x", subject: "s", body: "b" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.bearer).not.toBe(requests[1]?.bearer);
  });

  it("the SAME user hop reused within the TTL window mints ONCE (SC-008) — cache HIT, no second egress", async () => {
    const { endpoint, egressCount } = recordingEndpoint({ ttlSec: 3600 });
    const { wif, wifCount } = recordingWif({ ttlSec: 3600 });
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 1_000,
    });

    const inv = invocationFor(userOrigin("user-A", "fugue-agent-mail"));
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // second, within TTL

    expect(egressCount()).toBe(1);
    expect(wifCount()).toBe(1);
  });
});

describe("keycloak-broker — single-flight under concurrency (review I1/SC-008)", () => {
  it("two CONCURRENT resolutions of the SAME triple share ONE acquisition — one SA mint, one WIF (not two)", async () => {
    // Make both egresses await a tick so the two mintFor calls genuinely overlap
    // before either populates the cache — the exact window the single-flight closes.
    let cc = 0;
    const endpoint: KeycloakTokenEndpoint = {
      mintClientCredentials: async (_req) => {
        cc += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, value: { accessToken: `cc-${cc}`, expiresInSec: 3600 } };
      },
      exchangeV2: async () => ({ ok: true, value: { accessToken: "ex", expiresInSec: 3600 } }),
    };
    let wifN = 0;
    const wif: EntraWifExchange = {
      exchange: async (req) => {
        wifN += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, value: { accessToken: `app-${wifN}-from(${req.clientAssertion})`, expiresInSec: 3600 } };
      },
    };
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 1_000,
    });

    const inv = invocationFor(agentOrigin("fugue-agent-mail"));
    const [a, b] = await Promise.all([
      broker.mintFor(inv, [cap("msgraph:mail.send")]),
      broker.mintFor(inv, [cap("msgraph:mail.send")]),
    ]);
    expect(a.ok && b.ok).toBe(true);

    // Single-flight: the second concurrent call awaited the first's promise rather
    // than firing its own egress. Without it, both would miss and mint → 2 each.
    expect(cc).toBe(1);
    expect(wifN).toBe(1);
  });

  it("different triples minting concurrently do not clobber each other's SA cache entry (no lost update)", async () => {
    // Two DISTINCT scopes minted in parallel; both entries must survive so a
    // follow-up resolution of each is a cache hit (egress does not grow).
    const { endpoint, egressCount } = recordingEndpoint({ ttlSec: 3600 });
    const { wif } = recordingWif({ ttlSec: 3600 });
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send", "msgraph:sites.read"]),
      tracer: passTracer,
      logger,
      now: () => 1_000,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-both"));
    await Promise.all([
      broker.mintFor(inv, [cap("msgraph:mail.send")]),
      broker.mintFor(inv, [cap("msgraph:sites.read")]),
    ]);
    const egressAfterFirst = egressCount();
    // Re-resolve BOTH — if a lost update had dropped one SA entry, this would
    // re-mint it and egress would grow. Both should be cache hits.
    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    await broker.mintFor(inv, [cap("msgraph:sites.read")]);
    expect(egressCount()).toBe(egressAfterFirst);
  });
});

// ── Throwing port → err on the Result channel, never a rejection (A5) ───────

describe("keycloak-broker — a THROWING injected port surfaces as err, never an unhandledRejection (A5)", () => {
  it("both concurrent waiters of one triple receive err(infra-unreachable) when the endpoint THROWS (port-contract violation)", async () => {
    // The port contract is `Result`-only — but if a buggy adapter throws anyway,
    // the shared in-flight promise must NOT reject: a rejection would poison the
    // second waiter AND (via the unobserved cleanup promise) escape as a
    // process-level unhandledRejection.
    let calls = 0;
    const endpoint: KeycloakTokenEndpoint = {
      mintClientCredentials: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5)); // let the two waiters overlap
        throw new Error("port contract violated");
      },
      exchangeV2: async () => {
        throw new Error("port contract violated");
      },
    };
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const [a, b] = await Promise.all([
        broker.mintFor(inv, [cap("msgraph:mail.send")]),
        broker.mintFor(inv, [cap("msgraph:mail.send")]),
      ]);

      // Both waiters got a TYPED err — neither saw a rejection.
      expect(a.ok).toBe(false);
      expect(b.ok).toBe(false);
      if (!a.ok) expect(a.error.kind).toBe("infra-unreachable");
      if (!b.ok) expect(b.error.kind).toBe("infra-unreachable");
      // Single-flight still held: ONE throwing acquisition shared by both.
      expect(calls).toBe(1);
      // Both resolutions audited the failure as a mint-failed refusal (SC-009).
      expect(logs.filter((l) => l.data?.reason === "mint-failed:infra-unreachable").length).toBe(2);

      // Give any escaped rejection a macrotask to reach the process handler.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ── Pass-4: acquisition witness, hop attribution, mintFor fence ──────────────

describe("keycloak-broker — audit acquisition witnesses real egress vs reuse (SC-008 observability)", () => {
  it("first resolution audits acquisition 'minted'; an in-TTL repeat audits 'cache-reuse' — minted count === egress count", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, wifCount } = recordingWif();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    await broker.mintFor(inv, [cap("msgraph:mail.send")]);
    await broker.mintFor(inv, [cap("msgraph:mail.send")]); // in-TTL → cache hit

    const mints = logs.filter((l) => l.data?.result === "mint");
    expect(mints.map((l) => l.data?.acquisition)).toEqual(["minted", "cache-reuse"]);
    // The audit trail now reconciles against the real egress: exactly one SA
    // mint and one WIF exchange, matching the single 'minted' record.
    expect(egressCount()).toBe(1);
    expect(wifCount()).toBe(1);
    expect(mints.filter((l) => l.data?.acquisition === "minted").length).toBe(1);
  });

  it("CONCURRENT resolutions of one triple: the single-flight leader audits 'minted', waiters audit 'cache-reuse'", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
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
    const inv = invocationFor(agentOrigin("fugue-agent-mail"));

    await Promise.all([
      broker.mintFor(inv, [cap("msgraph:mail.send")]),
      broker.mintFor(inv, [cap("msgraph:mail.send")]),
      broker.mintFor(inv, [cap("msgraph:mail.send")]),
    ]);

    const acquisitions = logs
      .filter((l) => l.data?.result === "mint")
      .map((l) => l.data?.acquisition)
      .sort();
    // One real egress pair shared by three resolutions: exactly ONE 'minted'.
    expect(acquisitions).toEqual(["cache-reuse", "cache-reuse", "minted"]);
    expect(egressCount()).toBe(1);
  });
});

describe("keycloak-broker — throw fence attributes the hop actually in flight", () => {
  it("a THROWING EntraWif port surfaces as infra-unreachable federation/entra-wif — not the SA hop", async () => {
    const { endpoint } = recordingEndpoint();
    const throwingWif: EntraWifExchange = {
      exchange: async () => {
        throw new Error("wif port exploded");
      },
    };
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: throwingWif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("infra-unreachable");
      if (result.error.kind === "infra-unreachable") {
        // The WIF hop threw — operators must be pointed at the federation
        // egress, not the Keycloak hop the origin happens to mint by.
        expect(result.error.operation).toBe("federation");
        expect(result.error.hop).toBe("entra-wif");
      }
    }
  });

  it("a THROWING SA endpoint still attributes the origin's own hop (agent → mint/client-credentials)", async () => {
    const throwingEndpoint: KeycloakTokenEndpoint = {
      mintClientCredentials: async () => {
        throw new Error("sa endpoint exploded");
      },
      exchangeV2: async () => {
        throw new Error("sa endpoint exploded");
      },
    };
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint: throwingEndpoint,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "infra-unreachable") {
      expect(result.error.operation).toBe("mint");
      expect(result.error.hop).toBe("client-credentials");
    }
  });
});

describe("keycloak-broker — mintFor is fenced end-to-end (never rejects, SC-009 holds)", () => {
  it("a hostile thrown value whose coercion throws still resolves to a typed error", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { logger, logs } = collectLogs();
    const hostile = {
      toString(): string {
        throw new Error("hostile coercion");
      },
    };
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => { throw hostile; },
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "infra-unreachable") {
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
    expect(egressCount()).toBe(0);
    expect(logs.filter((entry) => entry.data?.result === "refusal")).toHaveLength(1);
  });

  it("a THROWING AssignedScopes port resolves to infra-unreachable AND emits a mint-failed refusal audit", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      assignedScopes: () => {
        throw new Error("realm policy store exploded");
      },
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    // The never-throw port contract holds even for a throwing injected dep:
    // mintFor RESOLVES to a typed err (a rejection would escape to the wave
    // catch-all as a retriable node-crash).
    const result = await broker.mintFor(
      invocationFor(agentOrigin("fugue-agent-mail")),
      [cap("msgraph:mail.send")],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("infra-unreachable");
      if (result.error.kind === "infra-unreachable") {
        expect(result.error.message).toContain("realm policy store exploded");
      }
    }
    // No egress happened (the throw preceded the gate) …
    expect(egressCount()).toBe(0);
    // … and the failure still produced a correlated audit record (SC-009).
    const refusals = logs.filter((l) => l.data?.result === "refusal");
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.data?.reason).toBe("mint-failed:infra-unreachable");
    expect(refusals[0]?.data?.azp).toBe("fugue-agent-mail");
    expect(refusals[0]?.data?.runId).toBe(runId as string);
  });
});

// ── Dynamics per-org host targeting + fail-closed (FR-042) ───────────────────
// The `dynamics:read` capability targets the CONFIGURED per-org Dataverse host:
// the token audience and the read URL are both `https://<DYNAMICS_ORG_HOST>...`.
// When DYNAMICS_ORG_HOST is unset the scope FAILS CLOSED with zero egress.
describe("keycloak-broker — Dynamics targets the configured per-org host (FR-042)", () => {
  const DYN_HOST = "org.crm4.dynamics.com";

  it("dynamics:read with DYNAMICS_ORG_HOST set narrows the WIF audience to the per-org host", async () => {
    const { endpoint } = recordingEndpoint();
    const { wif, calls } = recordingWif();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["dynamics:read"]),
      dynamicsOrgHost: DYN_HOST,
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-crm")), [cap("dynamics:read")]);

    expect(result.ok).toBe(true);
    // The WIF exchange's audience is the per-org Dataverse host (FR-042) — never a
    // hardcoded `dynamics.microsoft.com` placeholder.
    expect(calls.length).toBe(1);
    expect(calls[0]?.audience).toBe(`https://${DYN_HOST}`);
  });

  it("the dynamics read handle GETs the per-org Dataverse Web API URL", async () => {
    const { endpoint } = recordingEndpoint();
    const { wif } = recordingWif();
    const graphRequests: GraphRequest[] = [];
    const graphHttp: GraphHttp = {
      request: async (req) => { graphRequests.push(req); return { status: 200, json: { value: [{ id: 1 }] } }; },
    };
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      graphHttp,
      assignedScopes: () => new Set<string>(["dynamics:read"]),
      dynamicsOrgHost: DYN_HOST,
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-crm")), [cap("dynamics:read")]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const handle = mintedClient(result.value, cap("dynamics:read")) as {
      read: (q: { entity: string }) => Promise<unknown>;
    };
    await handle.read({ entity: "accounts" });
    expect(graphRequests[0]?.url).toBe(`https://${DYN_HOST}/api/data/v9.2/accounts`);
  });

  it("FR-042 fail-closed: dynamics:read with DYNAMICS_ORG_HOST UNSET is refused with ZERO egress + audited 'dynamics-org-host-unset'", async () => {
    const { endpoint, egressCount } = recordingEndpoint();
    const { wif, wifCount } = recordingWif();
    const { logger, logs } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      // Scope IS assigned, but no org host is configured (dynamicsOrgHost omitted).
      assignedScopes: () => new Set<string>(["dynamics:read"]),
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-crm")), [cap("dynamics:read")]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error.kind).toBe("policy-refusal");
    // Zero egress on BOTH hops — the unset-host refusal precedes any token request.
    expect(egressCount()).toBe(0);
    expect(wifCount()).toBe(0);
    // The refusal is audited with the SPECIFIC reason that names the missing host
    // (distinct from the assigned-scope gate's `scope-not-assigned`) — SC-009.
    const refusalRecords = logs.filter((l) => l.data?.result === "refusal");
    expect(refusalRecords.length).toBe(1);
    expect(refusalRecords[0]?.data?.reason).toBe("dynamics-org-host-unset");
    expect(refusalRecords[0]?.data?.scope).toBe("dynamics:read");
  });

  it("an UNSET host does NOT affect msgraph scopes (they never depend on it)", async () => {
    const { endpoint } = recordingEndpoint();
    const { wif, calls } = recordingWif();
    const { logger } = collectLogs();
    const broker = mkBroker({
      endpoint,
      entraWif: wif,
      assignedScopes: () => new Set<string>(["msgraph:mail.send"]),
      // dynamicsOrgHost intentionally omitted.
      tracer: passTracer,
      logger,
      now: () => 0,
    });

    const result = await broker.mintFor(invocationFor(agentOrigin("fugue-agent-mail")), [cap("msgraph:mail.send")]);
    expect(result.ok).toBe(true);
    expect(calls[0]?.audience).toBe("https://graph.microsoft.com");
  });
});
