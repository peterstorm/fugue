/**
 * One mutable spend/reservation cell for every LLM client in an execution slice.
 * Pure accounting remains in `domain/llm-meter`; this shell sequences provider
 * settlement, logging, and one awaited ledger append (ADR-0082/0083).
 */

import type {
  Breach,
  BudgetCapability,
  CacheTtl,
  Capability,
  Ceilings,
  ConversationCachePolicy,
  DagId,
  FrameworkError,
  LlmResponse,
  NodeId,
  Result,
  RunId,
  SingleShotCachePolicy,
  Spend,
  TokenUsage,
} from "@fuguejs/framework";
import {
  DEFAULT_CACHE_TTL,
  NO_TOKENS,
  PRICE_TABLE,
  PersistedFrameworkErrorSchema,
  costFloor,
  err,
  formatBreach,
  remainingFor,
  safeErrorMessage,
  snapshotSpend,
  spendOfCall,
  usageOfError,
} from "@fuguejs/framework";
import type { LogPort, SpendLedgerPort } from "../ports.js";
import { formatHostError } from "../domain/host-error.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";
import {
  accumulate,
  admit,
  emptyMeter,
  emptyReservation,
  learnObservedCall,
  projectedSpend,
  releaseReservation,
  spendFor,
  type LlmMeter,
  type ReservationState,
} from "../domain/llm-meter.js";

export type MeteredLlmOperation = "sendStructured" | "sendWithTools";

export interface MeteredRequest {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly cache?: SingleShotCachePolicy | ConversationCachePolicy;
}

export type HydratedSpend =
  | { readonly kind: "known"; readonly spend: Spend }
  | { readonly kind: "unknown" };

type RunSpendAuthorityBase = {
  readonly dagId: DagId;
  readonly runId: RunId;
  readonly ledger: SpendLedgerPort;
  readonly logger: LogPort;
};

/** Budget and hydration are coupled so a budgeted authority cannot start from a guess. */
export type RunSpendAuthorityDeps = RunSpendAuthorityBase &
  (
    | { readonly limits?: undefined; readonly hydrated: HydratedSpend }
    | {
        readonly limits: Ceilings;
        readonly hydrated: { readonly kind: "known"; readonly spend: Spend };
      }
  );

type RunSpendExecution<O> = {
  readonly clientKey: Capability;
  readonly operation: MeteredLlmOperation;
  readonly request: MeteredRequest;
  readonly call: () => Promise<Result<LlmResponse<O>, FrameworkError>>;
};

export interface RunSpendAuthority {
  readonly budget: BudgetCapability;
  readonly execute: <O>(args: RunSpendExecution<O>) =>
    Promise<Result<LlmResponse<O>, FrameworkError>>;
}

const writeTtlOf = (cache: MeteredRequest["cache"]): CacheTtl =>
  cache === undefined || cache.kind === "none" ? DEFAULT_CACHE_TTL : cache.ttl;

const isObjectLike = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const tokenUsageOf = (value: unknown): TokenUsage | undefined => {
  if (!isObjectLike(value)) return undefined;
  try {
    const usage = {
      tokensIn: Reflect.get(value, "tokensIn"),
      tokensOut: Reflect.get(value, "tokensOut"),
      cacheWriteTokens: Reflect.get(value, "cacheWriteTokens"),
      cacheReadTokens: Reflect.get(value, "cacheReadTokens"),
    };
    if (
      typeof usage.tokensIn !== "number" || !Number.isFinite(usage.tokensIn) || usage.tokensIn < 0 ||
      typeof usage.tokensOut !== "number" || !Number.isFinite(usage.tokensOut) || usage.tokensOut < 0 ||
      typeof usage.cacheWriteTokens !== "number" ||
        !Number.isFinite(usage.cacheWriteTokens) || usage.cacheWriteTokens < 0 ||
      typeof usage.cacheReadTokens !== "number" ||
        !Number.isFinite(usage.cacheReadTokens) || usage.cacheReadTokens < 0
    ) return undefined;
    return usage;
  } catch {
    return undefined;
  }
};

type SettledLlmResult<O> = {
  readonly result: Result<LlmResponse<O>, FrameworkError>;
  readonly usage: TokenUsage;
};

/** Parse one runtime client outcome before accounting or returning it. */
const settledLlmResult = <O>(
  raw: unknown,
  nodeId: NodeId,
  operation: MeteredLlmOperation,
): SettledLlmResult<O> => {
  const malformed = (detail: string): SettledLlmResult<O> => ({
    result: err({
      kind: "node-crash",
      nodeId,
      retriability: "non-retriable",
      message: `LlmClient.${operation} returned a malformed Result: ${detail}`,
    }),
    usage: NO_TOKENS,
  });

  if (!isObjectLike(raw)) return malformed("expected an object");
  try {
    const outcome = Reflect.get(raw, "ok");
    if (outcome === true) {
      const response = Reflect.get(raw, "value");
      const usage = tokenUsageOf(response);
      return usage === undefined
        ? malformed("successful response has invalid token usage")
        : { result: { ok: true, value: response as LlmResponse<O> }, usage };
    }
    if (outcome === false) {
      const parsed = PersistedFrameworkErrorSchema.safeParse(Reflect.get(raw, "error"));
      if (!parsed.success) return malformed("error payload is not a FrameworkError");
      const partial = usageOfError(parsed.data);
      const usage = partial === undefined ? NO_TOKENS : tokenUsageOf(partial);
      return usage === undefined
        ? malformed("error payload has invalid token usage")
        : { result: err(parsed.data), usage };
    }
    return malformed("the 'ok' discriminant is not boolean");
  } catch (error) {
    return malformed(`property access failed: ${safeErrorMessage(error)}`);
  }
};

const spendFields = ({ usd, ...axes }: Spend): Record<string, unknown> => ({
  ...axes,
  ...(usd.kind === "priced"
    ? { usdMicros: usd.micros }
    : { usdMicros: usd.knownMicros, unpricedModels: [...usd.models] }),
});

/** Authority-shell policy for a typed reservation invariant failure. */
export const releaseAuthorityReservation = (
  state: ReservationState,
  logger: LogPort,
  context: Record<string, string>,
): ReservationState => {
  const released = releaseReservation(state);
  if (released.ok) return released.value;
  logWithoutThrowing(logger, "error", "llm.reservation-release-failed", {
    ...context,
    errorKind: released.error.kind,
    inFlight: released.error.inFlight,
    consequence: "reservation state retained; no additional budget headroom granted",
  });
  return state;
};

export const createRunSpendAuthority = (
  deps: RunSpendAuthorityDeps,
): RunSpendAuthority => {
  const { dagId, runId, limits, hydrated, ledger, logger } = deps;
  let meter: LlmMeter = hydrated.kind === "known"
    ? accumulate(emptyMeter(), runId, hydrated.spend)
    : emptyMeter();
  let reservation: ReservationState = emptyReservation;

  const attribution = (
    nodeId: NodeId,
    clientKey: Capability,
  ): Record<string, string> => ({
    dagId: dagId as string,
    runId: runId as string,
    nodeId: nodeId as string,
    clientKey,
  });

  const refusal = (
    nodeId: NodeId,
    clientKey: Capability,
    breach: Breach,
    settled: Spend,
    inFlight: number,
  ): { readonly error: FrameworkError } => {
    logWithoutThrowing(logger, "warn", "LLM budget exceeded — refusing call", {
      ...attribution(nodeId, clientKey),
      reason: formatBreach(breach),
      basis: breach.basis,
      ceiling: breach.ceiling.kind,
      inFlight,
      settled: spendFields(settled),
    });
    return {
      error: {
        kind: "llm-budget-exceeded",
        runId,
        nodeId,
        cause: breach,
      },
    };
  };

  const gate = (
    request: MeteredRequest,
    clientKey: Capability,
  ): { readonly error: FrameworkError } | { readonly release: () => void } => {
    const settled = spendFor(meter, runId);
    const usdCeiling = limits?.find((ceiling) => ceiling.kind === "usd");
    if (
      usdCeiling?.kind === "usd" &&
      !Object.hasOwn(PRICE_TABLE, request.model)
    ) {
      const observedAtLeast = costFloor(settled.usd);
      return refusal(
        request.nodeId,
        clientKey,
        {
          kind: "unpriced",
          ceiling: usdCeiling,
          basis: "projected",
          models: [request.model],
          observedAtLeast,
        },
        settled,
        reservation.inFlight,
      );
    }

    const decision = admit(meter, runId, reservation, limits);
    if (decision.kind === "refuse") {
      return refusal(
        request.nodeId,
        clientKey,
        decision.breach,
        decision.settled,
        decision.inFlight,
      );
    }
    reservation = decision.state;
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        reservation = releaseAuthorityReservation(
          reservation,
          logger,
          attribution(request.nodeId, clientKey),
        );
      },
    };
  };

  const persist = async (
    nodeId: NodeId,
    clientKey: Capability,
    call: Spend,
  ): Promise<void> => {
    const reportFailure = (reason: string): void => {
      logWithoutThrowing(
        logger,
        limits === undefined ? "warn" : "error",
        "llm.ledger-write-failed",
        {
          ...attribution(nodeId, clientKey),
          reason,
          unrecorded: spendFields(call),
        },
      );
    };

    try {
      const appended = await ledger.add(runId, call);
      if (!appended.ok) reportFailure(formatHostError(appended.error));
    } catch (error) {
      reportFailure(
        `SpendLedgerPort.add threw across the port boundary: ${safeErrorMessage(error)}`,
      );
    }
  };

  const record = (
    req: MeteredRequest,
    clientKey: Capability,
    operation: MeteredLlmOperation,
    usage: TokenUsage,
  ): Spend => {
    const call = spendOfCall(req.model, usage, writeTtlOf(req.cache));
    reservation = learnObservedCall(reservation, call);
    meter = accumulate(meter, runId, call);
    logWithoutThrowing(logger, "info", "llm.metered", {
      ...attribution(req.nodeId, clientKey),
      operation,
      model: req.model,
      ...usage,
      call: spendFields(call),
      cumulative: spendFields(spendFor(meter, runId)),
      ...(limits !== undefined ? { limits: limits.map((c) => `${c.kind}:${c.limit}`) } : {}),
    });
    return call;
  };

  const settle = async <O>(
    req: MeteredRequest,
    clientKey: Capability,
    operation: MeteredLlmOperation,
    rawResult: unknown,
    releaseReservationForCall: () => void,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    const { result, usage } = settledLlmResult<O>(rawResult, req.nodeId, operation);
    const settledCall = record(req, clientKey, operation, usage);
    releaseReservationForCall();
    await persist(req.nodeId, clientKey, settledCall);

    if (!result.ok) {
      logWithoutThrowing(logger, "warn", "llm.call-failed", {
        ...attribution(req.nodeId, clientKey),
        operation,
        errorKind: result.error.kind,
        ...(usage === NO_TOKENS ? {} : usage),
      });
    }
    return result;
  };

  const execute = async <O>({
    clientKey,
    operation,
    request,
    call,
  }: RunSpendExecution<O>): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    const admission = gate(request, clientKey);
    if ("error" in admission) return err(admission.error);
    try {
      let result: Result<LlmResponse<O>, FrameworkError>;
      try {
        result = await call();
      } catch (error) {
        result = err({
          kind: "node-crash",
          nodeId: request.nodeId,
          retriability: "non-retriable",
          message:
            `LlmClient.${operation} threw across the Result boundary: ` +
            safeErrorMessage(error),
        });
      }
      return await settle(request, clientKey, operation, result, admission.release);
    } finally {
      admission.release();
    }
  };

  const budget: BudgetCapability = Object.freeze({
    spent: () => snapshotSpend(spendFor(meter, runId)),
    remaining: () => remainingFor(limits, projectedSpend(meter, runId, reservation)),
  });

  return Object.freeze({ budget, execute });
};
