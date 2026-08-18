/**
 * Production RunExecutor (ADR-0060) — bridges the HITL service to the framework
 * runtime and the host NodeContext. Mirrors the synchronous `run-dag` HTTP
 * handler's execution wiring (`createNodeContextForDag` + per-node minting), but
 * drives the RESUMABLE kernel entry (`runResumableDagJob`) over a durable,
 * run-store-backed `jobLike` so a run can park and resume.
 *
 * `run` never throws: a framework run-failure (including an abort/timeout of an
 * execution slice) is mapped onto the `failed` outcome; only an unknown DAG uses
 * the `err` channel.
 */

import { runResumableDagJob, ok, err, EXECUTOR_NODE_ID } from "@fuguejs/framework";
import type {
  Result,
  FrameworkError,
  CapabilityBroker,
} from "@fuguejs/framework";
import { compileDagToMachine, stripNonPersistable } from "@fuguejs/framework/advanced";
import { toJson } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { SharedInfra, LogPort } from "../../ports.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { createNodeContextForDag } from "../../adapters/node-context-factory.js";
import type { AgentClientMap } from "../../domain/auth.js";
import type { TenantId } from "../../domain/tenant.js";
import type { RunExecutorPort, RunExecOutcome, RunExecutionRequest } from "../ports.js";
import { toExecIdentity } from "../identity.js";

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
  readonly logger?: LogPort;
}

const toFrameworkError = (e: unknown): FrameworkError => {
  const cause = (e as { cause?: FrameworkError }).cause;
  if (cause && typeof cause === "object" && "kind" in cause) return cause;
  return {
    kind: "node-crash",
    retriability: "retriable",
    nodeId: EXECUTOR_NODE_ID,
    message: e instanceof Error ? e.message : String(e),
  };
};

export const createRunExecutor = (deps: RunExecutorDeps): RunExecutorPort => {
  const { sharedInfra, getRegisteredDag, broker, agentClientMap, tenant, logger } = deps;

  return {
    async seedCheckpoint(dagId, input): Promise<Result<string, HostError>> {
      const registered = getRegisteredDag(dagId);
      if (!registered) return err({ kind: "dag-not-found", dagId, available: [] });
      const compiled = compileDagToMachine(registered.dag, input);
      if (!compiled.ok) {
        // A compile failure (cycle) is a registration/authoring defect.
        return err({ kind: "dag-validation-failed", dagId, reason: compiled.error.kind, message: `compile failed: ${compiled.error.kind}` });
      }
      const persisted = stripNonPersistable(compiled.value.initialContext);
      return ok(toJson({ state: compiled.value.initialState, context: persisted }));
    },

    async run(req: RunExecutionRequest): Promise<Result<RunExecOutcome, HostError>> {
      const registered = getRegisteredDag(req.dagId);
      if (!registered) return err({ kind: "dag-not-found", dagId: req.dagId, available: [] });

      // One execution slice runs from resume to the next gate/terminal — bounded
      // compute. Apply the DAG's configured timeout to the slice (the human wait
      // happens BETWEEN slices, while parked, and is not bounded by this).
      const controller = new AbortController();
      const SLICE_TIMEOUT = Symbol("hitl-slice-timeout");
      const timeoutId = setTimeout(() => controller.abort(SLICE_TIMEOUT), registered.config.timeout);

      try {
        const { ctx, origin } = await createNodeContextForDag(
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
        );

        const outcome = await runResumableDagJob<unknown, unknown>(registered.dag, req.input, ctx, {
          jobLike: req.jobLike,
          onHumanReview: req.onHumanReview,
          onDecisionConsumed: req.onDecisionConsumed,
          ...(broker !== undefined && origin !== undefined ? { minting: { broker, origin } } : {}),
        });

        if (outcome.kind === "suspended") {
          return ok({ kind: "suspended", nodeId: outcome.nodeId, prompt: outcome.prompt });
        }
        return ok({ kind: "completed", output: outcome.output });
      } catch (e) {
        // runResumableDagJob throws on a genuine run failure (incl. abort). Map
        // to the `failed` outcome so the service settles the run, not the err
        // channel (which is reserved for host infra faults like unknown DAG).
        logger?.warn?.("hitl: run slice failed", { runId: req.runId, dagId: req.dagId });
        return ok({ kind: "failed", error: toFrameworkError(e) });
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
};
