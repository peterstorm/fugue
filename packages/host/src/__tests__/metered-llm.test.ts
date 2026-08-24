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

describe("metered-llm: diagnostic failures never replace LLM outcomes", () => {
  const throwingLogger: LogPort = {
    info() { throw Object.create(null); },
    warn() { throw Object.create(null); },
    error() { throw Object.create(null); },
  };

  it("preserves a successful call and a later budget refusal when logging throws", async () => {
    const { inner, calls } = fakeInner(10, 5);
    const metered = createMeteredLlm(inner, {
      dagId,
      runId,
      budget: 10,
      logger: throwingLogger,
    });

    const succeeded = await metered.sendStructured(structuredReq(nodeA));
    const refused = await metered.sendStructured(structuredReq(nodeA));

    expect(succeeded.ok).toBe(true);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("llm-budget-exceeded");
    expect(calls).toHaveLength(1);
  });

  it("preserves a typed provider error when its diagnostic throws", async () => {
    const expected: FrameworkError = {
      kind: "transient",
      nodeId: nodeA,
      message: "provider unavailable",
    };
    const inner: LlmClient = {
      sendStructured: async () => err(expected),
      sendWithTools: async () => err(expected),
    };
    const metered = createMeteredLlm(inner, { dagId, runId, logger: throwingLogger });

    expect(await metered.sendStructured(structuredReq(nodeA))).toEqual(err(expected));
  });

  it("rethrows the original hostile provider value when error logging throws", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const inner: LlmClient = {
      sendStructured: async () => { throw revoked.proxy; },
      sendWithTools: async () => { throw revoked.proxy; },
    };
    const metered = createMeteredLlm(inner, { dagId, runId, logger: throwingLogger });

    let caught: unknown;
    try {
      await metered.sendStructured(structuredReq(nodeA));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(revoked.proxy);
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

  it("attributes partial usage on a FAILED sendStructured too (the structured arm of settle)", async () => {
    // The settle() failure-path attribution is shared by both operations, but
    // every other test here drives it through sendWithTools. This pins the
    // sendStructured arm: an Err carrying partial usage must still be metered
    // and stamped with operation "sendStructured".
    const inner = failingWithUsage("transient", 80, 40); // 120 burned
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, logger });

    const r = await metered.sendStructured(structuredReq(nodeA));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("transient");

    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(metered_log).toBeDefined();
    expect(metered_log?.data?.operation).toBe("sendStructured");
    expect(metered_log?.data?.tokensIn).toBe(80);
    expect(metered_log?.data?.tokensOut).toBe(40);
    expect(metered_log?.data?.cumulative).toBe(120);

    // The failure line carries the same deltas and the structured operation.
    const failLog = logs.find((l) => l.msg === "llm.call-failed");
    expect(failLog?.data?.operation).toBe("sendStructured");
    expect(failLog?.data?.errorKind).toBe("transient");
    expect(failLog?.data?.tokensIn).toBe(80);
    expect(failLog?.data?.tokensOut).toBe(40);
  });

  it("a failed sendStructured's burned tokens count toward the budget (structured-arm bypass guard)", async () => {
    // Mirror of the sendWithTools no-bypass test for the structured arm: a
    // single failed structured call burns over budget, so the NEXT call is
    // refused — a crashing structured call cannot bypass the per-run budget.
    const inner = failingWithUsage("node-crash", 600, 0);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 500, logger });

    const r1 = await metered.sendStructured(structuredReq(nodeA));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe("node-crash");

    const r2 = await metered.sendStructured(structuredReq(nodeA));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.kind).toBe("llm-budget-exceeded");
      if (r2.error.kind === "llm-budget-exceeded") {
        expect(r2.error.cumulative).toBe(600);
        expect(r2.error.budget).toBe(500);
      }
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

// ── Concurrency reservation (review I1 / SC-003) ────────────────────────────

/** An inner client whose calls take a tick to settle, so a burst genuinely
 * overlaps before any call updates the meter. */
const delayedInner = (tokensIn: number, tokensOut: number, delayMs: number) => {
  const calls: NodeId[] = [];
  const inner: LlmClient = {
    sendStructured: async <O>(req: LlmRequest<O>) => {
      calls.push(req.nodeId);
      await new Promise((r) => setTimeout(r, delayMs));
      return ok({ output: {} as O, tokensIn, tokensOut, rawText: "" }) as Result<LlmResponse<O>, FrameworkError>;
    },
    sendWithTools: async <O>(req: SendWithToolsRequest<O>, _ctx: NodeContext) => {
      calls.push(req.nodeId);
      await new Promise((r) => setTimeout(r, delayMs));
      return ok({ output: {} as O, tokensIn, tokensOut, rawText: "" }) as Result<LlmResponse<O>, FrameworkError>;
    },
  };
  return { inner, calls };
};

describe("metered-llm: budget-refusal error reports SETTLED cumulative only (errors.ts contract)", () => {
  it("a sequential refusal's `cumulative` equals the settled total from the llm.metered log, and `budget` is the configured budget", async () => {
    // budget 200; each call costs 150. Call 1 settles at 150; call 2 is the
    // single overshoot settling at 300; call 3 is refused. The error's
    // `cumulative` must reconcile EXACTLY against the last `llm.metered` line.
    const { inner } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 200, logger });

    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendStructured(structuredReq(nodeA));
    const refused = await metered.sendStructured(structuredReq(nodeA));

    const settledCumulatives = logs
      .filter((l) => l.msg === "llm.metered")
      .map((l) => l.data?.cumulative);
    expect(settledCumulatives).toEqual([150, 300]);

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(refused.error.cumulative).toBe(300); // the SETTLED total — reconciles with the log
      expect(refused.error.budget).toBe(200); // the configured budget, from the refuse branch
    } else {
      throw new Error("expected llm-budget-exceeded");
    }
  });

  it("a RESERVATION-triggered refusal still reports settled-only cumulative — the in-flight reservation never leaks into the error figure", async () => {
    // budget 250, each call 100 tokens, calls take a tick to settle. Warm-up
    // settles 100 and teaches the reservation estimate. A burst of 5 then admits
    // 2 (cumulative 100 + reserved 0/100 < 250) and refuses 3 with the settled
    // cumulative still 100 — NOT 100 + the 200 reserved in flight. Reporting
    // settled + reservation here would make `cumulative` irreconcilable against
    // the `llm.metered` totals (the errors.ts contract).
    const { inner } = delayedInner(100, 0, 10);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 250, logger });

    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // settled 100

    const results = await Promise.all(
      Array.from({ length: 5 }, () => metered.sendStructured(structuredReq(nodeA))),
    );
    const refusals = results.filter((r) => !r.ok);
    expect(refusals.length).toBe(3);
    for (const r of refusals) {
      if (r.ok) continue;
      expect(r.error.kind).toBe("llm-budget-exceeded");
      if (r.error.kind === "llm-budget-exceeded") {
        // Settled at refusal time was exactly the warm-up call: 100. The 200
        // reserved by the two admitted-but-unsettled calls is excluded.
        expect(r.error.cumulative).toBe(100);
        expect(r.error.budget).toBe(250);
      }
    }
    // The reservation IS reported — but in the warn log, never the error figure.
    const warn = logs.find((l) => l.level === "warn" && l.msg.includes("budget exceeded"));
    expect(warn?.data?.cumulative).toBe(100);
    expect(warn?.data?.reservedInFlight).toBe(200);
  });
});

describe("metered-llm: concurrency reservation bounds overshoot (I1/SC-003)", () => {
  it("a parallel burst does NOT all pass a stale pre-settle cumulative — admissions are bounded by the in-flight reservation", async () => {
    // budget 250, each call 100 tokens. After one settled call the per-call
    // estimate is learned (100), so a following burst reserves it and only admits
    // until cumulative+reserved reaches budget — overshoot ≈ one call, not N.
    const { inner, calls } = delayedInner(100, 0, 10);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, budget: 250, logger });

    // Warm up: one settled call so the reservation estimate is learned.
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // cumulative 100

    // Fire 5 in parallel. Admit is synchronous and runs in order before any inner
    // call settles: cumulative 100 → admit (reserve 100, proj 100) → admit (proj
    // 200) → refuse (proj 300 ≥ 250) ×3. So 2 admitted, 3 refused.
    const results = await Promise.all(Array.from({ length: 5 }, () => metered.sendStructured(structuredReq(nodeA))));
    const admitted = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok).length;

    expect(admitted).toBe(2);
    expect(refused).toBe(3);
    // Without the reservation all 5 would have been delegated (1 warm-up + 5 = 6).
    expect(calls.length).toBe(1 + admitted);
    // Every refusal is the typed budget error.
    for (const r of results) {
      if (!r.ok) expect(r.error.kind).toBe("llm-budget-exceeded");
    }
  });
});

// ── Throwing inner client (port-contract violation) ─────────────────────────

describe("metered-llm: a THROWING inner client releases its reservation and is logged", () => {
  /** An inner client that throws (violating the settled-Result port contract). */
  const throwingInner = (): LlmClient => ({
    sendStructured: async () => {
      throw new Error("inner client exploded");
    },
    sendWithTools: async () => {
      throw new Error("inner client exploded");
    },
  });

  it("rethrows, logs llm.call-failed with errorKind 'thrown', and frees the reservation so the next call is admitted", async () => {
    // budget 30, per-call 15: warm up to learn the estimate, then a throwing
    // call reserves 15. If the finally-release were lost, the leaked
    // reservation would project 15+15 ≥ 30 and refuse every later call.
    const { inner: good } = fakeInner(10, 5);
    const { logger, logs } = collectLogs();

    const throwing = throwingInner();
    const composite: LlmClient = {
      sendStructured: (req) =>
        logs.some((l) => l.data?.errorKind === "thrown")
          ? good.sendStructured(req)
          : throwing.sendStructured(req),
      sendWithTools: (req, ctx) => good.sendWithTools(req, ctx),
    };

    const metered = createMeteredLlm(composite, { dagId, runId, budget: 30, logger });

    // Learn the estimate with a settled call (uses sendWithTools → good inner).
    expect((await metered.sendWithTools(toolsReq(nodeA), fakeCtx)).ok).toBe(true); // cumulative 15

    // The throwing call: rethrown to the caller (run-node's catch surfaces it).
    await expect(metered.sendStructured(structuredReq(nodeA))).rejects.toThrow("inner client exploded");

    // The decorator's accounting contract was not silently skipped: one
    // llm.call-failed line with errorKind "thrown" and the correlation triple.
    const thrown = logs.find((l) => l.msg === "llm.call-failed" && l.data?.errorKind === "thrown");
    expect(thrown).toBeDefined();
    expect(thrown?.data?.message).toContain("inner client exploded");
    expect(thrown?.data?.runId).toBe(runId as string);
    expect(thrown?.data?.nodeId).toBe(nodeA as string);

    // The reservation was released in the finally: cumulative 15 + reserved 0
    // projects under the 30 budget, so the next call is still admitted.
    const after = await metered.sendStructured(structuredReq(nodeA));
    expect(after.ok).toBe(true);
  });

  it("rethrows from sendWithTools too, logs errorKind 'thrown' with that operation, and frees the reservation", async () => {
    // The throw/log/finally-release path is duplicated per operation in the
    // decorator; the test above pins sendStructured. This pins the sendWithTools
    // arm: warm up via sendStructured (good inner) to learn the 15-token
    // estimate, then a throwing sendWithTools reserves 15 — if its finally were
    // lost the leaked reservation would project 15+15 ≥ 30 and refuse later.
    const { inner: good } = fakeInner(10, 5);
    const { logger, logs } = collectLogs();

    const throwing = throwingInner();
    const composite: LlmClient = {
      sendStructured: (req) => good.sendStructured(req),
      sendWithTools: (req, ctx) =>
        logs.some((l) => l.data?.errorKind === "thrown")
          ? good.sendWithTools(req, ctx)
          : throwing.sendWithTools(req, ctx),
    };

    const metered = createMeteredLlm(composite, { dagId, runId, budget: 30, logger });

    // Learn the estimate with a settled structured call.
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // cumulative 15

    // The throwing tools call: rethrown to the caller.
    await expect(metered.sendWithTools(toolsReq(nodeA), fakeCtx)).rejects.toThrow("inner client exploded");

    const thrown = logs.find((l) => l.msg === "llm.call-failed" && l.data?.errorKind === "thrown");
    expect(thrown).toBeDefined();
    expect(thrown?.data?.operation).toBe("sendWithTools");
    expect(thrown?.data?.message).toContain("inner client exploded");
    expect(thrown?.data?.runId).toBe(runId as string);
    expect(thrown?.data?.nodeId).toBe(nodeA as string);

    // Reservation released in the finally → next call still admitted.
    const after = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(after.ok).toBe(true);
  });

  it("a throw meters NOTHING — tokens for a thrown call are unknowable, so no llm.metered line and the budget is unmoved", async () => {
    // Unlike an Err (which can carry settled partial usage), a throw bypasses
    // settle() entirely — there is no Result to read usage from, so the
    // decorator must NOT accumulate. Assert no llm.metered line is emitted and
    // the run's cumulative is unchanged: a generously budgeted call after the
    // throw is still admitted AND its cumulative starts from 0, not some leaked
    // figure attributed to the throw.
    const { inner: good } = fakeInner(10, 5);
    const { logger, logs } = collectLogs();

    const throwing = throwingInner();
    const composite: LlmClient = {
      sendStructured: (req) =>
        logs.some((l) => l.data?.errorKind === "thrown")
          ? good.sendStructured(req)
          : throwing.sendStructured(req),
      sendWithTools: (req, ctx) => good.sendWithTools(req, ctx),
    };
    const metered = createMeteredLlm(composite, { dagId, runId, logger });

    await expect(metered.sendStructured(structuredReq(nodeA))).rejects.toThrow("inner client exploded");

    // The throw produced a call-failed line but NO metering line.
    expect(logs.some((l) => l.msg === "llm.call-failed" && l.data?.errorKind === "thrown")).toBe(true);
    expect(logs.some((l) => l.msg === "llm.metered")).toBe(false);

    // The next (succeeding) call's cumulative is exactly its own 15 tokens — the
    // throw contributed nothing to the meter.
    const after = await metered.sendStructured(structuredReq(nodeA));
    expect(after.ok).toBe(true);
    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(metered_log?.data?.cumulative).toBe(15);
  });
});
