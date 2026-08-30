import { describe, expect, it } from "bun:test";
import {
  ceilings,
  dagId,
  nodeId,
  ok,
  runId,
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
const request = { nodeId: nodeId("authority-node"), model: "m" };
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
      hydrated: { kind: "known", spend: { tokens: 0, calls: 0, usd: { kind: "priced", micros: 0 as never } } },
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
      read: async () => ok({ tokens: 0, calls: 0, usd: { kind: "priced", micros: 0 as never } }),
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
      hydrated: { kind: "known", spend: { tokens: 0, calls: 0, usd: { kind: "priced", micros: 0 as never } } },
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
      hydrated: { kind: "known", spend: { tokens: 0, calls: 0, usd: { kind: "priced", micros: 0 as never } } },
      ledger: createInMemorySpendLedger(),
      logger,
    });
    const first = authority.budget.spent();
    const second = authority.budget.spent();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.usd)).toBe(true);
  });
});
