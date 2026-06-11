/**
 * Tests for the metered-llm decorator (adapters/metered-llm.ts).
 *
 * Covers: attribution stamp present on every call, no-budget passthrough,
 * token aggregation across calls, pre-call refusal once cumulative >= budget,
 * the overshoot-by-one rule (SC-003), structured metering log lines, and the
 * "no network round trip" guarantee (the decorator never calls inner on refusal).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  ok,
  err,
  dagId as makeDagId,
  runId as makeRunId,
  nodeId as makeNodeId,
} from "@fuguejs/framework";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  SendWithToolsRequest,
  NodeContext,
  Result,
  FrameworkError,
  NodeId,
} from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import { createMeteredLlm } from "../adapters/metered-llm.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const dagId = makeDagId("test-dag");
const runId = makeRunId("run-001");
const nodeA = makeNodeId("node-a");

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
 * Fake inner LlmClient: records every request it receives and returns a
 * configurable per-call token count. `calls` lets a test assert the decorator
 * delegated (and how many times — zero on refusal proves no network round trip).
 */
const fakeInner = (tokensIn: number, tokensOut: number) => {
  const calls: { op: string; nodeId: NodeId }[] = [];
  const respond = <O>(req: { nodeId: NodeId }, output: O): Result<LlmResponse<O>, FrameworkError> =>
    ok({ output, tokensIn, tokensOut, rawText: "" });
  const inner: LlmClient = {
    sendStructured: async <O>(req: LlmRequest<O>) => {
      calls.push({ op: "sendStructured", nodeId: req.nodeId });
      return respond(req, {} as O);
    },
    sendWithTools: async <O>(req: SendWithToolsRequest<O>, _ctx: NodeContext) => {
      calls.push({ op: "sendWithTools", nodeId: req.nodeId });
      return respond(req, {} as O);
    },
  };
  return { inner, calls };
};

const structuredReq = (nodeId: NodeId): LlmRequest<unknown> => ({
  system: "s",
  user: "u",
  model: "m",
  schema: z.unknown(),
  nodeId,
});

const toolsReq = (nodeId: NodeId): SendWithToolsRequest<unknown> => ({
  system: "s",
  user: "u",
  model: "m",
  tools: [],
  schema: z.unknown(),
  nodeId,
});

const fakeCtx = {} as NodeContext;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("metered-llm: no budget (FR-W1-006 passthrough)", () => {
  it("delegates and never refuses when budget is undefined", async () => {
    const { inner, calls } = fakeInner(1_000_000, 0);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, logger });

    for (let i = 0; i < 5; i++) {
      const res = await metered.sendStructured(structuredReq(nodeA));
      expect(res.ok).toBe(true);
    }
    expect(calls.length).toBe(5); // all delegated, none refused
  });
});

describe("metered-llm: attribution stamp (FR-W0-001 / SC-001)", () => {
  it("emits a structured metering log with (dagId, runId, nodeId) on every successful call", async () => {
    const { inner } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, logger });

    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendWithTools(toolsReq(nodeA), fakeCtx);

    const metered_logs = logs.filter((l) => l.msg === "llm.metered");
    expect(metered_logs.length).toBe(2);
    for (const log of metered_logs) {
      expect(log.data?.dagId).toBe(dagId as string);
      expect(log.data?.runId).toBe(runId as string);
      expect(log.data?.nodeId).toBe(nodeA as string);
      expect(log.data?.tokensIn).toBe(100);
      expect(log.data?.tokensOut).toBe(50);
    }
    expect(metered_logs[0]!.data?.operation).toBe("sendStructured");
    expect(metered_logs[1]!.data?.operation).toBe("sendWithTools");
  });

  it("aggregates cumulative tokens across calls (FR-W0-004)", async () => {
    const { inner } = fakeInner(100, 50); // 150/call
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, logger });

    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendStructured(structuredReq(nodeA));

    const cumulatives = logs.filter((l) => l.msg === "llm.metered").map((l) => l.data?.cumulative);
    expect(cumulatives).toEqual([150, 300]);
  });
});

describe("metered-llm: pre-call refusal (FR-W1-002 / FR-W1-003)", () => {
  it("refuses with llm-budget-exceeded once cumulative >= budget, without calling inner", async () => {
    // budget 200; each call costs 150. Call 1 → cumulative 0 < 200 allow → 150.
    // Call 2 → cumulative 150 < 200 allow → 300 (the single overshoot).
    // Call 3 → cumulative 300 >= 200 refuse.
    const { inner, calls } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 200, logger });

    const r1 = await metered.sendStructured(structuredReq(nodeA));
    const r2 = await metered.sendStructured(structuredReq(nodeA));
    const r3 = await metered.sendStructured(structuredReq(nodeA));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); // the accepted overshoot
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.kind).toBe("llm-budget-exceeded");
      if (r3.error.kind === "llm-budget-exceeded") {
        expect(r3.error.runId).toBe(runId);
        expect(r3.error.nodeId).toBe(nodeA);
        expect(r3.error.cumulative).toBe(300);
        expect(r3.error.budget).toBe(200);
      }
    }

    // SC-004 / FR-W1-005: the refused call NEVER reached the inner client (no round trip).
    expect(calls.length).toBe(2);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("budget exceeded"))).toBe(true);
  });

  it("overshoots by at most one (SC-003): allows the boundary call, refuses the next", async () => {
    const { inner, calls } = fakeInner(1000, 0); // one call exceeds any small budget
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 500, logger });

    const r1 = await metered.sendStructured(structuredReq(nodeA)); // 0 < 500 → allow, → 1000
    const r2 = await metered.sendStructured(structuredReq(nodeA)); // 1000 >= 500 → refuse

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(calls.length).toBe(1); // exactly one call past budget
  });

  it("does not accumulate tokens for a failed inner call carrying no usage", async () => {
    const failing: LlmClient = {
      sendStructured: async (req) =>
        err({ kind: "transient", nodeId: req.nodeId, message: "boom" }) as Result<
          LlmResponse<unknown>,
          FrameworkError
        >,
      sendWithTools: async (req) =>
        err({ kind: "transient", nodeId: req.nodeId, message: "boom" }) as Result<
          LlmResponse<unknown>,
          FrameworkError
        >,
    };
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(failing, { dagId, runId, budget: 100, logger });

    const r1 = await metered.sendStructured(structuredReq(nodeA));
    expect(r1.ok).toBe(false);
    // No metering log emitted for a failure with no usage → no tokens accumulated.
    expect(logs.some((l) => l.msg === "llm.metered")).toBe(false);
    // But the failure IS logged (CRITICAL-2: no longer silent).
    const failLog = logs.find((l) => l.msg === "llm.call-failed");
    expect(failLog).toBeDefined();
    expect(failLog?.level).toBe("warn");
    expect(failLog?.data?.errorKind).toBe("transient");
    expect(failLog?.data?.operation).toBe("sendStructured");

    // Budget remains intact: the next call is still allowed (cumulative still 0).
    const r2 = await metered.sendStructured(structuredReq(nodeA));
    expect(r2.ok).toBe(false); // still the inner error, NOT a budget refusal
    if (!r2.ok) expect(r2.error.kind).toBe("transient");
  });

  it("does not accumulate tokens for a failed sendWithTools carrying no usage (duplicate guard)", async () => {
    const failing: LlmClient = {
      sendStructured: async (req) =>
        err({ kind: "transient", nodeId: req.nodeId, message: "boom" }) as Result<
          LlmResponse<unknown>,
          FrameworkError
        >,
      sendWithTools: async (req) =>
        err({ kind: "transient", nodeId: req.nodeId, message: "boom" }) as Result<
          LlmResponse<unknown>,
          FrameworkError
        >,
    };
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(failing, { dagId, runId, budget: 100, logger });

    const r1 = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(r1.ok).toBe(false);
    expect(logs.some((l) => l.msg === "llm.metered")).toBe(false);
    expect(logs.some((l) => l.msg === "llm.call-failed" && l.data?.operation === "sendWithTools")).toBe(true);

    // Budget intact — next call still allowed (cumulative still 0), not refused.
    const r2 = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe("transient");
  });
});

describe("metered-llm: failed calls still burn budget (CRITICAL-1 / FR-W0-001)", () => {
  // A failing inner client whose error carries partial usage — emulates a
  // multi-turn `sendWithTools` loop that consumed real tokens across turns
  // before crashing (iteration-limit / parse failure / deadline).
  const failingWithUsage = (
    kind: "node-crash" | "transient" | "aborted",
    tokensIn: number,
    tokensOut: number,
  ): LlmClient => {
    const makeErr = (nodeId: NodeId): FrameworkError =>
      kind === "aborted"
        ? { kind: "aborted", reason: "signal", usage: { tokensIn, tokensOut } }
        : kind === "transient"
          ? { kind: "transient", nodeId, message: "deadline", usage: { tokensIn, tokensOut } }
          : {
              kind: "node-crash",
              nodeId,
              message: "iteration limit",
              retriability: "non-retriable",
              usage: { tokensIn, tokensOut },
            };
    return {
      sendStructured: async (req) =>
        err(makeErr(req.nodeId)) as Result<LlmResponse<unknown>, FrameworkError>,
      sendWithTools: async (req) =>
        err(makeErr(req.nodeId)) as Result<LlmResponse<unknown>, FrameworkError>,
    };
  };

  it("accumulates the consumed tokens of a FAILED multi-turn sendWithTools into the meter", async () => {
    const inner = failingWithUsage("node-crash", 400, 200); // 600 burned
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, logger });

    const r = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(r.ok).toBe(false);

    // The burned tokens were metered on the failure path.
    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(metered_log).toBeDefined();
    expect(metered_log?.data?.tokensIn).toBe(400);
    expect(metered_log?.data?.tokensOut).toBe(200);
    expect(metered_log?.data?.cumulative).toBe(600);
    expect(metered_log?.data?.operation).toBe("sendWithTools");

    // And the failure is logged with the deltas present (CRITICAL-2).
    const failLog = logs.find((l) => l.msg === "llm.call-failed");
    expect(failLog?.data?.errorKind).toBe("node-crash");
    expect(failLog?.data?.tokensIn).toBe(400);
    expect(failLog?.data?.tokensOut).toBe(200);
  });

  it("a failed call's burned tokens count toward the budget (no bypass on rerun)", async () => {
    // budget 500; a single failed loop burns 600 → cumulative 600 >= 500.
    const inner = failingWithUsage("node-crash", 600, 0);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 500, logger });

    // First (failing) call is allowed: cumulative 0 < 500. It burns 600.
    const r1 = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe("node-crash");

    // The NEXT call is now refused: the failed call's tokens counted toward the
    // budget, so the budget can no longer be bypassed by a crashing loop.
    const r2 = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.kind).toBe("llm-budget-exceeded");
      if (r2.error.kind === "llm-budget-exceeded") {
        expect(r2.error.cumulative).toBe(600);
        expect(r2.error.budget).toBe(500);
      }
    }
  });

  it("attributes partial usage on transient and aborted failures too", async () => {
    for (const kind of ["transient", "aborted"] as const) {
      const inner = failingWithUsage(kind, 50, 25);
      const { logger, logs } = collectLogs();
      const metered = createMeteredLlm(inner, { dagId, runId, logger });
      const r = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
      expect(r.ok).toBe(false);
      const metered_log = logs.find((l) => l.msg === "llm.metered");
      expect(metered_log?.data?.cumulative).toBe(75);
    }
  });
});

describe("metered-llm: metering log budget field (advisory)", () => {
  it("carries `budget` when set and omits it when unset", async () => {
    const { inner } = fakeInner(10, 5);

    const withBudget = collectLogs();
    const m1 = createMeteredLlm(inner, { dagId, runId, budget: 1000, logger: withBudget.logger });
    await m1.sendStructured(structuredReq(nodeA));
    const l1 = withBudget.logs.find((l) => l.msg === "llm.metered");
    expect(l1?.data).toHaveProperty("budget", 1000);

    const noBudget = collectLogs();
    const m2 = createMeteredLlm(inner, { dagId, runId, logger: noBudget.logger });
    await m2.sendStructured(structuredReq(nodeA));
    const l2 = noBudget.logs.find((l) => l.msg === "llm.metered");
    expect(l2?.data).not.toHaveProperty("budget");
  });
});
