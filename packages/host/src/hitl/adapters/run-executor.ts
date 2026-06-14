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
import type { RunExecutorPort, RunExecOutcome, RunExecutionRequest } from "../ports.js";
import { toExecIdentity } from "../identity.js";

export interface RunExecutorDeps {
  readonly sharedInfra: SharedInfra;
  /** Look up the currently-registered DAG (registry changes on git sync). */
  readonly getRegisteredDag: (dagId: string) => RegisteredDag | undefined;
  /** Boot-selected per-node minting broker (undefined when no realm is configured). */
  readonly broker?: CapabilityBroker;
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
  const { sharedInfra, getRegisteredDag, broker, logger } = deps;

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
        );

        const outcome = await runResumableDagJob<unknown, unknown>(registered.dag, req.input, ctx, {
          jobLike: req.jobLike,
          onHumanReview: req.onHumanReview,
          ...(broker !== undefined ? { minting: { broker, origin } } : {}),
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
