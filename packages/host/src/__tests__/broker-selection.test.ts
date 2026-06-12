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

    // Half-wired state (broker on, inbound verifier unwired) is warned at boot.
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("inbound JWT verifier is not wired"))).toBe(true);

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
});
