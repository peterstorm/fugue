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
  type Ceilings,
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
import { collectLogs } from "../adapters/__tests__/fixtures/log-capture.js";

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

/**
 * Every test drives the real authority over the same fixed DAG identity and a
 * fully-hydrated zero ledger; only the run, the ceilings, the ledger and the
 * logger vary. Mirrors `createTestAuthority` in `metered-llm.test.ts`.
 */
const testAuthority = (opts: {
  readonly run: string;
  readonly limits?: Ceilings;
  readonly ledger?: SpendLedgerPort;
  readonly logger?: LogPort;
}) =>
  createRunSpendAuthority({
    dagId: dagId("authority-dag"),
    runId: runId(opts.run),
    hydrated: { kind: "known", spend: NO_SPEND },
    ledger: opts.ledger ?? createInMemorySpendLedger(),
    logger: opts.logger ?? logger,
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
  });

/**
 * A ledger whose every append fails. Three tests need exactly this — the
 * unbudgeted/budgeted split and the provider-outcome ordering — and a
 * per-test copy is how one of them would quietly stop failing the same way.
 */
const alwaysFailingLedger = (): SpendLedgerPort => ({
  metadata: { role: "redis-fallback", backend: "memory", durability: "process" },
  read: async () => ok(NO_SPEND),
  add: async () => err({
    kind: "internal-invariant-violated",
    message: "ledger unavailable",
    context: {},
  }),
});

describe("RunSpendAuthority", () => {
  it("remaining includes every shared in-flight reservation and agrees with admission", async () => {
    const authority = testAuthority({
      run: "authority-run",
      limits,
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
    const authority = testAuthority({
      run: "pending-ledger-run",
      limits,
      ledger,
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
    const authority = testAuthority({
      run: "fixed-model-run",
      limits: ceilings([{ kind: "usd", limit: 10_000 as never }])!,
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
    const authority = testAuthority({
      run: authorityRunId,
      limits: oneCallLimit,
      ledger,
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
    const authority = testAuthority({
      run: authorityRunId,
      ledger,
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
      const authority = testAuthority({
        run: authorityRunId,
        limits: oneCallLimit,
        ledger,
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
    const authority = testAuthority({
      run: "transformed-output-run",
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
    const authority = testAuthority({
      run: "different-output-type-run",
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
    const { logger: capturingLogger, logs: events } = collectLogs();
    const failingLedger = alwaysFailingLedger();
    const authority = testAuthority({
      run: "provider-and-ledger-failure",
      limits: oneCallLimit,
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
    const authority = testAuthority({
      run: authorityRunId,
      limits,
      ledger,
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
    const authority = testAuthority({
      run: "max-safe-usage",
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
    const authority = testAuthority({
      run: "snapshot-run",
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

  // ── The Result-boundary fence ──────────────────────────────────────────────
  // Every other malformed-client case above returns a bad VALUE. These two
  // break the contract the other way — by throwing — which is the case the
  // `try/catch` around `call()` exists for. Without it the exception escapes
  // `execute` and crashes the node run instead of degrading to a typed error,
  // and the call is never settled, so its reservation leaks and its spend is
  // never recorded.

  it.each([
    ["throws synchronously", () => { throw new Error("client exploded"); }],
    ["rejects", async () => { throw new Error("client exploded"); }],
  ] as const)(
    "converts a client that %s into a typed node-crash and still settles the call",
    async (label, call) => {
      const ledger = createInMemorySpendLedger();
      const authorityRunId = runId(`throwing-client-${label.replaceAll(" ", "-")}`);
      const authority = testAuthority({ run: authorityRunId, limits, ledger });

      const settled = await authority.execute({
        clientKey: "llm",
        operation: "sendStructured",
        request,
        call: call as () => Promise<Result<LlmResponse<unknown>, FrameworkError>>,
      });

      expect(settled.ok).toBe(false);
      if (settled.ok) return;
      expect(settled.error.kind).toBe("node-crash");
      if (settled.error.kind !== "node-crash") return;
      expect(settled.error.message).toContain("LlmClient.sendStructured threw across the Result boundary");
      expect(settled.error.message).toContain("client exploded");
      expect(settled.error.retriability).toBe("non-retriable");

      // A thrown call is still a call that may have cost money: it settles as
      // one durable unknown call, exactly as a malformed VALUE does.
      const unknown = spendOfUnknownCall("m");
      expect(authority.budget.spent()).toEqual(unknown);
      expect(await ledger.read(authorityRunId)).toEqual(ok(unknown));

      // The reservation was released, so the next call is admitted rather than
      // refused against a phantom in-flight estimate.
      expect(authority.budget.remaining()).toMatchObject({ kind: "budgeted" });
    },
  );

  it("hides a hostile non-Error throw behind a safe message", async () => {
    const authority = testAuthority({ run: "hostile-throw", limits });
    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: () => {
        throw { get message() { throw new Error("nested explosion"); } };
      },
    });

    expect(settled.ok).toBe(false);
    if (!settled.ok && settled.error.kind === "node-crash") {
      expect(settled.error.message).toContain("threw across the Result boundary");
    }
  });

  // ── The UNBUDGETED ledger-failure branch ───────────────────────────────────

  it("keeps the provider result when an UNBUDGETED ledger write fails, and says so at warn", async () => {
    // Deliberate asymmetry, and the reason it is deliberate: with no ceiling
    // there is nothing the lost record could have enforced, so failing the
    // node would turn a bookkeeping outage into a run outage. With a ceiling
    // (the test above) the same failure IS an enforcement failure and must
    // fail the call closed. The `warn`-vs-`error` level is the operator-visible
    // encoding of that difference, so both are pinned.
    const { logger: capturingLogger, logs: events } = collectLogs();
    const failingLedger = alwaysFailingLedger();
    // No `limits` — the unbudgeted authority.
    const authority = testAuthority({
      run: "unbudgeted-ledger-failure",
      ledger: failingLedger,
      logger: capturingLogger,
    });

    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });

    expect(settled.ok).toBe(true);
    const failure = events.find((entry) => entry.msg === "llm.ledger-write-failed");
    expect(failure).toBeDefined();
    expect(failure?.level).toBe("warn");
    expect(failure?.data?.providerOutcome).toBe("success");
    expect(failure?.data?.reason).toContain("ledger unavailable");
    // The unrecorded figures are named, so the loss is reconstructable.
    expect(failure?.data?.unrecorded).toBeDefined();
  });

  it("escalates the SAME ledger failure to error and a node-crash once a ceiling exists", async () => {
    const { logger: capturingLogger, logs: events } = collectLogs();
    const failingLedger = alwaysFailingLedger();
    const authority = testAuthority({
      run: "budgeted-ledger-failure",
      limits: oneCallLimit,
      ledger: failingLedger,
      logger: capturingLogger,
    });

    const settled = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });

    expect(settled.ok).toBe(false);
    if (!settled.ok && settled.error.kind === "node-crash") {
      expect(settled.error.message).toContain("could not be durably recorded");
    }
    expect(events.find((entry) => entry.msg === "llm.ledger-write-failed")?.level).toBe("error");
  });

  // ── Accumulation across a retry, and across concurrent siblings ────────────

  it("counts a failed attempt's burned tokens AND the successful retry's toward one budget", async () => {
    // `node-crash.usage` exists so a crash that burned tokens still attributes
    // them (FR-W0-001). The ledger is a monotone append, so a retry ADDS to the
    // failed attempt rather than replacing it — which is the only honest
    // accounting: the provider charged for both. A retry that clobbered the
    // first would let an unbounded retry loop cost an unbounded amount under a
    // budget that never moves.
    const ledger = createInMemorySpendLedger();
    const authorityRunId = runId("crash-usage-across-retry");
    const authority = testAuthority({ run: authorityRunId, limits, ledger });

    const crashed = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => err({
        kind: "node-crash" as const,
        nodeId: request.nodeId,
        retriability: "retriable" as const,
        message: "iteration limit",
        usage: tokensOnly(12, 0),
      }),
    });
    expect(crashed.ok).toBe(false);
    expect(authority.budget.spent().tokens).toBe(12);

    const retried = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });
    expect(retried.ok).toBe(true);

    // 12 burned + 10 on the retry — both preserved, neither clobbered.
    expect(authority.budget.spent().tokens).toBe(22);
    expect(authority.budget.spent().calls).toBe(2);
    const durable = await ledger.read(authorityRunId);
    expect(durable.ok).toBe(true);
    if (durable.ok) expect(durable.value.tokens).toBe(22);
  });

  it("bounds AGGREGATE spend across concurrent siblings sharing one authority", async () => {
    // Sibling nodes in one wave run under a single per-run authority, so the
    // budget they share is a run budget, not a per-node one. Dispatching them
    // truly concurrently — all three admitted-or-refused before any settles —
    // is what proves the reservation accounting holds without a settle in
    // between; sequential calls would pass even if reservations were ignored.
    //
    // The estimate is LEARNED first, deliberately. SC-003 promises a bound for
    // a burst whose call size the meter has seen, and explicitly does NOT
    // promise one for a first burst (nothing has been observed yet, so the
    // projection is zero and every sibling is admitted). Asserting a bound on
    // an unlearned burst would pin a guarantee the design does not make.
    const ledger = createInMemorySpendLedger();
    const authorityRunId = runId("concurrent-siblings");
    const callsCeiling = ceilings([{ kind: "calls", limit: 3 }])!;
    const authority = testAuthority({ run: authorityRunId, limits: callsCeiling, ledger });

    const learned = await authority.execute({
      clientKey: "llm",
      operation: "sendStructured",
      request,
      call: async () => response(),
    });
    expect(learned.ok).toBe(true);

    let providerCalls = 0;
    const gate = deferred<void>();
    const siblings = [0, 1, 2].map(() =>
      authority.execute({
        clientKey: "llm",
        operation: "sendStructured",
        request,
        call: async () => {
          providerCalls += 1;
          await gate.promise;
          return response();
        },
      }),
    );
    // Let every admission decision run before any call settles.
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve();

    const settled = await Promise.all(siblings);
    // The projection uses in-flight BEFORE reserving the current call, so the
    // third sibling sees settled 1 + 2 in-flight = the ceiling of 3 and is refused.
    expect(settled.filter((r) => r.ok).length).toBe(2);
    expect(settled.filter((r) => !r.ok).length).toBe(1);
    expect(providerCalls).toBe(2);

    // The aggregate — the only figure a run budget is actually about — stayed
    // inside the shared ceiling, and the durable ledger agrees with the meter.
    expect(authority.budget.spent().calls).toBe(3);
    expect(authority.budget.spent().calls).toBeLessThanOrEqual(3);
    const durable = await ledger.read(authorityRunId);
    expect(durable.ok).toBe(true);
    if (durable.ok) expect(durable.value.calls).toBe(3);
  });

});
