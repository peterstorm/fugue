/**
 * Metered LLM decorator — the imperative shell around the pure `llm-meter`.
 *
 * Wraps the host `LlmClient` so that every node-facing call is:
 *   1. attributed with the run's `(dagId, runId, nodeId)` triple (FR-W0-001),
 *   2. admitted or refused BEFORE the call, against the in-process spend
 *      accumulator (FR-W1-002, FR-W1-004) — refusing with
 *      `Err(llm-budget-exceeded)` naming the ceiling that was reached,
 *   3. PRICED and accumulated AFTER the call, then logged as a structured line
 *      carrying the attribution triple + the call's consumption (FR-W0-002).
 *
 * The ADMISSION decision adds zero network round trips: pricing, the meter, and
 * the comparison are pure in-process operations against a counter hydrated ONCE
 * per slice (FR-W1-005, SC-002, SC-004). The SETTLE path adds one ledger append
 * per provider call, sequenced after a call that already cost seconds — a
 * sub-millisecond write against a multi-second request. That distinction is the
 * honest restatement of what was previously a blanket "zero network round trips
 * are added"; the guarantee that matters (an LLM call is never delayed by
 * budget bookkeeping BEFORE it is made) is unchanged.
 *
 * One decorator instance is constructed per NodeContext (per run), so its meter
 * is naturally run-scoped — the pure functions are keyed by `runId` for defence
 * in depth but a given decorator only ever sees one run. The LEDGER is what
 * makes spend outlive that context: a resumable run builds a fresh NodeContext
 * per execution slice, and without the hydrate-and-append pair a run that parks
 * for a human decision would resume with its budget refilled.
 *
 * LOSS WINDOW: a crash between a provider call settling and its ledger append
 * loses that one call's spend. Bounded by one call — the same magnitude as the
 * documented overshoot-by-one allowance, and for the same structural reason
 * (the record is written after the fact it records).
 *
 * @satisfies FR-W0-001 FR-W0-002 FR-W0-004 FR-W1-002 FR-W1-003 FR-W1-004
 * @satisfies FR-W1-005 FR-W1-006 SC-001 SC-002 SC-003 SC-004
 * @satisfies FR-B-002 FR-B-003 FR-B-013
 *
 * FR-W2-009 groundwork — run-scoped LLM authority, NOT yet on the broker's
 * `mintFor` seam: this decorator is per-run NodeContext wiring, and the runtime
 * currently rejects a broker claiming `provides("llm")` (see
 * keycloak-broker.ts). Migration onto the seam lifts both guards.
 */

import type {
  CacheTtl,
  Ceilings,
  ConversationCachePolicy,
  DagId,
  FrameworkError,
  LlmClient,
  LlmRequest,
  LlmResponse,
  NodeContext,
  NodeId,
  Result,
  RunId,
  SendWithToolsRequest,
  SingleShotCachePolicy,
  Spend,
  TokenUsage,
} from "@fuguejs/framework";
import {
  DEFAULT_CACHE_TTL,
  err,
  formatBreach,
  pickUsage,
  safeErrorMessage,
  spendOfCall,
  totalTokens,
  usageOfError,
} from "@fuguejs/framework";
import type { LogPort, SpendLedgerPort } from "../ports.js";
import { formatHostError } from "../domain/host-error.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";
import {
  emptyMeter,
  accumulate,
  spendFor,
  emptyReservation,
  admit,
  releaseReservation,
  learnObservedCall,
  type LlmMeter,
  type ReservationState,
} from "../domain/llm-meter.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Construction-time dependencies for the metered decorator. `dagId`/`runId`
 * bind the decorator to a single run; `limits` are the optional per-run
 * ceilings — when `undefined`, metering still happens but no call is ever
 * refused (FR-W1-006).
 */
interface MeteredLlmDeps {
  readonly dagId: DagId;
  readonly runId: RunId;
  readonly limits?: Ceilings;
  /**
   * What this run had already settled before the current slice began.
   *
   * A UNION rather than an optional `Spend`, because absence meant two
   * different facts: "a fresh run, definitely zero" and "an unbudgeted run
   * whose ledger could not be read, so genuinely unknown". Both meter from zero
   * today — a budgeted run never reaches here, the factory refuses the slice —
   * but they are not the same claim, and anything that reads this for reporting
   * rather than for admission would have to treat unknown as zero to compile.
   */
  readonly hydrated: HydratedSpend;
  /** Where settled spend is appended so it outlives this NodeContext. */
  readonly ledger: SpendLedgerPort;
  readonly logger: LogPort;
}

/** The two node-facing operations, named identically in every log line. */
type Operation = "sendStructured" | "sendWithTools";

/**
 * Prior spend for this run, or an explicit admission that it is unknown.
 *
 * `unknown` is only reachable for an UNBUDGETED run whose ledger read failed: a
 * budgeted one is refused at context construction rather than metered from a
 * guess (FR-B-007).
 */
export type HydratedSpend =
  | { readonly kind: "known"; readonly spend: Spend }
  | { readonly kind: "unknown" };

/**
 * The request fields metering needs, and only those: who to attribute the call
 * to, and what it costs. Declared structurally rather than as a union of the
 * two concrete request types so the unified path below is agnostic to which
 * operation produced it.
 */
interface MeteredRequest {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly cache?: SingleShotCachePolicy | ConversationCachePolicy;
}

/**
 * The TTL a cache WRITE on this request would be billed at.
 *
 * Falls back to the framework's `DEFAULT_CACHE_TTL` when no policy is declared
 * — the same constant `costBreakdownUsd` defaults to, referenced rather than
 * re-typed so the two cannot drift. A request with caching off writes nothing,
 * so the multiplier is applied to zero tokens and the default is unobservable;
 * it matters only for a request that declared a policy, where the real TTL is
 * right there.
 */
const writeTtlOf = (cache: MeteredRequest["cache"]): CacheTtl =>
  cache === undefined || cache.kind === "none" ? DEFAULT_CACHE_TTL : cache.ttl;

/**
 * A `Spend` flattened for a structured log line.
 *
 * The scalar axes are SPREAD rather than re-listed, so an axis added to `Spend`
 * later rides along instead of being silently dropped from the operator's view.
 * The cost axis cannot be spread — it is a union, and "unknown cost" has to
 * reach the log as something other than a number.
 */
const spendFields = ({ usd, ...axes }: Spend): Record<string, unknown> => ({
  ...axes,
  ...(usd.kind === "priced"
    ? { usdMicros: usd.micros }
    : { usdMicros: usd.knownMicros, unpricedModels: [...usd.models] }),
});

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

/**
 * Wrap an inner `LlmClient` with per-run metering + budget enforcement.
 *
 * The returned client satisfies the same `LlmClient` interface, so it is a
 * drop-in replacement at the NodeContext seam — nodes are unaware they are
 * metered.
 */
export const createMeteredLlm = (inner: LlmClient, deps: MeteredLlmDeps): LlmClient => {
  const { dagId, runId, limits, hydrated, ledger, logger } = deps;

  // In-process, run-scoped accumulator, SEEDED with what the ledger says this
  // run already spent in earlier slices. Mutated only here, behind the pure
  // `accumulate` transition — the meter value itself is immutable.
  let meter: LlmMeter =
    hydrated.kind === "known" ? accumulate(emptyMeter(), runId, hydrated.spend) : emptyMeter();

  // Concurrency reservation (review I1 / SC-003). The DECISION logic is pure —
  // `admit` / `releaseReservation` / `learnObservedCall` in llm-meter.ts (see
  // its ReservationState doc for the overshoot bound) — and this shell holds
  // the one mutable cell, the same shape as the broker's cells over the pure
  // token-cache.
  let reservation: ReservationState = emptyReservation;

  /**
   * The correlation triple every structured line in this adapter carries.
   *
   * Extracted because a metering or failure line that is MISSING one of these
   * is unjoinable to the run that produced it — the figure becomes a number
   * nobody can reconcile against a budget. One definition means the call sites
   * cannot drift apart by hand-editing.
   */
  const attribution = (nodeId: NodeId): Record<string, string> => ({
    dagId: dagId as string,
    runId: runId as string,
    nodeId: nodeId as string,
  });

  /**
   * Pre-call gate. Returns either a budget-refusal error, or a `release` thunk
   * to call once the admitted call settles. Reserving BEFORE the call and
   * releasing AFTER is what makes the gate concurrency-safe.
   */
  const gate = (
    nodeId: NodeId,
  ): { readonly error: FrameworkError } | { readonly release: () => void } => {
    const decision = admit(meter, runId, reservation, limits);
    if (decision.kind === "refuse") {
      logWithoutThrowing(logger, "warn", "LLM budget exceeded — refusing call", {
        ...attribution(nodeId),
        reason: formatBreach(decision.breach),
        basis: decision.breach.basis,
        ceiling: decision.breach.ceiling.kind,
        // The projection that may have triggered this refusal is reported HERE,
        // never on the error's settled figures, so an operator reconciling
        // `llm.metered` totals against the error never sees a phantom gap.
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
    return { release: () => { reservation = releaseReservation(reservation); } };
  };

  /**
   * Persist one settled call's spend so it outlives this NodeContext.
   *
   * A failure here does NOT fail the call: the provider has already run and the
   * tokens are already spent, so refusing the result would waste them and lose
   * the output too. What it costs is DURABILITY — that call will not be visible
   * to the next slice — so it is logged at `error` under a declared budget (a
   * budget-integrity event an operator must see) and at `warn` without one,
   * where nothing is being protected.
   */
  const persist = async (nodeId: NodeId, call: Spend): Promise<void> => {
    const appended = await ledger.add(runId, call);
    if (appended.ok) return;
    logWithoutThrowing(logger, limits === undefined ? "warn" : "error", "llm.ledger-write-failed", {
      ...attribution(nodeId),
      reason: formatHostError(appended.error),
      unrecorded: spendFields(call),
    });
  };

  /** Post-call bookkeeping — price the call, accumulate it, emit the metering log. */
  const record = (req: MeteredRequest, operation: Operation, usage: TokenUsage): Spend => {
    const call = spendOfCall(req.model, usage, writeTtlOf(req.cache));
    // Learn the per-call estimate the concurrency reservation uses (I1).
    reservation = learnObservedCall(reservation, call);
    meter = accumulate(meter, runId, call);
    // The cache split rides on the metering line beside the price so an operator
    // can see what a run's tokens COST, not just how many there were: a cache
    // read is billed at ~0.1x and a write at a premium, so two runs with
    // identical totals can differ by an order of magnitude in spend.
    logWithoutThrowing(logger, "info", "llm.metered", {
      ...attribution(req.nodeId),
      operation,
      model: req.model,
      // Spread rather than re-listed field by field: `TokenUsage`'s own header
      // warns that hand-listing is how a field added to it later gets silently
      // dropped from a consumer, and the metering line is exactly such a
      // consumer.
      ...usage,
      call: spendFields(call),
      cumulative: spendFields(spendFor(meter, runId)),
      ...(limits !== undefined ? { limits: limits.map((c) => `${c.kind}:${c.limit}`) } : {}),
    });
    return call;
  };

  /**
   * Settle one node-facing call's accounting, UNCONDITIONALLY (FR-W0-001).
   *
   * On `ok` the response's token figures are priced and metered. On `err` any
   * partial usage the failure carries (tokens burned across already-completed
   * turns of a multi-turn `sendWithTools` loop, or a final-answer parse failure)
   * is ALSO priced and metered — so a failed call can never bypass the per-run
   * budget — and a structured `llm.call-failed` line is emitted (FR-W0-002).
   * The `result` is returned untouched so the decorator stays a transparent
   * pass-through.
   */
  const settle = async <O>(
    req: MeteredRequest,
    operation: Operation,
    result: Result<LlmResponse<O>, FrameworkError>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    if (result.ok) {
      // `sendWithTools` aggregates tokens across all turns of its loop into a
      // single LlmResponse — one accumulate per outer call matches the
      // overshoot-by-one semantics (the whole loop is the in-flight "call").
      // `LlmResponse` extends `TokenUsage`, so the response IS a valid usage
      // value — but it also carries `output`, `thinking`, and `rawText`, and
      // `record` SPREADS what it is given onto an info-level log line. Passing
      // the response whole put generated content and chain-of-thought into the
      // metering log, with none of the redaction the span path applies.
      // `pickUsage` narrows it to exactly the four figures.
      await persist(req.nodeId, record(req, operation, pickUsage(result.value)));
      return result;
    }
    // Failure path: attribute any consumption the failed call incurred, then log.
    const partial = usageOfError(result.error);
    if (partial !== undefined && totalTokens(partial) > 0) {
      // A failed call's burned tokens are durable too — otherwise a crash-loop
      // could bypass the budget by never settling successfully.
      await persist(req.nodeId, record(req, operation, partial));
    }
    logWithoutThrowing(logger, "warn", "llm.call-failed", {
      ...attribution(req.nodeId),
      operation,
      errorKind: result.error.kind,
      // Spreading `undefined` is a no-op, not a throw, so the absent-usage case
      // needs no guard — and the fields stay in sync with `TokenUsage` for free.
      ...partial,
    });
    return result;
  };

  /**
   * A THROWING inner client is a port-contract violation (the `LlmClient`
   * contract is a settled `Result`) — the error itself still surfaces via
   * run-node's catch as `node-crash`, but without this log the decorator's
   * accounting contract would be skipped silently (no `llm.call-failed` line,
   * nothing metered — consumption for a throwing call is unknowable). Log with
   * `errorKind: "thrown"` and rethrow; the `finally` still releases the
   * reservation either way.
   */
  const logThrown = (nodeId: NodeId, operation: Operation, e: unknown): void => {
    logWithoutThrowing(logger, "warn", "llm.call-failed", {
      ...attribution(nodeId),
      operation,
      errorKind: "thrown",
      message: safeErrorMessage(e),
    });
  };

  /**
   * The whole accounting contract, once.
   *
   * Both public methods differ only in which inner function they invoke; every
   * accounting step — admit, settle, log-on-throw, release — is identical. They
   * used to be two copies of that sequence, which was survivable when the
   * sequence was four lines and is not now that each path must additionally
   * price the response and evaluate several ceilings. One copy means the two
   * operations cannot drift into disagreeing about what gets metered.
   */
  const metered = async <O>(
    operation: Operation,
    req: MeteredRequest,
    call: () => Promise<Result<LlmResponse<O>, FrameworkError>>,
  ): Promise<Result<LlmResponse<O>, FrameworkError>> => {
    const admission = gate(req.nodeId);
    if ("error" in admission) return err(admission.error);
    try {
      return await settle(req, operation, await call());
    } catch (e) {
      logThrown(req.nodeId, operation, e);
      throw e;
    } finally {
      admission.release();
    }
  };

  return {
    sendStructured: <O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> =>
      metered("sendStructured", req, () => inner.sendStructured(req)),

    sendWithTools: <O>(
      req: SendWithToolsRequest<O>,
      ctx: NodeContext,
    ): Promise<Result<LlmResponse<O>, FrameworkError>> =>
      metered("sendWithTools", req, () => inner.sendWithTools(req, ctx)),
  };
};
