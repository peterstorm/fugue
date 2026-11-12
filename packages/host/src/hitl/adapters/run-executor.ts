/**
 * Production RunExecutor (ADR-0060) — bridges the HITL service to the framework
 * runtime and the host NodeContext. Mirrors the synchronous `run-dag` HTTP
 * handler's execution wiring (`createNodeContextForDag` + per-node minting), but
 * drives the RESUMABLE kernel entry (`runResumableDagJob`) over a durable,
 * run-store-backed `jobLike` so a run can park and resume.
 *
 * `run` never throws: a framework run-failure (including an abort/timeout of an
 * execution slice or a DAG removed after durable acceptance) is mapped onto the
 * `failed` outcome. A post-transition checkpoint failure also fails the run
 * closed: retrying from the prior checkpoint could replay already-completed
 * side effects or a consumed human decision. A CONTEXT-BUILD fault (host wiring: invalid tenant team, FR-040 unmapped agent
 * client) is logged at `error` with the actual message and settles as the
 * `failed` outcome — NOT `err` — so the recorded `FrameworkError` keeps the
 * factory's descriptive message (the service's `err`→run-failure mapping would
 * drop it).
 */

import { asNonEmptyString, runResumableDagJob, ok, err, EXECUTOR_NODE_ID, asFrameworkError, safeErrorMessage, fanConcurrencyCap } from "@fuguejs/framework";
import type {
  Result,
  FrameworkError,
  CapabilityBroker,
  JobLike,
  FanConcurrencyCap,
  RunOptions,
  DagPhase,
  DagMachineContextPersisted,
} from "@fuguejs/framework";
import { compileDagToMachine, persistDagContext } from "@fuguejs/framework/advanced";
import type { WorkerJobOutcome } from "@fuguejs/framework/advanced";
import { toJson } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { formatHostError } from "../../domain/host-error.js";
import type { SharedInfra, LogPort } from "../../ports.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { createNodeContextForDag } from "../../adapters/node-context-factory.js";
import type { AgentClientMap } from "../../domain/auth.js";
import type { TenantId } from "../../domain/tenant.js";
import type { RunExecutorPort, RunExecOutcome, RunExecutionRequest, RunExecutionJob } from "../ports.js";
import { toExecIdentity } from "../identity.js";
import { logWithoutThrowing } from "../diagnostic-logging.js";
import { settleBeforeDeadline } from "../../adapters/settle-before-deadline.js";
import type { DeadlineDiagnostics } from "../../adapters/settle-before-deadline.js";

const deadlineFencedJob = <S, E, C>(
  job: JobLike<S, E, C>,
  assertAuthorized: () => void,
): JobLike<S, E, C> => ({
  get data() {
    return job.data;
  },
  updateData: async (data) => {
    assertAuthorized();
    await job.updateData(data);
  },
  updateProgress: async (progress) => {
    assertAuthorized();
    await job.updateProgress(progress);
  },
  appendEvent: async (event, dedupKey) => {
    assertAuthorized();
    await job.appendEvent(event, dedupKey);
  },
});

interface RunExecutorDeps {
  readonly sharedInfra: SharedInfra;
  /** Look up the currently-registered DAG (registry changes on git sync). */
  readonly getRegisteredDag: (dagId: string) => RegisteredDag | undefined;
  /** Boot-selected per-node minting broker (undefined when no realm is configured). */
  readonly broker?: CapabilityBroker;
  /**
   * DAG-id → REAL Keycloak agent-client-id map (`AGENT_CLIENT_MAP`, FR-040),
   * threaded into `createNodeContextForDag` so a resumed HITL run resolves the
   * SAME agent client the initiating request would have. An unmapped DAG id
   * fails closed (the slice fails) — parity with the synchronous run path.
   */
  readonly agentClientMap?: AgentClientMap;
  /**
   * The worker's resolved routed `Tenant.id` (FR-013 / SC-001 / ADR-0067),
   * threaded into `createNodeContextForDag` so a resumed HITL run's cache /
   * checkpoint keys share the SAME `fugue:<tenant>:` namespace as the
   * synchronous run path and every other per-tenant store. Optional on the type,
   * but `host.ts` — the only caller that wires this executor — always passes a
   * resolved `Tenant.id`, falling back to the constant `default` rather than to
   * absence, so the shipped single-tenant path does NOT omit it. (The genuinely
   * omittable one is `createNodeContextForDag`'s `routedTenant`, which does fall
   * back to the `dag.team` derivation.)
   */
  readonly tenant?: TenantId;
  /** TTL of the durable HITL run record this slice may resume from. */
  readonly runRetentionTtlSec?: number;
  /**
   * REQUIRED host-wide operator ceiling on map-fan child concurrency (FR-030,
   * AD-8). The host composition (host.ts) supplies it from the validated
   * `config.FAN_CHILD_CONCURRENCY_MAX` integer, whose own default (8) lives in
   * host config — so the executor can never silently run without the
   * operator's setting. It stays PLAIN here (the host-config contract): this
   * executor brands it ONCE at composition with the framework's
   * `fanConcurrencyCap` smart constructor — whose throw on a non-positive
   * integer is a composition-time failure, so an invalid setting can never
   * reach a run (FR-032) — and threads the branded value into every
   * `runResumableDagJob` slice as `opts.fanConcurrencyCap`. Operator
   * configuration applied to EVERY run; never a per-run or per-tenant input
   * (FR-034, OOS-009).
   */
  readonly fanChildConcurrencyMax: number;
  readonly logger?: LogPort;
}

/** The executor's composition: its deps plus the operator fan cap, branded once. */
interface ExecutorComposition extends RunExecutorDeps {
  readonly fanCap: FanConcurrencyCap;
}

/** Every diagnostic from one slice is attributed to the same run. */
type SliceAttribution = Pick<RunExecutionRequest, "runId" | "dagId">;

/**
 * `setup` = execution-fence/context build (host wiring), `execution` = the
 * kernel slice. Both settle as the `failed` outcome, but a setup fault is a
 * PERMANENT host-wiring condition (invalid tenant team, FR-040 unmapped agent
 * client) — not an in-DAG node crash — so the two phases log as different
 * events, at ERROR with the actual message: neither may be a silent,
 * detail-less warn.
 */
type SlicePhase = "setup" | "execution";

type SliceJob = JobLike<DagPhase, unknown, DagMachineContextPersisted>;

const frameworkCauseOf = (error: unknown): FrameworkError | null => {
  if (!((typeof error === "object" && error !== null) || typeof error === "function")) return null;
  try {
    // Recover the CANONICAL error rather than narrowing the attached cause: a
    // cause rehydrated from a durable HITL record may carry a pre-prompt-caching
    // `usage`, which `isFrameworkError` deliberately declines to narrow. Falling
    // back to the generic node-crash below would erase its kind/retriability.
    return asFrameworkError(Reflect.get(error, "cause")) ?? null;
  } catch {
    return null;
  }
};

const toFrameworkError = (error: unknown): FrameworkError =>
  frameworkCauseOf(error) ?? {
    kind: "node-crash",
    retriability: "retriable",
    nodeId: EXECUTOR_NODE_ID,
    message: safeErrorMessage(error),
  };

const checkpointWriteFailure = (failure: HostError): FrameworkError => ({
  kind: "node-crash",
  retriability: "non-retriable",
  nodeId: EXECUTOR_NODE_ID,
  message: `checkpoint persistence failed after execution advanced; run stopped to avoid replaying side effects: ${formatHostError(failure)}`,
});

/**
 * FR-030 / AD-8: brand the operator cap ONCE at the configuration boundary.
 * The smart constructor throws on a non-positive-integer (INV-3: never an `as`
 * cast outside `types/fan-scheduling.ts`), so an invalid setting can never
 * reach a run; host config validation (T4) has already accepted the env string
 * as a positive safe integer.
 */
const brandOperatorFanCap = (max: number): FanConcurrencyCap => fanConcurrencyCap(max);

const seedRunCheckpoint = (
  registered: RegisteredDag | undefined,
  dagId: RunExecutionRequest["dagId"],
  input: unknown,
): Result<string, HostError> => {
  if (!registered) return err({ kind: "dag-not-found", dagId, available: [] });
  const compiled = compileDagToMachine(registered.dag, input);
  if (!compiled.ok) {
    // A compile failure (cycle) is a registration/authoring defect.
    return err({ kind: "dag-validation-failed", dagId, reason: compiled.error.kind, message: `compile failed: ${compiled.error.kind}` });
  }
  const persisted = persistDagContext(compiled.value.initialContext, registered.dag);
  return ok(toJson({ state: compiled.value.initialState, context: persisted }));
};

/**
 * The DAG existed when seedCheckpoint accepted this durable run but was removed
 * by a later registry sync. Retrying cannot restore registry intent, so settle
 * the run instead of leaving it active forever.
 */
const dagNoLongerRegistered = (dagId: string): RunExecOutcome => ({
  kind: "failed",
  error: {
    kind: "node-crash",
    retriability: "non-retriable",
    nodeId: EXECUTOR_NODE_ID,
    message: `DAG '${dagId}' is no longer registered`,
  },
});

/**
 * The cancellation + durable-write fence of one execution slice. The slice's
 * signal aborts on queue lease loss or at the deadline; once expired, every
 * durable write through the fenced job is refused.
 */
interface SliceFence {
  readonly signal: AbortSignal;
  readonly assertAuthorized: () => void;
  /** Deadline reached: revoke durable-write authority and abort the slice. */
  readonly expire: () => void;
  /** Detach the lease-loss listener once the slice has settled. */
  readonly release: () => void;
}

const openSliceFence = (leaseSignal: AbortSignal): SliceFence => {
  const controller = new AbortController();
  const abortForLeaseLoss = (): void => controller.abort(leaseSignal.reason);
  if (leaseSignal.aborted) abortForLeaseLoss();
  else leaseSignal.addEventListener("abort", abortForLeaseLoss, { once: true });
  const SLICE_TIMEOUT = Symbol("hitl-slice-timeout");
  let executionAuthorized = true;
  return {
    signal: controller.signal,
    assertAuthorized: () => {
      if (!executionAuthorized) {
        throw new Error("HITL execution slice attempted durable work after its deadline");
      }
    },
    expire: () => {
      executionAuthorized = false;
      controller.abort(SLICE_TIMEOUT);
    },
    release: () => leaseSignal.removeEventListener("abort", abortForLeaseLoss),
  };
};

/**
 * The kernel options of one slice; human-gate hooks stay behind the fence.
 * Exported so a unit test can assert the operator fan cap is forwarded.
 */
export const sliceRunOptions = (
  composition: ExecutorComposition,
  req: RunExecutionRequest,
  job: SliceJob,
  fence: SliceFence,
  minting: RunOptions["minting"],
): RunOptions => ({
  jobLike: job,
  // Operator fan cap (FR-030, FR-034): one host-wide value, branded at
  // composition and applied to EVERY run — never a per-run API.
  fanConcurrencyCap: composition.fanCap,
  onHumanReview: async (review) => {
    fence.assertAuthorized();
    return req.onHumanReview(review);
  },
  onDecisionConsumed: async (nodeId) => {
    fence.assertAuthorized();
    await req.onDecisionConsumed(nodeId);
  },
  ...(minting !== undefined ? { minting } : {}),
});

/** Build the slice's NodeContext (setup), then run the resumable kernel (execution). */
const executeSlice = async (
  composition: ExecutorComposition,
  registered: RegisteredDag,
  req: RunExecutionRequest,
  job: SliceJob,
  fence: SliceFence,
  markExecuting: () => void,
): Promise<WorkerJobOutcome<unknown>> => {
  const { broker } = composition;
  const { ctx, origin, meterMintedLlm } = await createNodeContextForDag(
    composition.sharedInfra,
    registered,
    req.runId,
    fence.signal,
    toExecIdentity(req.identity),
    {
      // `?? {}` would be dead: an absent field takes the factory's own
      // documented default of the empty map.
      agentClientMap: composition.agentClientMap,
      mintingActive: broker !== undefined,
      // `bindSubjectToken` is intentionally ABSENT on the resume path. A
      // user run's verified `subject_token` is bound at INITIATION (the
      // sync path); across a HITL park/resume it is not re-presented, so
      // a user-path capability mint fails closed (no proof) rather than
      // reusing a stale token — correct, not a leak. Named fields let
      // this be an omission rather than a positional `undefined` a
      // reader has to count arguments to identify.
      routedTenant: composition.tenant,
      resumableRunTtlSec: composition.runRetentionTtlSec,
    },
  );
  markExecuting();
  const minting = broker !== undefined && origin !== undefined
    ? { broker, origin, meterLlm: meterMintedLlm }
    : undefined;
  return runResumableDagJob<unknown, unknown>(
    registered.dag,
    req.input,
    ctx,
    sliceRunOptions(composition, req, job, fence, minting),
  );
};

/** A slice that settles after its deadline is reported, never reinstated. */
const lateSliceDiagnostics = (
  logger: LogPort | undefined,
  attribution: SliceAttribution,
): DeadlineDiagnostics<WorkerJobOutcome<unknown>> => ({
  onLateFulfillment: (outcome) => logWithoutThrowing(
    logger,
    "error",
    "hitl: run slice settled after its deadline",
    { ...attribution, outcome: outcome.kind },
  ),
  onLateRejection: (error) => logWithoutThrowing(
    logger,
    "error",
    "hitl: run slice rejected after its deadline",
    { ...attribution, error: safeErrorMessage(error) },
  ),
  onTimeoutCancellationFailure: (error) => logWithoutThrowing(
    logger,
    "error",
    "hitl: run slice timeout cancellation failed",
    { ...attribution, error: safeErrorMessage(error) },
  ),
});

const sliceTimedOut = (
  timeoutMs: number,
  logger: LogPort | undefined,
  attribution: SliceAttribution,
): RunExecOutcome => {
  const error: FrameworkError = {
    kind: "aborted",
    reason: `execution slice timed out after ${timeoutMs}ms`,
  };
  logWithoutThrowing(logger, "error", "hitl: run slice timed out", { ...attribution, timeoutMs });
  return { kind: "failed", error };
};

/** Throws on an empty review prompt; the caller's failure boundary settles it. */
const toSettledOutcome = (outcome: WorkerJobOutcome<unknown>): RunExecOutcome => {
  if (outcome.kind === "suspended") {
    const prompt = asNonEmptyString(outcome.prompt);
    if (prompt === undefined) {
      throw new Error(`run suspended at '${outcome.nodeId}' with an empty review prompt`);
    }
    return { kind: "suspended", nodeId: outcome.nodeId, prompt };
  }
  return { kind: "completed", output: outcome.output };
};

/**
 * A failed slice whose durable checkpoint write also failed (or whose
 * checkpoint state cannot be inspected) fails closed; `null` when the
 * checkpoint channel is clean.
 */
const checkpointFailClosed = (
  sliceError: unknown,
  job: RunExecutionJob,
  logger: LogPort | undefined,
  attribution: SliceAttribution,
): RunExecOutcome | null => {
  let checkpointFailure: HostError | null;
  try {
    checkpointFailure = job.checkpointFailure();
  } catch (inspectionError) {
    const error: FrameworkError = {
      kind: "node-crash",
      retriability: "non-retriable",
      nodeId: EXECUTOR_NODE_ID,
      message:
        `run slice failed: ${safeErrorMessage(sliceError)}; ` +
        `checkpoint failure inspection also failed: ${safeErrorMessage(inspectionError)}`,
    };
    logWithoutThrowing(
      logger,
      "error",
      "hitl: run slice and checkpoint failure inspection both failed — failing closed",
      { ...attribution, error: error.message },
    );
    return { kind: "failed", error };
  }
  if (checkpointFailure === null) return null;
  logWithoutThrowing(
    logger,
    "error",
    "hitl: checkpoint persistence failed — failing run closed to avoid replay",
    { ...attribution, error: checkpointFailure.kind },
  );
  return { kind: "failed", error: checkpointWriteFailure(checkpointFailure) };
};

/**
 * Setup phase: a host wiring fault (the factory's fail-closed throws).
 * Execution phase: runResumableDagJob threw on a genuine run failure (incl.
 * abort). Checkpoint infrastructure failures fail closed first; all remaining
 * throws become a terminal failed outcome with the original diagnostic and are
 * logged at error with the message: the recorded FrameworkError carries that
 * message as the operator's durable diagnostic.
 */
const settleSliceFailure = (
  sliceError: unknown,
  job: RunExecutionJob,
  phase: SlicePhase,
  logger: LogPort | undefined,
  attribution: SliceAttribution,
): RunExecOutcome => {
  const closed = checkpointFailClosed(sliceError, job, logger, attribution);
  if (closed !== null) return closed;
  logWithoutThrowing(
    logger,
    "error",
    phase === "setup" ? "hitl: run slice setup failed" : "hitl: run slice failed",
    { ...attribution, error: safeErrorMessage(sliceError) },
  );
  return { kind: "failed", error: toFrameworkError(sliceError) };
};

/**
 * One execution slice runs from resume to the next gate/terminal — bounded
 * compute. The DAG's configured timeout bounds the slice (the human wait
 * happens BETWEEN slices, while parked, and is not bounded by this).
 */
const runSlice = async (
  composition: ExecutorComposition,
  req: RunExecutionRequest,
): Promise<Result<RunExecOutcome, HostError>> => {
  const attribution: SliceAttribution = { runId: req.runId, dagId: req.dagId };
  const registered = composition.getRegisteredDag(req.dagId);
  if (!registered) return ok(dagNoLongerRegistered(req.dagId));

  const { logger } = composition;
  const timeoutMs = registered.config.timeout;
  const fence = openSliceFence(req.signal);
  let phase: SlicePhase = "setup";
  try {
    // JobLike is an external shell port. Keep both its typed Err and any
    // contract-violating throw inside run's never-throw boundary.
    const startedJob = await req.job.startSlice(timeoutMs);
    if (!startedJob.ok) return err(startedJob.error);
    const fencedJob = deadlineFencedJob(startedJob.value, fence.assertAuthorized);
    const slice = executeSlice(composition, registered, req, fencedJob, fence, () => {
      phase = "execution";
    });
    const completion = await settleBeforeDeadline(
      slice,
      timeoutMs,
      fence.expire,
      lateSliceDiagnostics(logger, attribution),
    );
    if (completion.kind === "timed-out") return ok(sliceTimedOut(timeoutMs, logger, attribution));
    return ok(toSettledOutcome(completion.value));
  } catch (e) {
    return ok(settleSliceFailure(e, req.job, phase, logger, attribution));
  } finally {
    fence.release();
  }
};

export const createRunExecutor = (deps: RunExecutorDeps): RunExecutorPort => {
  const composition: ExecutorComposition = {
    ...deps,
    fanCap: brandOperatorFanCap(deps.fanChildConcurrencyMax),
  };
  return {
    seedCheckpoint: async (dagId, input) =>
      seedRunCheckpoint(deps.getRegisteredDag(dagId), dagId, input),
    run: (req) => runSlice(composition, req),
  };
};
