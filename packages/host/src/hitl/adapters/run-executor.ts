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

import { asNonEmptyString, runResumableDagJob, ok, err, EXECUTOR_NODE_ID, isFrameworkError, safeErrorMessage } from "@fuguejs/framework";
import type {
  Result,
  FrameworkError,
  CapabilityBroker,
  JobLike,
} from "@fuguejs/framework";
import { compileDagToMachine, persistDagContext } from "@fuguejs/framework/advanced";
import { toJson } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { formatHostError } from "../../domain/host-error.js";
import type { SharedInfra, LogPort } from "../../ports.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { createNodeContextForDag } from "../../adapters/node-context-factory.js";
import type { AgentClientMap } from "../../domain/auth.js";
import type { TenantId } from "../../domain/tenant.js";
import type { RunExecutorPort, RunExecOutcome, RunExecutionRequest } from "../ports.js";
import { toExecIdentity } from "../identity.js";
import { logWithoutThrowing } from "../diagnostic-logging.js";
import { settleBeforeDeadline } from "../../adapters/settle-before-deadline.js";

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
   * synchronous run path and every other per-tenant store. Omitted on the
   * single-tenant path (the factory then falls back to the `dag.team` derivation).
   */
  readonly tenant?: TenantId;
  /** TTL of the durable HITL run record this slice may resume from. */
  readonly runRetentionTtlSec?: number;
  readonly logger?: LogPort;
}

const frameworkCauseOf = (error: unknown): FrameworkError | null => {
  if (!((typeof error === "object" && error !== null) || typeof error === "function")) return null;
  try {
    const cause = Reflect.get(error, "cause");
    return isFrameworkError(cause) ? cause : null;
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

export const createRunExecutor = (deps: RunExecutorDeps): RunExecutorPort => {
  const {
    sharedInfra,
    getRegisteredDag,
    broker,
    agentClientMap,
    tenant,
    runRetentionTtlSec,
    logger,
  } = deps;

  return {
    async seedCheckpoint(dagId, input): Promise<Result<string, HostError>> {
      const registered = getRegisteredDag(dagId);
      if (!registered) return err({ kind: "dag-not-found", dagId, available: [] });
      const compiled = compileDagToMachine(registered.dag, input);
      if (!compiled.ok) {
        // A compile failure (cycle) is a registration/authoring defect.
        return err({ kind: "dag-validation-failed", dagId, reason: compiled.error.kind, message: `compile failed: ${compiled.error.kind}` });
      }
      const persisted = persistDagContext(compiled.value.initialContext, registered.dag);
      return ok(toJson({ state: compiled.value.initialState, context: persisted }));
    },

    async run(req: RunExecutionRequest): Promise<Result<RunExecOutcome, HostError>> {
      // Every diagnostic from this slice is attributed to the same run; naming
      // it once keeps a later log line from silently omitting half the pair.
      const attribution = { runId: req.runId, dagId: req.dagId } as const;
      const registered = getRegisteredDag(req.dagId);
      if (!registered) {
        // The DAG existed when seedCheckpoint accepted this durable run but was
        // removed by a later registry sync. Retrying cannot restore registry
        // intent, so settle the run instead of leaving it active forever.
        return ok({
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: EXECUTOR_NODE_ID,
            message: `DAG '${req.dagId}' is no longer registered`,
          },
        });
      }

      // One execution slice runs from resume to the next gate/terminal — bounded
      // compute. Apply the DAG's configured timeout to the slice (the human wait
      // happens BETWEEN slices, while parked, and is not bounded by this).
      const controller = new AbortController();
      const abortForLeaseLoss = (): void => controller.abort(req.signal.reason);
      if (req.signal.aborted) abortForLeaseLoss();
      else req.signal.addEventListener("abort", abortForLeaseLoss, { once: true });
      const SLICE_TIMEOUT = Symbol("hitl-slice-timeout");
      let executionAuthorized = true;
      const assertExecutionAuthorized = (): void => {
        if (!executionAuthorized) {
          throw new Error("HITL execution slice attempted durable work after its deadline");
        }
      };
      // `setup` = execution-fence/context build (host wiring), `execution` =
      // the kernel slice. Both settle as the `failed` outcome below, but a setup
      // fault is a PERMANENT host-wiring condition (invalid tenant team, FR-040
      // unmapped agent client) — not an in-DAG node crash — so the two phases
      // log as different events, at ERROR with the actual message: neither may
      // be a silent, detail-less warn.
      let phase: "setup" | "execution" = "setup";

      try {
        // JobLike is an external shell port. Keep both its typed Err and any
        // contract-violating throw inside run's never-throw boundary.
        const startedJob = await req.job.startSlice(registered.config.timeout);
        if (!startedJob.ok) return err(startedJob.error);
        const fencedJob = deadlineFencedJob(startedJob.value, assertExecutionAuthorized);
        const slice = (async () => {
          const { ctx, origin, meterMintedLlm } = await createNodeContextForDag(
            sharedInfra,
            registered,
            req.runId,
            controller.signal,
            toExecIdentity(req.identity),
            agentClientMap ?? {},
            broker !== undefined,
            // bindSubjectToken: intentionally omitted on the resume path. A user
            // run's verified `subject_token` is bound at INITIATION (sync path);
            // across a HITL park/resume it is not re-presented, so a user-path
            // capability mint fails closed (no proof) rather than reusing a stale
            // token — correct, not a leak.
            undefined,
            tenant,
            runRetentionTtlSec,
          );
          phase = "execution";

          return runResumableDagJob<unknown, unknown>(registered.dag, req.input, ctx, {
            jobLike: fencedJob,
            onHumanReview: async (review) => {
              assertExecutionAuthorized();
              return req.onHumanReview(review);
            },
            onDecisionConsumed: async (nodeId) => {
              assertExecutionAuthorized();
              await req.onDecisionConsumed(nodeId);
            },
            ...(broker !== undefined && origin !== undefined
              ? { minting: { broker, origin, meterLlm: meterMintedLlm } }
              : {}),
          });
        })();

        const completion = await settleBeforeDeadline(
          slice,
          registered.config.timeout,
          () => {
            executionAuthorized = false;
            controller.abort(SLICE_TIMEOUT);
          },
          {
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
          },
        );
        if (completion.kind === "timed-out") {
          const error: FrameworkError = {
            kind: "aborted",
            reason: `execution slice timed out after ${registered.config.timeout}ms`,
          };
          logWithoutThrowing(logger, "error", "hitl: run slice timed out", {
            runId: req.runId,
            dagId: req.dagId,
            timeoutMs: registered.config.timeout,
          });
          return ok({ kind: "failed", error });
        }

        const outcome = completion.value;
        if (outcome.kind === "suspended") {
          const prompt = asNonEmptyString(outcome.prompt);
          if (prompt === undefined) {
            throw new Error(`run suspended at '${outcome.nodeId}' with an empty review prompt`);
          }
          return ok({ kind: "suspended", nodeId: outcome.nodeId, prompt });
        }
        return ok({ kind: "completed", output: outcome.output });
      } catch (e) {
        let checkpointFailure: HostError | null;
        try {
          checkpointFailure = req.job.checkpointFailure();
        } catch (inspectionError) {
          const error: FrameworkError = {
            kind: "node-crash",
            retriability: "non-retriable",
            nodeId: EXECUTOR_NODE_ID,
            message:
              `run slice failed: ${safeErrorMessage(e)}; ` +
              `checkpoint failure inspection also failed: ${safeErrorMessage(inspectionError)}`,
          };
          logWithoutThrowing(
            logger,
            "error",
            "hitl: run slice and checkpoint failure inspection both failed — failing closed",
            { ...attribution, error: error.message },
          );
          return ok({ kind: "failed", error });
        }
        if (checkpointFailure !== null) {
          logWithoutThrowing(
            logger,
            "error",
            "hitl: checkpoint persistence failed — failing run closed to avoid replay",
            { ...attribution, error: checkpointFailure.kind },
          );
          return ok({ kind: "failed", error: checkpointWriteFailure(checkpointFailure) });
        }

        // Setup phase: a host wiring fault (the factory's fail-closed throws).
        // Execution phase: runResumableDagJob threw on a genuine run failure
        // (incl. abort). Checkpoint infrastructure failures returned above are
        // the exception; all remaining throws become a terminal failed outcome
        // with the original diagnostic and are logged at error
        // with the message: the recorded FrameworkError below carries that
        // message as the operator's durable diagnostic.
        logWithoutThrowing(
          logger,
          "error",
          phase === "setup" ? "hitl: run slice setup failed" : "hitl: run slice failed",
          { ...attribution, error: safeErrorMessage(e) },
        );
        return ok({ kind: "failed", error: toFrameworkError(e) });
      } finally {
        req.signal.removeEventListener("abort", abortForLeaseLoss);
      }
    },
  };
};
