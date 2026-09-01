import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  ceilings,
  dagId,
  err,
  nodeId,
  NO_SPEND,
  ok,
  runId,
  spendOfUnknownCall,
  tokensOnly,
  type LlmResponse,
  type Result,
  type FrameworkError,
} from "@fuguejs/framework";
import {
  createRunSpendAuthority,
  releaseAuthorityReservation,
} from "../adapters/run-spend-authority.js";
import type { LogPort, SpendLedgerPort } from "../ports.js";
import { createInMemorySpendLedger } from "../adapters/spend-ledger-memory.js";
import { emptyReservation, learnObservedCall } from "../domain/llm-meter.js";

const limits = ceilings([{ kind: "tokens", limit: 30 }])!;
const oneCallLimit = ceilings([{ kind: "calls", limit: 1 }])!;
const request = {
  nodeId: nodeId("authority-node"),
  model: "m",
  schema: z.unknown(),
};
const response = (): Result<LlmResponse<unknown>, FrameworkError> =>
  ok({ output: {}, ...tokensOnly(10, 0), rawText: "" });
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("RunSpendAuthority", () => {
  it("remaining includes every shared in-flight reservation and agrees with admission", async () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("authority-run"),
      limits,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: createInMemorySpendLedger(),
      logger,
    });

    // Learn a 10-token estimate before exercising concurrent reservations.
    await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });

    const main = deferred<Result<LlmResponse<unknown>, FrameworkError>>();
    const judge = deferred<Result<LlmResponse<unknown>, FrameworkError>>();
    const mainCall = authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: () => main.promise,
    });
    await Promise.resolve();
    expect(authority.budget.remaining()).toMatchObject({
      kind: "budgeted",
      headroom: [{ kind: "available", amount: 10 }],
    });

    const judgeCall = authority.execute({
      clientKey: "judgeLlm",
      operation: "sendStructured",
      request,
      call: () => judge.promise,
    });
    await Promise.resolve();
    expect(authority.budget.remaining()).toMatchObject({
      kind: "budgeted",
      headroom: [{ kind: "available", amount: 0 }],
    });

    let providerCalls = 0;
    const refused = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => {
        providerCalls += 1;
        return response();
      },
    });
    expect(refused.ok).toBe(false);
    expect(providerCalls).toBe(0);

    main.resolve(response());
    judge.resolve(response());
    expect((await mainCall).ok).toBe(true);
    expect((await judgeCall).ok).toBe(true);
    expect(authority.budget.spent().tokens).toBe(30);
  });

  it("releases settled reservations before pending ledger I/O without skipping persistence", async () => {
    const pendingAppend = deferred<Awaited<ReturnType<SpendLedgerPort["add"]>>>();
    const appendedTokens: number[] = [];
    const ledger: SpendLedgerPort = {
      metadata: Object.freeze({
        role: "redis-fallback",
        backend: "memory",
        durability: "process",
      }),
      read: async () => ok(NO_SPEND),
      add: async (_runId, delta) => {
        appendedTokens.push(delta.tokens);
        if (appendedTokens.length === 2) return pendingAppend.promise;
        return ok(undefined);
      },
    };
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("pending-ledger-run"),
      limits,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger,
      logger,
    });

    await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });
    const pendingCall = authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });
    await Promise.resolve();

    expect(authority.budget.spent().tokens).toBe(20);
    expect(authority.budget.remaining()).toMatchObject({
      kind: "budgeted",
      headroom: [{ kind: "available", amount: 10 }],
    });

    let thirdProviderCalls = 0;
    const admitted = await authority.execute({
      clientKey: "judgeLlm",
      operation: "sendStructured",
      request,
      call: async () => {
        thirdProviderCalls += 1;
        return response();
      },
    });
    expect(admitted.ok).toBe(true);
    expect(thirdProviderCalls).toBe(1);
    expect(appendedTokens).toEqual([10, 10, 10]);

    pendingAppend.resolve(ok(undefined));
    expect((await pendingCall).ok).toBe(true);
    expect(appendedTokens).toHaveLength(3);
  });

  it("rejects a caller model that conflicts with the composition-owned fixed model", async () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("fixed-model-run"),
      limits: ceilings([{ kind: "usd", limit: 10_000 as never }])!,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: createInMemorySpendLedger(),
      logger,
    });
    let providerCalls = 0;

    const result = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      pricingModel: { kind: "fixed", model: "gpt-4o" },
      request: { ...request, model: "gpt-4o-mini" },
      call: async () => {
        providerCalls += 1;
        return response();
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("validation");
    expect(providerCalls).toBe(0);
    expect(authority.budget.spent()).toEqual(NO_SPEND);
  });

  it("counts a typed failure without usage and refuses the next calls-limited attempt", async () => {
    const ledger = createInMemorySpendLedger();
    const authorityRunId = runId("calls-only-run");
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: authorityRunId,
      limits: oneCallLimit,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger,
      logger,
    });
    let providerAttempts = 0;
    const failingCall = async (): Promise<Result<LlmResponse<unknown>, FrameworkError>> => {
      providerAttempts += 1;
      return err({
        kind: "transient",
        nodeId: request.nodeId,
        message: "provider unavailable",
      });
    };

    const first = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: failingCall,
    });
    const refused = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: failingCall,
    });

    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.kind).toBe("transient");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("llm-budget-exceeded");
    expect(providerAttempts).toBe(1);
    const unknown = spendOfUnknownCall("m");
    expect(authority.budget.spent()).toEqual(unknown);
    expect(await ledger.read(authorityRunId)).toEqual(ok(unknown));
  });

  it("turns an accessor-throwing Result into a typed settled failure", async () => {
    const ledger = createInMemorySpendLedger();
    const authorityRunId = runId("hostile-result-run");
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: authorityRunId,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger,
      logger,
    });
    const hostile = Object.defineProperty({}, "ok", {
      get: () => { throw new Error("ok accessor escaped"); },
    });

    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => hostile as never,
    });

    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.error.kind).toBe("node-crash");
      if (settled.error.kind === "node-crash") {
        expect(settled.error.message).toContain("malformed Result");
      }
    }
    const unknown = spendOfUnknownCall("m");
    expect(authority.budget.spent()).toEqual(unknown);
    expect(await ledger.read(authorityRunId)).toEqual(ok(unknown));
  });

  it.each([
    ["primitive", 7],
    ["invalid discriminant", { ok: "yes", value: {} }],
    [
      "malformed success usage",
      {
        ok: true,
        value: {
          output: {},
          rawText: "",
          tokensIn: 0.5,
          tokensOut: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
      },
    ],
    [
      "missing successful output",
      { ok: true, value: { rawText: "", ...tokensOnly(1, 0) } },
    ],
    [
      "missing successful rawText",
      { ok: true, value: { output: {}, ...tokensOnly(1, 0) } },
    ],
    [
      "malformed successful thinking",
      { ok: true, value: { output: {}, rawText: "", thinking: 7, ...tokensOnly(1, 0) } },
    ],
    ["malformed error payload", { ok: false, error: { nope: true } }],
    [
      "malformed error usage",
      {
        ok: false,
        error: {
          kind: "transient",
          nodeId: request.nodeId,
          message: "provider failed",
          usage: {
            tokensIn: Number.MAX_SAFE_INTEGER + 1,
            tokensOut: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
          },
        },
      },
    ],
  ] as const)(
    "settles %s as one durable unknown call before calls-ceiling refusal",
    async (_label, raw) => {
      const ledger = createInMemorySpendLedger();
      const authorityRunId = runId(`malformed-${_label.replaceAll(" ", "-")}`);
      const authority = createRunSpendAuthority({
        dagId: dagId("authority-dag"),
        runId: authorityRunId,
        limits: oneCallLimit,
        hydrated: { kind: "known", spend: NO_SPEND },
        ledger,
        logger,
      });
      let providerCalls = 0;
      const invoke = () => authority.execute({
        clientKey: "llm",
        operation: "sendStructured",
        request,
        call: async () => {
          providerCalls += 1;
          return raw as never;
        },
      });

      const malformed = await invoke();
      const refused = await invoke();

      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.error.kind).toBe("node-crash");
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.kind).toBe("llm-budget-exceeded");
      expect(providerCalls).toBe(1);
      const stored = await ledger.read(authorityRunId);
      expect(stored.ok).toBe(true);
      if (stored.ok) {
        expect(stored.value.calls).toBe(1);
        expect(stored.value.usage).toBe("unknown");
      }
    },
  );

  it("preserves an already transformed provider output without applying the schema twice", async () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("transformed-output-run"),
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: createInMemorySpendLedger(),
      logger,
    });
    const schema = z.string().transform((value) => `${value}!`);
    const providerOutput = schema.parse("once");
    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request: { ...request, schema },
      call: async () => ok({
        output: providerOutput,
        rawText: "raw",
        ...tokensOnly(1, 0),
      }),
    });

    expect(settled).toEqual(ok({
      output: "once!",
      rawText: "raw",
      ...tokensOnly(1, 0),
    }));
  });

  it("accepts a provider output whose schema output type differs from its input type", async () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("different-output-type-run"),
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: createInMemorySpendLedger(),
      logger,
    });
    const schema = z.string().transform((value) => value.length);
    const providerOutput = schema.parse("abc");
    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request: { ...request, schema },
      call: async () => ok({
        output: providerOutput,
        rawText: "raw",
        ...tokensOnly(1, 0),
      }),
    });

    expect(settled).toEqual(ok({
      output: 3,
      rawText: "raw",
      ...tokensOnly(1, 0),
    }));
    expect(authority.budget.spent().usage).toBe("known");
  });

  it("logs a failed provider outcome before a budgeted ledger failure masks its return", async () => {
    const events: Array<{ readonly msg: string; readonly data?: Record<string, unknown> }> = [];
    const capturingLogger: LogPort = {
      info: (msg, data) => { events.push({ msg, data }); },
      warn: (msg, data) => { events.push({ msg, data }); },
      error: (msg, data) => { events.push({ msg, data }); },
    };
    const failingLedger: SpendLedgerPort = {
      metadata: { role: "redis-fallback", backend: "memory", durability: "process" },
      read: async () => ok(NO_SPEND),
      add: async () => err({
        kind: "internal-invariant-violated",
        message: "ledger unavailable",
        context: {},
      }),
    };
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("provider-and-ledger-failure"),
      limits: oneCallLimit,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: failingLedger,
      logger: capturingLogger,
    });

    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => err({
        kind: "transient",
        nodeId: request.nodeId,
        message: "provider unavailable",
      }),
    });

    expect(settled.ok).toBe(false);
    if (!settled.ok && settled.error.kind === "node-crash") {
      expect(settled.error.message).toContain("provider outcome 'transient'");
    }
    const providerIndex = events.findIndex((entry) => entry.msg === "llm.call-failed");
    const ledgerIndex = events.findIndex((entry) => entry.msg === "llm.ledger-write-failed");
    expect(providerIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerIndex).toBeGreaterThan(providerIndex);
    expect(events[ledgerIndex]?.data?.providerOutcome).toBe("transient");
  });

  it("treats cache parts exceeding inclusive tokensIn as unknown and closes token admission", async () => {
    const ledger = createInMemorySpendLedger();
    const authorityRunId = runId("invalid-cache-breakdown");
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: authorityRunId,
      limits,
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger,
      logger,
    });
    let providerCalls = 0;
    const invoke = () => authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => {
        providerCalls += 1;
        return ok({
          output: {},
          rawText: "",
          tokensIn: 1,
          tokensOut: 0,
          cacheWriteTokens: 1,
          cacheReadTokens: 1,
        });
      },
    });

    const malformed = await invoke();
    const refused = await invoke();

    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.kind).toBe("node-crash");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("llm-budget-exceeded");
    expect(providerCalls).toBe(1);
    const stored = await ledger.read(authorityRunId);
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.usage).toBe("unknown");
  });

  it("accepts non-negative safe-integer usage at the parser boundary", async () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("max-safe-usage"),
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: createInMemorySpendLedger(),
      logger,
    });

    const result = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => ok({
        output: {},
        rawText: "",
        tokensIn: Number.MAX_SAFE_INTEGER,
        tokensOut: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    });

    expect(result.ok).toBe(true);
    expect(authority.budget.spent().usage).toBe("known");
    expect(authority.budget.spent().tokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("logs reservation underflow and retains state without granting more headroom", () => {
    const logs: { readonly msg: string; readonly data?: Record<string, unknown> }[] = [];
    const capturingLogger: LogPort = {
      info: () => {},
      warn: () => {},
      error: (msg, data) => { logs.push({ msg, data }); },
    };
    const state = learnObservedCall(
      emptyReservation,
      { tokens: 10, calls: 1, usd: { kind: "priced", micros: 0 as never } },
    );

    const retained = releaseAuthorityReservation(state, capturingLogger, {
      dagId: "authority-dag",
      runId: "authority-run",
      nodeId: "authority-node",
      clientKey: "llm",
    });

    expect(retained).toBe(state);
    expect(retained.inFlight).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe("llm.reservation-release-failed");
    expect(logs[0]?.data?.errorKind).toBe("reservation-underflow");
    expect(logs[0]?.data?.consequence).toContain("no additional budget headroom");
  });

  it("spent returns fresh deeply immutable snapshots", async () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("snapshot-run"),
      hydrated: { kind: "known", spend: NO_SPEND },
      ledger: createInMemorySpendLedger(),
      logger,
    });
    const first = authority.budget.spent();
    const second = authority.budget.spent();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.usd)).toBe(true);
  });

  it("remaining returns fresh deeply frozen snapshots isolated from mutation", () => {
    const authority = createRunSpendAuthority({
      dagId: dagId("authority-dag"),
      runId: runId("remaining-snapshot-run"),
      limits,
      hydrated: { kind: "known", spend: { ...NO_SPEND, tokens: 10, calls: 1 } },
      ledger: createInMemorySpendLedger(),
      logger,
    });

    const first = authority.budget.remaining();
    const second = authority.budget.remaining();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.kind !== "budgeted" || second.kind !== "budgeted") {
      throw new Error("expected budgeted snapshots");
    }
    expect(first.headroom).not.toBe(second.headroom);
    expect(Object.isFrozen(first.headroom)).toBe(true);
    expect(Object.isFrozen(first.headroom[0])).toBe(true);
    expect(Object.isFrozen(first.headroom[0]?.ceiling)).toBe(true);
    expect(() => (first.headroom as unknown as unknown[]).push({ poisoned: true })).toThrow();
    expect(() => {
      (first.headroom[0]!.ceiling as unknown as { limit: number }).limit = -1;
    }).toThrow();

    expect(authority.budget.remaining()).toEqual(second);
  });
});
