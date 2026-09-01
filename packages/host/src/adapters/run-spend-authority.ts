/**
 * One mutable spend/reservation cell shared by every LLM client in an execution slice.
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
  LlmPricingModel,
  LlmRequest,
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
  PersistedFrameworkErrorSchema,
  err,
  formatBreach,
  isPricedModel,
  ok,
  remainingFor,
  safeErrorMessage,
  snapshotSpend,
  spendOfCall,
  spendOfUnknownCall,
  usageOfError,
} from "@fuguejs/framework";
import type { LogPort, SpendLedgerPort } from "../ports.js";
import { formatHostError } from "../domain/host-error.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";
import {
  accumulate,
  admitCandidate,
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

interface MeteredRequestBase {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly cache?: SingleShotCachePolicy | ConversationCachePolicy;
}

export interface MeteredRequest<O> extends MeteredRequestBase {
  readonly schema: LlmRequest<O>["schema"];
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
  readonly pricingModel?: LlmPricingModel;
  readonly request: MeteredRequest<O>;
  readonly call: () => Promise<Result<LlmResponse<O>, FrameworkError>>;
};

export interface RunSpendAuthority {
  readonly budget: BudgetCapability;
  readonly execute: <O>(args: RunSpendExecution<O>) =>
    Promise<Result<LlmResponse<O>, FrameworkError>>;
}

const writeTtlOf = (cache: MeteredRequestBase["cache"]): CacheTtl =>
  cache === undefined || cache.kind === "none" ? DEFAULT_CACHE_TTL : cache.ttl;

const isObjectLike = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const ownDataValue = (value: object, key: PropertyKey): Result<unknown, string> => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? ok(descriptor.value)
    : err(`'${String(key)}' must be an own data property`);
};

const tokenUsageOf = (value: unknown): TokenUsage | undefined => {
  if (!isObjectLike(value)) return undefined;
  try {
    const tokensIn = ownDataValue(value, "tokensIn");
    const tokensOut = ownDataValue(value, "tokensOut");
    const cacheWriteTokens = ownDataValue(value, "cacheWriteTokens");
    const cacheReadTokens = ownDataValue(value, "cacheReadTokens");
    if (!tokensIn.ok || !tokensOut.ok || !cacheWriteTokens.ok || !cacheReadTokens.ok) {
      return undefined;
    }
    if (
      !isNonNegativeSafeInteger(tokensIn.value) ||
      !isNonNegativeSafeInteger(tokensOut.value) ||
      !isNonNegativeSafeInteger(cacheWriteTokens.value) ||
      !isNonNegativeSafeInteger(cacheReadTokens.value)
    ) {
      return undefined;
    }
    const usage: TokenUsage = {
      tokensIn: tokensIn.value,
      tokensOut: tokensOut.value,
      cacheWriteTokens: cacheWriteTokens.value,
      cacheReadTokens: cacheReadTokens.value,
    };
    return usage.cacheWriteTokens <= usage.tokensIn &&
        usage.cacheReadTokens <= usage.tokensIn - usage.cacheWriteTokens
      ? usage
      : undefined;
  } catch {
    return undefined;
  }
};

type SettledUsage =
  | { readonly kind: "known"; readonly usage: TokenUsage }
  | { readonly kind: "unknown" };

type SettledLlmResult<O> = {
  readonly result: Result<LlmResponse<O>, FrameworkError>;
  readonly usage: SettledUsage;
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
    usage: { kind: "unknown" },
  });

  if (!isObjectLike(raw)) return malformed("expected an object");
  try {
    const outcome = ownDataValue(raw, "ok");
    if (!outcome.ok) return malformed(outcome.error);
    if (outcome.value === true) {
      const responseValue = ownDataValue(raw, "value");
      if (!responseValue.ok || !isObjectLike(responseValue.value)) {
        return malformed("successful Result.value must be an own response object");
      }
      const response = responseValue.value;
      const usage = tokenUsageOf(response);
      if (usage === undefined) return malformed("successful response has invalid token usage");
      const output = ownDataValue(response, "output");
      if (!output.ok) return malformed(`successful response ${output.error}`);
      const rawText = ownDataValue(response, "rawText");
      if (!rawText.ok || typeof rawText.value !== "string") {
        return malformed("successful response rawText must be an own string data property");
      }
      const thinkingDescriptor = Object.getOwnPropertyDescriptor(response, "thinking");
      if (thinkingDescriptor !== undefined && !Object.hasOwn(thinkingDescriptor, "value")) {
        return malformed("successful response thinking must be an own data property when present");
      }
      const thinking = thinkingDescriptor?.value;
      if (thinking !== undefined && typeof thinking !== "string") {
        return malformed("successful response thinking must be a string when present");
      }
      return {
        result: ok({
          // LlmClient owns the one schema parse. Re-parsing its typed output
          // here would apply Zod transforms twice (and can reject output types
          // that intentionally differ from their input types).
          output: output.value as O,
          rawText: rawText.value,
          ...(thinking !== undefined ? { thinking } : {}),
          ...usage,
        }),
        usage: { kind: "known", usage },
      };
    }
    if (outcome.value === false) {
      const errorValue = ownDataValue(raw, "error");
      if (!errorValue.ok) return malformed(errorValue.error);
      const parsed = PersistedFrameworkErrorSchema.safeParse(errorValue.value);
      if (!parsed.success) return malformed("error payload is not a FrameworkError");
      const partial = usageOfError(parsed.data);
      if (partial === undefined) {
        return { result: err(parsed.data), usage: { kind: "unknown" } };
      }
      const usage = tokenUsageOf(partial);
      return usage === undefined
        ? malformed("error payload has invalid token usage")
        : { result: err(parsed.data), usage: { kind: "known", usage } };
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
  ): FrameworkError => {
    logWithoutThrowing(logger, "warn", "LLM budget exceeded — refusing call", {
      ...attribution(nodeId, clientKey),
      reason: formatBreach(breach),
      basis: breach.basis,
      ceiling: breach.ceiling.kind,
      inFlight,
      settled: spendFields(settled),
    });
    return {
      kind: "llm-budget-exceeded",
      runId,
      nodeId,
      cause: breach,
    };
  };

  const gate = (
    request: MeteredRequestBase,
    clientKey: Capability,
    effectiveModel: string,
  ): Result<() => void, FrameworkError> => {
    const decision = admitCandidate(
      meter,
      runId,
      reservation,
      limits,
      isPricedModel(effectiveModel)
        ? { kind: "priced", model: effectiveModel }
        : { kind: "unpriced", model: effectiveModel },
    );
    if (decision.kind === "refuse") {
      return err(refusal(
        request.nodeId,
        clientKey,
        decision.breach,
        decision.settled,
        decision.inFlight,
      ));
    }
    reservation = decision.state;
    let active = true;
    return ok(() => {
      if (!active) return;
      active = false;
      reservation = releaseAuthorityReservation(
        reservation,
        logger,
        attribution(request.nodeId, clientKey),
      );
    });
  };

  const persist = async (
    nodeId: NodeId,
    clientKey: Capability,
    call: Spend,
    providerOutcome: "success" | FrameworkError["kind"],
  ): Promise<Result<void, string>> => {
    const reportFailure = (reason: string): Result<void, string> => {
      logWithoutThrowing(
        logger,
        limits === undefined ? "warn" : "error",
        "llm.ledger-write-failed",
        {
          ...attribution(nodeId, clientKey),
          reason,
          providerOutcome,
          unrecorded: spendFields(call),
        },
      );
      return err(reason);
    };

    try {
      const appended = await ledger.add(runId, call);
      return appended.ok ? ok(undefined) : reportFailure(formatHostError(appended.error));
    } catch (error) {
      return reportFailure(
        `SpendLedgerPort.add threw across the port boundary: ${safeErrorMessage(error)}`,
      );
    }
  };

  const record = (
    req: MeteredRequestBase,
    clientKey: Capability,
    operation: MeteredLlmOperation,
    effectiveModel: string,
    settledUsage: SettledUsage,
  ): Spend => {
    const call = settledUsage.kind === "known"
      ? spendOfCall(effectiveModel, settledUsage.usage, writeTtlOf(req.cache))
      : spendOfUnknownCall(effectiveModel);
    reservation = learnObservedCall(reservation, call);
    meter = accumulate(meter, runId, call);
    logWithoutThrowing(logger, "info", "llm.metered", {
      ...attribution(req.nodeId, clientKey),
      operation,
      requestedModel: req.model,
      effectiveModel,
      ...(settledUsage.kind === "known"
        ? settledUsage.usage
        : { ...NO_TOKENS, usage: "unknown" }),
      call: spendFields(call),
      cumulative: spendFields(spendFor(meter, runId)),
      ...(limits !== undefined ? { limits: limits.map((c) => `${c.kind}:${c.limit}`) } : {}),
    });
    return call;
  };

  const settle = async <O>(
    req: MeteredRequest<O>,
    clientKey: Capability,
    operation: MeteredLlmOperation,
    effectiveModel: string,
    rawResult: unknown,
    releaseReservationForCall: () => void,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    const { result, usage } = settledLlmResult<O>(rawResult, req.nodeId, operation);
    const settledCall = record(req, clientKey, operation, effectiveModel, usage);
    releaseReservationForCall();
    const providerOutcome = result.ok ? "success" : result.error.kind;
    if (!result.ok) {
      // Provider outcome is authoritative evidence even when the subsequent
      // durability write fails and becomes the returned budget-enforcement error.
      logWithoutThrowing(logger, "warn", "llm.call-failed", {
        ...attribution(req.nodeId, clientKey),
        operation,
        errorKind: result.error.kind,
        ...(usage.kind === "known" ? usage.usage : { ...NO_TOKENS, usage: "unknown" }),
      });
    }

    const persisted = await persist(
      req.nodeId,
      clientKey,
      settledCall,
      providerOutcome,
    );
    if (!persisted.ok && limits !== undefined) {
      return err({
        kind: "node-crash",
        nodeId: req.nodeId,
        retriability: "non-retriable",
        message:
          `LLM spend could not be durably recorded after provider outcome ` +
          `'${providerOutcome}': ${persisted.error}`,
      });
    }
    return result;
  };

  const execute = async <O>({
    clientKey,
    operation,
    pricingModel = { kind: "request" },
    request,
    call,
  }: RunSpendExecution<O>): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    const effectiveModel = pricingModel.kind === "request"
      ? request.model
      : pricingModel.model;
    if (pricingModel.kind === "fixed" && request.model !== pricingModel.model) {
      return err({
        kind: "validation",
        nodeId: request.nodeId,
        message:
          `LLM capability '${clientKey}' is bound to model '${pricingModel.model}' ` +
          `but the request named '${request.model}'`,
      });
    }
    const admission = gate(request, clientKey, effectiveModel);
    if (!admission.ok) return admission;
    const release = admission.value;
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
      return await settle(
        request,
        clientKey,
        operation,
        effectiveModel,
        result,
        release,
      );
    } finally {
      release();
    }
  };

  const budget: BudgetCapability = Object.freeze({
    spent: () => snapshotSpend(spendFor(meter, runId)),
    remaining: () => remainingFor(limits, projectedSpend(meter, runId, reservation)),
  });

  return Object.freeze({ budget, execute });
};
