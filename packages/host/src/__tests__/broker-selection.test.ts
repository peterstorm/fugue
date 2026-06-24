/**
 * Boot-time capability-broker selection (host.ts `selectCapabilityBroker`,
 * review C7.5).
 *
 * The seam review C1 lived in: config → broker selection, the
 * `AGENT_CLIENT_SCOPES` → `assignedScopes` closure, and the unwired
 * fail-closed endpoints. Pins:
 *   - `REALM_JWT_ISSUER` unset → NO broker (the zero-regression static path).
 *   - `REALM_JWT_ISSUER` set → live broker whose policy gate is driven by
 *     `AGENT_CLIENT_SCOPES`: an unassigned scope is refused (`policy-refusal`),
 *     an assigned scope reaches the unwired token endpoint and surfaces
 *     `infra-unreachable` — never a silent success, never `missing-capability`.
 *   - The half-wired-verifier and empty-policy states are warned at selection.
 */

import { describe, it, expect } from "bun:test";
import { runId as makeRunId, nodeId as makeNodeId, dagId as makeDagId } from "@fuguejs/framework";
import type { Capability, Invocation, Tracer } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import { parseHostConfig } from "../domain/config.js";
import type { HostConfig } from "../domain/config.js";
import { selectCapabilityBroker } from "../host.js";

const passTracer: Tracer = { withSpan: async (_n, _t, fn) => fn() };

const collectLogs = () => {
  const logs: { level: string; msg: string }[] = [];
  const logger: LogPort = {
    info: (msg) => logs.push({ level: "info", msg }),
    warn: (msg) => logs.push({ level: "warn", msg }),
    error: (msg) => logs.push({ level: "error", msg }),
  };
  return { logger, logs };
};

const baseEnv = {
  DAGS_REPO_URL: "https://github.com/org/dags.git",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
};

const configFrom = (env: Record<string, string>): HostConfig => {
  const parsed = parseHostConfig({ ...baseEnv, ...env });
  if (!parsed.ok) throw new Error(`test config invalid: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
};

const invocationFor = (agentClientId: string): Invocation => ({
  origin: { kind: "agent", agentClientId },
  runId: makeRunId("run-boot"),
  dagId: makeDagId("dag-boot"),
  nodeId: makeNodeId("node-a"),
});

describe("selectCapabilityBroker (boot wiring, C7.5)", () => {
  it("returns undefined when REALM_JWT_ISSUER is unset — no minting authority, the static path", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({});
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeUndefined();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("selects the live broker when REALM_JWT_ISSUER is set, with assignedScopes derived from AGENT_CLIENT_SCOPES", async () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
    });
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeDefined();
    if (!broker) return;

    // The broker claims the scope namespace for run-start validation.
    expect(broker.provides?.("msgraph:mail.send" as Capability)).toBe(true);
    expect(broker.provides?.("http" as Capability)).toBe(false);

    // The inbound USER JWT path is wired LIVE when REALM_JWT_ISSUER is set, so
    // the host must NOT emit the old (now-removed) "inbound JWT verifier is not
    // wired / user runs not acceptable" boot warning — that claim is false and
    // would mislead operators into thinking the user path is closed.
    expect(logs.some((l) => l.msg.includes("inbound JWT verifier is not wired"))).toBe(false);
    expect(logs.some((l) => l.msg.includes("user-initiated runs are not yet acceptable"))).toBe(false);

    // The ACCURATE AD-3 per-leg warning still fires: no Keycloak/Entra creds are
    // configured here, so those capability legs remain fail-closed-unwired.
    expect(
      logs.some((l) => l.level === "warn" && l.msg.includes("capability authority leg(s) not wired")),
    ).toBe(true);

    // A scope NOT in the policy fails closed at the local gate (no egress).
    const refused = await broker.mintFor(invocationFor("dag-other"), ["msgraph:mail.send" as Capability]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("policy-refusal");

    // An ASSIGNED scope passes the gate and hits the unwired token endpoint:
    // `infra-unreachable` (retriable), never a silent success and never
    // `missing-capability` — the fail-closed-unwired contract for this wave.
    const assigned = await broker.mintFor(invocationFor("dag-mail"), ["msgraph:mail.send" as Capability]);
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.error.kind).toBe("infra-unreachable");
  });

  it("warns once at selection when the scope policy is empty (all mints will fail closed)", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
    });
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeDefined();
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("empty scope policy"))).toBe(true);
  });

  it("warns once when the LIVE broker is selected without a subject-token resolver (user exchange fails closed)", () => {
    // Defense-in-depth (item 4): omitting the resolver arg leaves the inert
    // fail-safe default backing a LIVE broker — user RFC 8693 exchange then fails
    // closed. The boot warning names that cause so the misconfiguration is
    // diagnosable rather than surfacing as opaque per-run refusals.
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
    });
    // No 5th `resolveSubjectToken` arg → the inert default is used.
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeDefined();
    const subjectWarnings = logs.filter(
      (l) => l.level === "warn" && l.msg.includes("without a subject-token resolver"),
    );
    expect(subjectWarnings).toHaveLength(1);
    expect(subjectWarnings[0]?.msg).toContain("FAIL CLOSED");
  });

  it("does NOT warn about the subject-token resolver when a real resolver is wired", () => {
    // The normal createHost path passes the live registry's `resolve`. A
    // non-inert resolver must NOT trip the wiring-slip warning.
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
    });
    const broker = selectCapabilityBroker(
      config,
      { tracer: passTracer, logger },
      logger,
      Date.now,
      // A live-shaped resolver (distinct function identity from the inert default).
      () => undefined,
    );
    expect(broker).toBeDefined();
    expect(logs.some((l) => l.msg.includes("without a subject-token resolver"))).toBe(false);
  });

  it("warns when AGENT_CLIENT_SCOPES is configured while REALM_JWT_ISSUER is unset — the policy is inert", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
    });
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    // No broker is selected (static path) …
    expect(broker).toBeUndefined();
    // … but the operator configured a scope policy that nothing will enforce —
    // surfaced once at boot rather than silently ignored.
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("inert"))).toBe(true);
  });
});

// ── AD-3 config-presence gating (FR-011, T3): live-vs-stub per leg, one warning ─

const credsFor = (clientId: string, secret = "sekret-value") =>
  JSON.stringify({ "dag-mail": { clientId, clientSecret: secret } });

// A GUID-shaped tenant: createEntraWifExchange validates the tenant at
// construction and throws on a hostile value, so the live leg needs a valid one.
const VALID_TENANT = "0f8fad5b-d9cb-469f-a165-70867728950e";

const unwiredLegWarnings = (logs: { level: string; msg: string }[]) =>
  logs.filter((l) => l.level === "warn" && l.msg.includes("authority leg(s) not wired"));

describe("selectCapabilityBroker — AD-3 config-presence gating (FR-011/SC-001)", () => {
  it("SC-001: no security config → no broker, NO unwired-leg warning (byte-identical baseline)", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({});
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeUndefined();
    // The unwired-leg warning is leg-specific and must NOT fire on the no-config path.
    expect(unwiredLegWarnings(logs)).toHaveLength(0);
    // And no warnings at all on the pristine baseline.
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("BOTH legs unwired (realm issuer only) → exactly ONE unwired-leg warning naming both legs", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
    });
    selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    const warnings = unwiredLegWarnings(logs);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain("KEYCLOAK_AGENT_CLIENT_CREDENTIALS");
    expect(warnings[0]?.msg).toContain("ENTRA_TENANT_ID");
  });

  it("Keycloak wired, Entra unwired → exactly ONE warning naming only the Entra leg", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: credsFor("kc-client"),
    });
    selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    const warnings = unwiredLegWarnings(logs);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).not.toContain("KEYCLOAK_AGENT_CLIENT_CREDENTIALS");
    expect(warnings[0]?.msg).toContain("ENTRA_TENANT_ID");
    // NFR-014: the secret never leaks into a boot log.
    expect(logs.every((l) => !l.msg.includes("sekret-value"))).toBe(true);
  });

  it("BOTH legs wired → NO unwired-leg warning at all", () => {
    const { logger, logs } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: credsFor("kc-client"),
      ENTRA_TENANT_ID: VALID_TENANT,
      ENTRA_CLIENT_ID: "fugue-agents",
    });
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeDefined();
    expect(unwiredLegWarnings(logs)).toHaveLength(0);
  });

  it("FR-012: an un-granted scope is refused at the local gate with zero egress even when both legs are LIVE", async () => {
    const { logger } = collectLogs();
    const config = configFrom({
      REALM_JWT_ISSUER: "https://kc.example.com/realms/fugue-platform",
      AGENT_CLIENT_SCOPES: JSON.stringify({ "dag-mail": ["msgraph:mail.send"] }),
      KEYCLOAK_AGENT_CLIENT_CREDENTIALS: credsFor("kc-client"),
      ENTRA_TENANT_ID: VALID_TENANT,
      ENTRA_CLIENT_ID: "fugue-agents",
    });
    const broker = selectCapabilityBroker(config, { tracer: passTracer, logger }, logger);
    expect(broker).toBeDefined();
    if (!broker) return;
    // dag-other has no assigned scopes → refused BEFORE any egress. No live HTTP
    // is performed because the policy gate precedes the endpoint (the live legs
    // wrap the global fetch, which would throw/hang in this network-free test —
    // a policy-refusal proves the gate ran first).
    const refused = await broker.mintFor(invocationFor("dag-other"), ["msgraph:mail.send" as Capability]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("policy-refusal");
  });
});
