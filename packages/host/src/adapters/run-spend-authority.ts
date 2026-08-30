/**
 * One mutable spend/reservation cell for every LLM client in an execution slice.
 * Pure accounting remains in `domain/llm-meter`; this shell sequences provider
 * settlement, logging, and one awaited ledger append (ADR-0082/0083).
 */

import type {
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
  err,
  formatBreach,
  pickUsage,
  remainingFor,
  safeErrorMessage,
  snapshotSpend,
  spendOfCall,
  totalTokens,
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

export interface RunSpendAuthority {
  readonly budget: BudgetCapability;
  readonly execute: <O>(args: {
    readonly clientKey: Capability;
    readonly operation: MeteredLlmOperation;
    readonly request: MeteredRequest;
    readonly call: () => Promise<Result<LlmResponse<O>, FrameworkError>>;
  }) => Promise<Result<LlmResponse<O>, FrameworkError>>;
}

const writeTtlOf = (cache: MeteredRequest["cache"]): CacheTtl =>
  cache === undefined || cache.kind === "none" ? DEFAULT_CACHE_TTL : cache.ttl;

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

  const gate = (
    nodeId: NodeId,
    clientKey: Capability,
  ): { readonly error: FrameworkError } | { readonly release: () => void } => {
    const decision = admit(meter, runId, reservation, limits);
    if (decision.kind === "refuse") {
      logWithoutThrowing(logger, "warn", "LLM budget exceeded — refusing call", {
        ...attribution(nodeId, clientKey),
        reason: formatBreach(decision.breach),
        basis: decision.breach.basis,
        ceiling: decision.breach.ceiling.kind,
        inFlight: decision.inFlight,
        settled: spendFields(decision.settled),
      });
      return {
        error: {
          kind: "llm-budget-exceeded",
          runId,
          nodeId,
          cause: decision.breach,
        },
      };
    }
    reservation = decision.state;
    return {
      release: () => {
        reservation = releaseAuthorityReservation(
          reservation,
          logger,
          attribution(nodeId, clientKey),
        );
      },
    };
  };

  const persist = async (
    nodeId: NodeId,
    clientKey: Capability,
    call: Spend,
  ): Promise<void> => {
    const appended = await ledger.add(runId, call);
    if (appended.ok) return;
    logWithoutThrowing(
      logger,
      limits === undefined ? "warn" : "error",
      "llm.ledger-write-failed",
      {
        ...attribution(nodeId, clientKey),
        reason: formatHostError(appended.error),
        unrecorded: spendFields(call),
      },
    );
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
    result: Result<LlmResponse<O>, FrameworkError>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    if (result.ok) {
      await persist(req.nodeId, clientKey, record(req, clientKey, operation, pickUsage(result.value)));
      return result;
    }

    const partial = usageOfError(result.error);
    if (partial !== undefined && totalTokens(partial) > 0) {
      await persist(req.nodeId, clientKey, record(req, clientKey, operation, partial));
    }
    logWithoutThrowing(logger, "warn", "llm.call-failed", {
      ...attribution(req.nodeId, clientKey),
      operation,
      errorKind: result.error.kind,
      ...partial,
    });
    return result;
  };

  const execute: RunSpendAuthority["execute"] = async ({
    clientKey,
    operation,
    request,
    call,
  }) => {
    const admission = gate(request.nodeId, clientKey);
    if ("error" in admission) return err(admission.error);
    try {
      return await settle(request, clientKey, operation, await call());
    } catch (error) {
      logWithoutThrowing(logger, "warn", "llm.call-failed", {
        ...attribution(request.nodeId, clientKey),
        operation,
        errorKind: "thrown",
        message: safeErrorMessage(error),
      });
      throw error;
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
