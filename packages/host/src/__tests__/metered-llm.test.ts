/**
 * Tests for the metered-llm decorator (adapters/metered-llm.ts).
 *
 * Covers: attribution stamp present on every call, no-budget passthrough,
 * spend aggregation across calls, pre-call refusal once a ceiling is reached,
 * the overshoot-by-one rule (SC-003), cost-denominated ceilings, structured
 * metering log lines, and the "no network round trip" guarantee (the decorator
 * never calls inner on refusal).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  ok,
  err,
  dagId as makeDagId,
  runId as makeRunId,
  nodeId as makeNodeId,
  tokensOnly,
  ceilings,
  observedOf,
  NO_SPEND,
  pricedCall,
  usdToMicros,
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
  Ceiling,
  Ceilings,
  SingleShotCachePolicy,
} from "@fuguejs/framework";
import type { LogPort } from "../ports.js";
import { createMeteredLlm } from "../adapters/metered-llm.js";
import { createInMemorySpendLedger } from "../adapters/spend-ledger-memory.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const dagId = makeDagId("test-dag");
const runId = makeRunId("run-001");
const nodeA = makeNodeId("node-a");

/**
 * A token-only budget, in the shape the decorator now takes.
 *
 * Every case below predates cost-denominated ceilings and asserts token
 * arithmetic, so they all declare a `tokens` ceiling — the axis whose behaviour
 * they were written to pin. The dollar and call axes get their own coverage
 * against the pure meter (`llm-meter.test.ts`).
 */
const tokenBudget = (limit: number): Ceilings => {
  const c = ceilings([{ kind: "tokens", limit } as Ceiling]);
  if (c === undefined) throw new Error("expected non-empty ceilings");
  return c;
};

/** The cumulative token figure from an `llm.metered` log line. */
const cumulativeTokens = (data?: Record<string, unknown>): number | undefined =>
  (data?.["cumulative"] as { tokens?: number } | undefined)?.tokens;

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
    ok({ output, ...tokensOnly(tokensIn, tokensOut), rawText: "" });
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

/**
 * The ledger deps every case here needs and none of them is about.
 *
 * `ledger` and `hydrated` became required when spend went durable, and threading
 * them through ~35 pre-existing cases by hand left the same two lines repeated
 * verbatim in each. A fresh ledger per call is deliberate — sharing one instance
 * would let spend leak between tests — and a fresh run is KNOWN to have spent
 * nothing, which is a different claim from "we could not read it".
 */
const freshLedger = () => ({
  ledger: createInMemorySpendLedger(),
  hydrated: { kind: "known" as const, spend: NO_SPEND },
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("metered-llm: no budget (FR-W1-006 passthrough)", () => {
  it("delegates and never refuses when budget is undefined", async () => {
    const { inner, calls } = fakeInner(1_000_000, 0);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });

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
      ...freshLedger(),
      limits: tokenBudget(10),
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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger: throwingLogger });

    expect(await metered.sendStructured(structuredReq(nodeA))).toEqual(err(expected));
  });

  it("rethrows the original hostile provider value when error logging throws", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const inner: LlmClient = {
      sendStructured: async () => { throw revoked.proxy; },
      sendWithTools: async () => { throw revoked.proxy; },
    };
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger: throwingLogger });

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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });

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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });

    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendStructured(structuredReq(nodeA));

    const cumulatives = logs.filter((l) => l.msg === "llm.metered").map((l) => cumulativeTokens(l.data));
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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(200), logger });

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
        expect(observedOf(r3.error.cause)).toBe(300);
        expect(r3.error.cause.ceiling.limit).toBe(200);
      }
    }

    // SC-004 / FR-W1-005: the refused call NEVER reached the inner client (no round trip).
    expect(calls.length).toBe(2);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("budget exceeded"))).toBe(true);
  });

  it("overshoots by at most one (SC-003): allows the boundary call, refuses the next", async () => {
    const { inner, calls } = fakeInner(1000, 0); // one call exceeds any small budget
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(500), logger });

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
    const metered = createMeteredLlm(failing, { dagId, runId, ...freshLedger(), limits: tokenBudget(100), logger });

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
    const metered = createMeteredLlm(failing, { dagId, runId, ...freshLedger(), limits: tokenBudget(100), logger });

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
        ? { kind: "aborted", reason: "signal", usage: tokensOnly(tokensIn, tokensOut) }
        : kind === "transient"
          ? {
              kind: "transient",
              nodeId,
              message: "deadline",
              usage: tokensOnly(tokensIn, tokensOut),
            }
          : {
              kind: "node-crash",
              nodeId,
              message: "iteration limit",
              retriability: "non-retriable",
              usage: tokensOnly(tokensIn, tokensOut),
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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });

    const r = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
    expect(r.ok).toBe(false);

    // The burned tokens were metered on the failure path.
    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(metered_log).toBeDefined();
    expect(metered_log?.data?.tokensIn).toBe(400);
    expect(metered_log?.data?.tokensOut).toBe(200);
    expect(cumulativeTokens(metered_log?.data)).toBe(600);
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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(500), logger });

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
        expect(observedOf(r2.error.cause)).toBe(600);
        expect(r2.error.cause.ceiling.limit).toBe(500);
      }
    }
  });

  it("attributes partial usage on transient and aborted failures too", async () => {
    for (const kind of ["transient", "aborted"] as const) {
      const inner = failingWithUsage(kind, 50, 25);
      const { logger, logs } = collectLogs();
      const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });
      const r = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);
      expect(r.ok).toBe(false);
      const metered_log = logs.find((l) => l.msg === "llm.metered");
      expect(cumulativeTokens(metered_log?.data)).toBe(75);
    }
  });

  it("attributes partial usage on a FAILED sendStructured too (the structured arm of settle)", async () => {
    // The settle() failure-path attribution is shared by both operations, but
    // every other test here drives it through sendWithTools. This pins the
    // sendStructured arm: an Err carrying partial usage must still be metered
    // and stamped with operation "sendStructured".
    const inner = failingWithUsage("transient", 80, 40); // 120 burned
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });

    const r = await metered.sendStructured(structuredReq(nodeA));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("transient");

    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(metered_log).toBeDefined();
    expect(metered_log?.data?.operation).toBe("sendStructured");
    expect(metered_log?.data?.tokensIn).toBe(80);
    expect(metered_log?.data?.tokensOut).toBe(40);
    expect(cumulativeTokens(metered_log?.data)).toBe(120);

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
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(500), logger });

    const r1 = await metered.sendStructured(structuredReq(nodeA));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe("node-crash");

    const r2 = await metered.sendStructured(structuredReq(nodeA));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.kind).toBe("llm-budget-exceeded");
      if (r2.error.kind === "llm-budget-exceeded") {
        expect(observedOf(r2.error.cause)).toBe(600);
        expect(r2.error.cause.ceiling.limit).toBe(500);
      }
    }
  });
});

describe("metered-llm: metering log limits field (advisory)", () => {
  it("carries the declared ceilings when set and omits the field when unset", async () => {
    const { inner } = fakeInner(10, 5);

    const withBudget = collectLogs();
    const m1 = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(1000), logger: withBudget.logger });
    await m1.sendStructured(structuredReq(nodeA));
    const l1 = withBudget.logs.find((l) => l.msg === "llm.metered");
    expect(l1?.data).toHaveProperty("limits", ["tokens:1000"]);

    const noBudget = collectLogs();
    const m2 = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger: noBudget.logger });
    await m2.sendStructured(structuredReq(nodeA));
    const l2 = noBudget.logs.find((l) => l.msg === "llm.metered");
    // Absent, not `undefined`: an operator filtering on the field must be able
    // to tell "no budget declared" from "budget declared as nothing".
    expect(l2?.data).not.toHaveProperty("limits");
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

describe("metered-llm: the refusal names its ceiling and its basis (errors.ts contract)", () => {
  it("a sequential refusal reports `basis: settled` and a figure that reconciles against the llm.metered log", async () => {
    // Budget 200; each call costs 150. Call 1 settles at 150; call 2 is the
    // single overshoot settling at 300; call 3 is refused. A `settled` refusal
    // must reconcile EXACTLY against the last `llm.metered` line — that is what
    // makes the figure usable for reconciliation at all.
    const { inner } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(200), logger });

    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendStructured(structuredReq(nodeA));
    const refused = await metered.sendStructured(structuredReq(nodeA));

    const settledCumulatives = logs
      .filter((l) => l.msg === "llm.metered")
      .map((l) => cumulativeTokens(l.data));
    expect(settledCumulatives).toEqual([150, 300]);

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "llm-budget-exceeded") {
      expect(refused.error.cause.basis).toBe("settled");
      expect(observedOf(refused.error.cause)).toBe(300); // reconciles with the log
      expect(refused.error.cause.ceiling).toEqual({ kind: "tokens", limit: 200 });
    } else {
      throw new Error("expected llm-budget-exceeded");
    }
  });

  it("a RESERVATION-triggered refusal says so — `basis: projected`, with the settled figure in the log", async () => {
    // The contract this replaces reported a SETTLED figure on an error the
    // PROJECTION had caused, reconciled only by a comment: an operator seeing
    // `cumulative 100 >= budget 250` had no way to tell why it refused, because
    // on its face it had not. The error now states its basis, so the figure and
    // the reason agree by construction.
    //
    // Budget 250, each call 100 tokens, calls take a tick to settle. The warm-up
    // settles 100 and teaches the per-call estimate. A burst of 5 then admits 2
    // and refuses 3: settled 100 + 2 in flight x 100 projects to 300 >= 250.
    const { inner } = delayedInner(100, 0, 10);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(250), logger });

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
        expect(r.error.cause.basis).toBe("projected");
        expect(observedOf(r.error.cause)).toBe(300);
        expect(r.error.cause.ceiling.limit).toBe(250);
      }
    }
    // The SETTLED figure — the one that reconciles against the `llm.metered`
    // totals — is in the warn log alongside the in-flight count that explains
    // the gap between it and the projection.
    const warn = logs.find((l) => l.level === "warn" && l.msg.includes("budget exceeded"));
    expect((warn?.data?.["settled"] as { tokens?: number } | undefined)?.tokens).toBe(100);
    expect(warn?.data?.["inFlight"]).toBe(2);
    expect(warn?.data?.["basis"]).toBe("projected");
  });
});

describe("metered-llm: concurrency reservation bounds overshoot (I1/SC-003)", () => {
  it("a parallel burst does NOT all pass a stale pre-settle cumulative — admissions are bounded by the in-flight reservation", async () => {
    // budget 250, each call 100 tokens. After one settled call the per-call
    // estimate is learned (100), so a following burst reserves it and only admits
    // until cumulative+reserved reaches budget — overshoot ≈ one call, not N.
    const { inner, calls } = delayedInner(100, 0, 10);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(250), logger });

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

    const metered = createMeteredLlm(composite, { dagId, runId, ...freshLedger(), limits: tokenBudget(30), logger });

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

    const metered = createMeteredLlm(composite, { dagId, runId, ...freshLedger(), limits: tokenBudget(30), logger });

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
    const metered = createMeteredLlm(composite, { dagId, runId, ...freshLedger(), logger });

    await expect(metered.sendStructured(structuredReq(nodeA))).rejects.toThrow("inner client exploded");

    // The throw produced a call-failed line but NO metering line.
    expect(logs.some((l) => l.msg === "llm.call-failed" && l.data?.errorKind === "thrown")).toBe(true);
    expect(logs.some((l) => l.msg === "llm.metered")).toBe(false);

    // The next (succeeding) call's cumulative is exactly its own 15 tokens — the
    // throw contributed nothing to the meter.
    const after = await metered.sendStructured(structuredReq(nodeA));
    expect(after.ok).toBe(true);
    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(cumulativeTokens(metered_log?.data)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Prompt-cache split on the structured log lines
//
// The cache figures are why two runs with identical token totals can differ by
// an order of magnitude in spend, so an operator reading `llm.metered` needs
// them. They are also the fields most likely to be silently dropped: they were
// added to two separate log calls, and nothing else asserts either one.
// ---------------------------------------------------------------------------

/** An inner client whose successful response carries a provider cache split. */
const cachingInner = (usage: {
  tokensIn: number;
  tokensOut: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}): LlmClient => ({
  sendStructured: async <O>() =>
    ok({ output: {} as O, ...usage, rawText: "" }) as Result<LlmResponse<O>, FrameworkError>,
  sendWithTools: async <O>() =>
    ok({ output: {} as O, ...usage, rawText: "" }) as Result<LlmResponse<O>, FrameworkError>,
});

describe("metered-llm: prompt-cache split on log lines", () => {
  const cachedUsage = {
    tokensIn: 1000,
    tokensOut: 50,
    cacheWriteTokens: 200,
    cacheReadTokens: 700,
  };

  it("carries the cache split on the llm.metered success line", async () => {
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(cachingInner(cachedUsage), { dagId, runId, ...freshLedger(), logger });

    await metered.sendStructured(structuredReq(nodeA));

    const log = logs.find((l) => l.msg === "llm.metered");
    expect(log).toBeDefined();
    expect(log?.data?.cacheWriteTokens).toBe(200);
    expect(log?.data?.cacheReadTokens).toBe(700);
    // `tokensIn` stays the INCLUSIVE prompt total, so the cumulative a budget
    // reads is unchanged by the split.
    expect(log?.data?.tokensIn).toBe(1000);
    expect(cumulativeTokens(log?.data)).toBe(1050);
  });

  it("reports zeroes rather than omitting the fields for an uncached call", async () => {
    const { inner } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), logger });

    await metered.sendStructured(structuredReq(nodeA));

    const log = logs.find((l) => l.msg === "llm.metered");
    expect(log?.data?.cacheWriteTokens).toBe(0);
    expect(log?.data?.cacheReadTokens).toBe(0);
  });

  it("carries the cache split on the llm.call-failed partial-usage line", async () => {
    const failing: LlmClient = {
      sendStructured: async (req) =>
        err({
          kind: "node-crash",
          nodeId: req.nodeId,
          message: "iteration limit",
          retriability: "non-retriable",
          usage: cachedUsage,
        }) as Result<LlmResponse<unknown>, FrameworkError>,
      sendWithTools: async (req) =>
        err({
          kind: "node-crash",
          nodeId: req.nodeId,
          message: "iteration limit",
          retriability: "non-retriable",
          usage: cachedUsage,
        }) as Result<LlmResponse<unknown>, FrameworkError>,
    };
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(failing, { dagId, runId, ...freshLedger(), logger });

    await metered.sendStructured(structuredReq(nodeA));

    const failed = logs.find((l) => l.msg === "llm.call-failed");
    expect(failed).toBeDefined();
    expect(failed?.data?.cacheWriteTokens).toBe(200);
    expect(failed?.data?.cacheReadTokens).toBe(700);
    // And the failed call's cached tokens were still metered against the run.
    const metered_log = logs.find((l) => l.msg === "llm.metered");
    expect(metered_log?.data?.cacheReadTokens).toBe(700);
  });
});

// ── Cost-denominated ceilings (F3) ──────────────────────────────────────────

/** A priced model, so the decorator can compute a real dollar figure. */
const PRICED_MODEL = "gpt-4o"; // 2.5 in / 10.0 out per 1M

const pricedReq = (nodeId: NodeId, cache?: SingleShotCachePolicy): LlmRequest<unknown> => ({
  system: "s",
  user: "u",
  model: PRICED_MODEL,
  schema: z.unknown(),
  nodeId,
  ...(cache !== undefined ? { cache } : {}),
});

const usdBudget = (dollars: number): Ceilings => {
  const c = ceilings([{ kind: "usd", limit: usdToMicros(dollars) } as Ceiling]);
  if (c === undefined) throw new Error("expected non-empty ceilings");
  return c;
};

describe("metered-llm: a dollar ceiling sees what a token ceiling cannot (F3/P1)", () => {
  // 400k prompt tokens per call on gpt-4o = $1.00 uncached.
  const UNCACHED = { tokensIn: 400_000, tokensOut: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  // The same 400k tokens, served from cache at 0.1x = $0.10.
  const CACHED = { tokensIn: 400_000, tokensOut: 0, cacheWriteTokens: 0, cacheReadTokens: 400_000 };

  it("refuses an expensive run and admits a cached one at IDENTICAL token counts", async () => {
    // This is the whole reason the budget is denominated in money. Both clients
    // report the same `tokensIn`, so a token ceiling treats them identically —
    // and one costs ten times the other.
    const budget = usdBudget(1.5);

    const cold = createMeteredLlm(cachingInner(UNCACHED), {
      dagId, runId, ...freshLedger(), limits: budget, logger: collectLogs().logger,
    });
    expect((await cold.sendStructured(pricedReq(nodeA))).ok).toBe(true); // → $1.00 settled
    expect((await cold.sendStructured(pricedReq(nodeA))).ok).toBe(true); // → $2.00, the overshoot
    expect((await cold.sendStructured(pricedReq(nodeA))).ok).toBe(false); // $2.00 >= $1.50

    const warm = createMeteredLlm(cachingInner(CACHED), {
      dagId, runId, ...freshLedger(), limits: budget, logger: collectLogs().logger,
    });
    // Ten cached calls cost $1.00 in total and stay under the same ceiling that
    // the uncached client reached in two.
    for (let i = 0; i < 10; i += 1) {
      expect((await warm.sendStructured(pricedReq(nodeA))).ok).toBe(true);
    }
  });

  it("names the usd ceiling and the dollar figures on the refusal", async () => {
    const { logger } = collectLogs();
    const metered = createMeteredLlm(cachingInner(UNCACHED), {
      dagId, runId, ...freshLedger(), limits: usdBudget(0.5), logger,
    });

    expect((await metered.sendStructured(pricedReq(nodeA))).ok).toBe(true); // $1.00, the overshoot
    const refused = await metered.sendStructured(pricedReq(nodeA));

    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== "llm-budget-exceeded") throw new Error("expected refusal");
    expect(refused.error.cause.ceiling.kind).toBe("usd");
    expect(refused.error.cause.ceiling.limit).toBe(usdToMicros(0.5));
    expect(observedOf(refused.error.cause)).toBe(usdToMicros(1));
  });

  it("charges the 1h write premium when the request declared it", async () => {
    // The TTL is read off the request the node actually sent, not assumed: a 1h
    // entry costs 2.0x where a 5m one costs 1.25x, and at a dollar ceiling that
    // difference decides whether the next call runs.
    const writeUsage = { tokensIn: 400_000, tokensOut: 0, cacheWriteTokens: 400_000, cacheReadTokens: 0 };
    const priceOf = async (cache: SingleShotCachePolicy): Promise<number> => {
      const { logger, logs } = collectLogs();
      const metered = createMeteredLlm(cachingInner(writeUsage), { dagId, runId, ...freshLedger(), logger });
      await metered.sendStructured(pricedReq(nodeA, cache));
      const log = logs.find((l) => l.msg === "llm.metered");
      return (log?.data?.["call"] as { usdMicros?: number } | undefined)?.usdMicros ?? 0;
    };

    const short = await priceOf({ kind: "static-prefix", ttl: "5m" });
    const long = await priceOf({ kind: "static-prefix", ttl: "1h" });
    expect(long).toBeGreaterThan(short);
    expect(long / short).toBeCloseTo(2.0 / 1.25, 5);
  });
});

describe("metered-llm: an unpriced model fails closed under a dollar ceiling (FR-B-004)", () => {
  it("refuses on the FIRST call and names the model to price", async () => {
    // Cost cannot be evaluated, so it cannot be shown to be under the limit.
    // Treating it as zero would make "use a model nobody priced" the cheapest
    // possible way past a dollar budget.
    const { inner, calls } = fakeInner(10, 5); // model "m" — no price-table entry
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: usdBudget(100), logger });

    // The first call still runs: nothing has settled, so there is no unpriced
    // spend yet. It is the SECOND that cannot be evaluated.
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true);
    const refused = await metered.sendStructured(structuredReq(nodeA));

    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== "llm-budget-exceeded") throw new Error("expected refusal");
    expect(refused.error.cause.kind).toBe("unpriced");
    if (refused.error.cause.kind !== "unpriced") return;
    expect([...refused.error.cause.models]).toEqual(["m"]);
    expect(calls.length).toBe(1); // the refused call never reached the inner client

    const warn = logs.find((l) => l.level === "warn" && l.msg.includes("budget exceeded"));
    expect(warn?.data?.["reason"]).toContain("no price-table entry");
  });

  it("runs an unpriced model normally under token-only ceilings (FR-B-005)", async () => {
    // Fail-closed applies where something is unknown. A token ceiling is
    // perfectly evaluable on an unpriced model.
    const { inner } = fakeInner(10, 5);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(10_000), logger });
    for (let i = 0; i < 5; i += 1) {
      expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true);
    }
  });
});

describe("metered-llm: both operations share one accounting path", () => {
  it("draws sendStructured and sendWithTools on the same run budget", async () => {
    // The two used to be separate copies of the admit/settle/release sequence.
    // A budget one operation can bypass is not a budget, so the shared meter is
    // asserted through BOTH entry points rather than either alone.
    const { inner, calls } = fakeInner(100, 0);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, { dagId, runId, ...freshLedger(), limits: tokenBudget(250), logger });

    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // 100
    expect((await metered.sendWithTools(toolsReq(nodeA), fakeCtx)).ok).toBe(true); // 200
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // 300, the overshoot
    const refused = await metered.sendWithTools(toolsReq(nodeA), fakeCtx);

    expect(refused.ok).toBe(false);
    expect(calls.length).toBe(3);
    // Both operations appear on the metering lines under one cumulative.
    const ops = logs.filter((l) => l.msg === "llm.metered").map((l) => l.data?.["operation"]);
    expect(ops).toEqual(["sendStructured", "sendWithTools", "sendStructured"]);
    expect(logs.filter((l) => l.msg === "llm.metered").map((l) => cumulativeTokens(l.data))).toEqual([
      100, 200, 300,
    ]);
  });

  it("carries the call price and the running cost on every metering line", async () => {
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(
      cachingInner({ tokensIn: 400_000, tokensOut: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }),
      { dagId, runId, ...freshLedger(), logger },
    );

    await metered.sendStructured(pricedReq(nodeA));
    await metered.sendStructured(pricedReq(nodeA));

    const lines = logs.filter((l) => l.msg === "llm.metered");
    const costs = lines.map((l) => (l.data?.["cumulative"] as { usdMicros?: number }).usdMicros);
    expect(costs).toEqual([usdToMicros(1), usdToMicros(2)]);
    expect((lines[0]?.data?.["call"] as { usdMicros?: number }).usdMicros).toBe(usdToMicros(1));
    expect(lines[0]?.data?.["model"]).toBe(PRICED_MODEL);
  });
});

describe("metered-llm: the metering log carries figures, never content", () => {
  it("never puts model output, thinking, or raw text on the llm.metered line", async () => {
    // `LlmResponse extends TokenUsage`, so a response is structurally a valid
    // usage value — and passing it whole to a function that SPREADS it put the
    // model's output and chain-of-thought onto an info-level log line, with
    // none of the redaction the span path applies to the same content.
    // One definition of "a response carrying content", so the two arms cannot
    // drift and leave one of them asserting against a different payload.
    const leakyResponse = <O>(): Result<LlmResponse<O>, FrameworkError> =>
      ok({
        output: { secret: "PII-BEARING-OUTPUT" } as O,
        thinking: "CHAIN-OF-THOUGHT",
        rawText: "RAW-MODEL-TEXT",
        ...tokensOnly(10, 5),
      });
    const leaky: LlmClient = {
      sendStructured: async <O>() => leakyResponse<O>(),
      sendWithTools: async <O>() => leakyResponse<O>(),
    };

    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(leaky, { dagId, runId, ...freshLedger(), logger });
    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendWithTools(toolsReq(nodeA), fakeCtx);

    const metering = logs.filter((l) => l.msg === "llm.metered");
    expect(metering).toHaveLength(2);
    for (const line of metering) {
      expect(line.data).not.toHaveProperty("output");
      expect(line.data).not.toHaveProperty("thinking");
      expect(line.data).not.toHaveProperty("rawText");
      expect(JSON.stringify(line.data)).not.toContain("PII-BEARING-OUTPUT");
      expect(JSON.stringify(line.data)).not.toContain("CHAIN-OF-THOUGHT");
      expect(JSON.stringify(line.data)).not.toContain("RAW-MODEL-TEXT");
      // The figures it exists to carry are still all there.
      expect(line.data?.["tokensIn"]).toBe(10);
      expect(line.data?.["tokensOut"]).toBe(5);
      expect(line.data?.["cacheWriteTokens"]).toBe(0);
      expect(line.data?.["cacheReadTokens"]).toBe(0);
    }
  });
});

describe("metered-llm: a failed ledger append is LOUD, and its severity says why", () => {
  // The severity split is a deliberate, documented policy (ADR-0083): under a
  // declared budget a lost append means an operator is relying on a guarantee
  // that just stopped holding, so it is an `error`; with no budget nothing is
  // being protected and it is a `warn`. It was previously asserted nowhere —
  // `llm.ledger-write-failed` appeared exactly once in the repo, at the
  // production call site — so a swapped condition or a dropped log would have
  // been invisible.
  const brokenLedger: SpendLedgerPort = {
    read: async () => ok(NO_SPEND),
    add: async () => err({ kind: "redis-unavailable", operation: "spend-ledger add" }),
  };

  const meteredWith = (limits?: Ceilings) => {
    const { inner } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, {
      dagId,
      runId,
      ledger: brokenLedger,
      hydrated: { kind: "known", spend: NO_SPEND },
      ...(limits !== undefined ? { limits } : {}),
      logger,
    });
    return { metered, logs };
  };

  it("logs at ERROR under a declared budget — the guarantee stopped holding", async () => {
    const { metered, logs } = meteredWith(tokenBudget(1_000_000));
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true);

    const line = logs.find((l) => l.msg === "llm.ledger-write-failed");
    expect(line).toBeDefined();
    expect(line?.level).toBe("error");
  });

  it("logs at WARN with no budget — nothing was being protected", async () => {
    const { metered, logs } = meteredWith();
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true);

    const line = logs.find((l) => l.msg === "llm.ledger-write-failed");
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
  });

  it("carries the attribution triple, the reason, and the spend that went unrecorded", async () => {
    // Without the unrecorded figure the line says something went wrong but not
    // how much a reconciliation is now off by.
    const { metered, logs } = meteredWith(tokenBudget(1_000_000));
    await metered.sendStructured(structuredReq(nodeA));

    const line = logs.find((l) => l.msg === "llm.ledger-write-failed");
    expect(line?.data?.["dagId"]).toBe(dagId as string);
    expect(line?.data?.["runId"]).toBe(runId as string);
    expect(line?.data?.["nodeId"]).toBe(nodeA as string);
    expect(String(line?.data?.["reason"] ?? "")).toContain("spend-ledger add");
    expect((line?.data?.["unrecorded"] as { tokens?: number } | undefined)?.tokens).toBe(150);
  });

  it("still meters IN PROCESS when the append fails — the budget holds for this slice", async () => {
    // Durability is what was lost, not enforcement. The in-process meter is
    // unaffected, so the ceiling still bites within the slice that failed.
    const { inner, calls } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, {
      dagId, runId, ledger: brokenLedger,
      hydrated: { kind: "known", spend: NO_SPEND },
      limits: tokenBudget(200), logger,
    });

    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // 150
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(true); // 300, overshoot
    expect((await metered.sendStructured(structuredReq(nodeA))).ok).toBe(false);
    expect(calls.length).toBe(2);
    expect(logs.filter((l) => l.msg === "llm.ledger-write-failed").length).toBe(2);
  });

  it("appends the SETTLED spend to the ledger on the happy path", async () => {
    // The other half of the contract: what the log reports on failure is what
    // actually reaches the ledger on success.
    const ledger = createInMemorySpendLedger();
    const { inner } = fakeInner(100, 50);
    const { logger, logs } = collectLogs();
    const metered = createMeteredLlm(inner, {
      dagId, runId, ledger,
      hydrated: { kind: "known", spend: NO_SPEND },
      logger,
    });

    await metered.sendStructured(structuredReq(nodeA));
    await metered.sendWithTools(toolsReq(nodeA), fakeCtx);

    const stored = await ledger.read(runId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.tokens).toBe(300);
    expect(stored.value.calls).toBe(2);
    expect(logs.some((l) => l.msg === "llm.ledger-write-failed")).toBe(false);
  });

  it("seeds the meter from hydrated spend — a resumed slice starts where it left off", async () => {
    // The decorator-level half of the park/resume guarantee the factory test
    // covers end-to-end.
    const { inner, calls } = fakeInner(100, 50);
    const { logger } = collectLogs();
    const metered = createMeteredLlm(inner, {
      dagId, runId,
      ledger: createInMemorySpendLedger(),
      hydrated: { kind: "known", spend: pricedCall(500, 0 as never) },
      limits: tokenBudget(400),
      logger,
    });

    const refused = await metered.sendStructured(structuredReq(nodeA));
    expect(refused.ok).toBe(false);
    expect(calls.length).toBe(0); // refused before reaching the provider
  });
});
