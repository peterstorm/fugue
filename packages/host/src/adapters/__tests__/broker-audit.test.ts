/**
 * Tests for the correlated broker audit emitter (adapters/broker-audit.ts).
 *
 * @satisfies FR-X-004 / SC-009 — every mint and every refusal emits a record
 *   carrying sub/azp/runId/nodeId/scope; agent hops omit `sub` (no end-user
 *   subject) rather than carry an empty-string sentinel.
 */

import { describe, it, expect } from "bun:test";
import { runId as makeRunId, nodeId as makeNodeId } from "@fuguejs/framework";
import type { Tracer, RunId, NodeId } from "@fuguejs/framework";
import type { LogPort } from "../../ports.js";
import { createBrokerAudit, brokerAuditPayload, type BrokerAuditFields } from "../broker-audit.js";

const runId = makeRunId("run-001");
const nodeId = makeNodeId("node-a");

const userFields: BrokerAuditFields = {
  sub: "user-abc",
  azp: "fugue-frontend",
  runId,
  nodeId,
  scope: "msgraph:mail.send",
};

const agentFields: BrokerAuditFields = {
  azp: "fugue-agent-mail",
  runId,
  nodeId,
  scope: "msgraph:sites.read",
};

const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger: LogPort = {
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
  return { logger, logs };
};

// A tracer that records the span names it wrapped (proves trace-correlation).
const recordingTracer = () => {
  const spans: { name: string; type: string }[] = [];
  const tracer: Tracer = {
    withSpan: async (name, type, fn) => {
      spans.push({ name, type });
      return fn();
    },
  };
  return { tracer, spans };
};

describe("brokerAuditPayload — pure field set", () => {
  it("includes all five fields for a user hop (sub present)", () => {
    const payload = brokerAuditPayload(userFields, { result: "mint", via: "token-exchange-v2" });
    expect(payload).toEqual({
      sub: "user-abc",
      azp: "fugue-frontend",
      runId: runId as string,
      nodeId: nodeId as string,
      scope: "msgraph:mail.send",
      result: "mint",
      via: "token-exchange-v2",
    });
  });

  it("OMITS sub entirely for an agent hop (no empty-string sentinel)", () => {
    const payload = brokerAuditPayload(agentFields, { result: "refusal", reason: "scope-not-assigned" });
    expect("sub" in payload).toBe(false);
    expect(payload).toEqual({
      azp: "fugue-agent-mail",
      runId: runId as string,
      nodeId: nodeId as string,
      scope: "msgraph:sites.read",
      result: "refusal",
      reason: "scope-not-assigned",
    });
  });
});

describe("createBrokerAudit — emits over tracer + logger spine", () => {
  it("mint() writes one info record and one mint span", async () => {
    const { logger, logs } = collectLogs();
    const { tracer, spans } = recordingTracer();
    const audit = createBrokerAudit(tracer, logger);

    await audit.mint(userFields, "client_credentials");

    expect(logs.length).toBe(1);
    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.data?.result).toBe("mint");
    expect(logs[0]?.data?.via).toBe("client_credentials");
    expect(logs[0]?.data?.sub).toBe("user-abc");
    expect(spans).toEqual([{ name: "capability.broker.mint", type: "capability-broker" }]);
  });

  it("refusal() writes one warn record and one refusal span", async () => {
    const { logger, logs } = collectLogs();
    const { tracer, spans } = recordingTracer();
    const audit = createBrokerAudit(tracer, logger);

    await audit.refusal(agentFields, "scope-not-assigned");

    expect(logs.length).toBe(1);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.data?.result).toBe("refusal");
    expect(logs[0]?.data?.reason).toBe("scope-not-assigned");
    expect("sub" in (logs[0]?.data ?? {})).toBe(false);
    expect(spans).toEqual([{ name: "capability.broker.refusal", type: "capability-broker" }]);
  });

  // A2 — auditing never alters control flow: a throwing tracer/logger must be
  // swallowed inside the emitter so `mint`/`refusal` resolve (never reject).
  it("mint() resolves (does not reject) when the tracer throws", async () => {
    const { logger } = collectLogs();
    const throwingTracer: Tracer = {
      withSpan: async () => {
        throw new Error("tracer exploded");
      },
    };
    const audit = createBrokerAudit(throwingTracer, logger);
    // Resolving (not rejecting) is the whole contract — expect.resolves proves it.
    await expect(audit.mint(userFields, "client_credentials")).resolves.toBeUndefined();
  });

  it("refusal() resolves and falls back to the error sink when the warn logger throws", async () => {
    const errors: { msg: string; data?: Record<string, unknown> }[] = [];
    const throwingLogger: LogPort = {
      info: () => {},
      warn: () => {
        throw new Error("logger exploded");
      },
      error: (msg, data) => errors.push({ msg, data }),
    };
    const passTracer: Tracer = { withSpan: async (_n, _t, fn) => fn() };
    const audit = createBrokerAudit(passTracer, throwingLogger);

    await expect(audit.refusal(agentFields, "scope-not-assigned")).resolves.toBeUndefined();
    // The last-resort error sink captured the failure with the payload intact.
    expect(errors.length).toBe(1);
    expect(errors[0]?.data?.scope).toBe("msgraph:sites.read");
    expect(errors[0]?.data?.auditError).toContain("logger exploded");
  });
});
