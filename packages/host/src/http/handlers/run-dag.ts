/**
 * Run DAG handler — POST /dags/:id/run
 *
 * FR-020: Executes DAG and returns result as JSON with 200
 * FR-023: Invalid input returns 400 with machine-readable JSON describing failed fields
 * FR-024: DAG timeout returns 408 with run ID for resumption
 * FR-025: Non-existent DAG returns 404 with available DAG IDs listed
 * FR-027: Per-DAG concurrency limit exceeded returns 429
 */

import type { Context } from "hono";
import type { DagId, Result, NodeContext, FrameworkError } from "@fugue/framework";
import { formatFrameworkError } from "@fugue/framework";
import type { DagDef, RunOptions } from "@fugue/framework";
import type { HostEnv } from "../router.js";
import { errorResponse, successResponse } from "../response.js";
import type { HostError } from "../../domain/host-error.js";
import { formatHostError } from "../../domain/host-error.js";
import { canServeRequests, getRegistry } from "../../domain/host-state.js";
import { lookupDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { acquire, release } from "../../domain/concurrency.js";
import type { ConcurrencyState, AcquireToken } from "../../domain/concurrency.js";
import { isAllowed, recordSuccess, recordFailure, attemptReset, consumeTestRequest } from "../../domain/circuit-breaker.js";
import type { CircuitState } from "../../domain/circuit-breaker.js";

// ---------------------------------------------------------------------------
// Types for the handler's dependencies (injectable for testing)
// ---------------------------------------------------------------------------

export interface RunDagDeps {
  readonly getConcurrency: () => ConcurrencyState;
  readonly setConcurrency: (s: ConcurrencyState) => void;
  readonly getCircuit: (dagId: DagId) => CircuitState;
  readonly setCircuit: (dagId: DagId, s: CircuitState) => void;
  readonly createContext: (registered: RegisteredDag, signal?: AbortSignal) => NodeContext;
  readonly executeDag: <I, O>(dag: DagDef, input: I, ctx: NodeContext, opts?: RunOptions) => Promise<Result<O, FrameworkError>>;
  readonly clock: () => number;
}

/**
 * Creates the run-dag handler with injected dependencies.
 */
export const createRunDagHandler = (deps: RunDagDeps) => {
  return async (c: Context<HostEnv>): Promise<Response> => {
    const dagId = c.req.param("id") as DagId;
    const hostState = c.get("hostState");

    // 1. Reject if host cannot serve requests (booting, draining, stopped)
    if (!canServeRequests(hostState)) {
      return errorResponse(c, 503, "host-unavailable", `Host is ${hostState.phase} — not accepting requests`, {
        details: { phase: hostState.phase },
      });
    }

    const registry = getRegistry(hostState);
    if (!registry) {
      const notFound: HostError = { kind: "dag-not-found", dagId, available: [] };
      return errorResponse(c, 404, notFound.kind, formatHostError(notFound), {
        dagId,
        details: { available: [] },
      });
    }

    const registered = lookupDag(registry, dagId);
    if (!registered) {
      const available = Array.from(registry.dags.keys());
      const notFound: HostError = { kind: "dag-not-found", dagId, available };
      return errorResponse(c, 404, notFound.kind, formatHostError(notFound), {
        dagId,
        details: { available },
      });
    }

    // Check if DAG is disabled
    if (!registered.healthy && registered.disabledReason) {
      const disabled: HostError = { kind: "dag-disabled", dagId, reason: registered.disabledReason };
      return errorResponse(c, 503, disabled.kind, formatHostError(disabled), { dagId });
    }

    // 2. Parse and validate input
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      // Synthetic Zod issue — not from parser, so we construct the shape manually
      const syntheticIssue = { message: "Request body must be valid JSON", path: [], code: "custom" } as unknown as import("zod").core.$ZodIssue;
      const validationErr: HostError = {
        kind: "input-validation-failed",
        dagId,
        issues: [syntheticIssue],
      };
      return errorResponse(c, 400, validationErr.kind, "Request body must be valid JSON", {
        dagId,
        details: { issues: [{ message: "Request body must be valid JSON", path: [] }] },
      });
    }

    const parseResult = registered.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const issues = parseResult.error?.issues ?? [];
      const validationErr: HostError = { kind: "input-validation-failed", dagId, issues };
      return errorResponse(c, 400, validationErr.kind, formatHostError(validationErr), {
        dagId,
        details: { issues },
      });
    }

    // 3. Check circuit breaker state
    const now = deps.clock();
    let circuit = deps.getCircuit(dagId);

    // Try reset if open
    circuit = attemptReset(circuit, now);
    deps.setCircuit(dagId, circuit);

    if (!isAllowed(circuit)) {
      return errorResponse(c, 503, "dag-disabled", `Circuit breaker open for DAG '${dagId}'`, {
        dagId,
      });
    }

    // Consume test request in half-open
    if (circuit.state === "half-open") {
      circuit = consumeTestRequest(circuit);
      deps.setCircuit(dagId, circuit);
    }

    // 4. Acquire per-DAG concurrency token
    const concurrency = deps.getConcurrency();
    const acquireResult = acquire(concurrency, dagId, now);

    if (!acquireResult.ok) {
      const scope = acquireResult.error === "global-at-capacity" ? "global" : "dag";
      const concErr: HostError = { kind: "concurrency-exceeded", scope, dagId };
      return errorResponse(c, 429, concErr.kind, formatHostError(concErr), {
        dagId,
        details: { scope },
        headers: { "Retry-After": "5" },
      });
    }

    deps.setConcurrency(acquireResult.value.state);
    const token = acquireResult.value.token;

    // 5. Execute DAG with timeout
    const timeoutMs = registered.config.timeout ?? 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const ctx = deps.createContext(registered, controller.signal);
    const startTime = deps.clock();

    try {
      const result = await deps.executeDag(
        registered.dag,
        parseResult.data,
        ctx,
      );

      clearTimeout(timeoutId);
      const durationMs = deps.clock() - startTime;

      // 7. Map Result to HTTP response
      if (result.ok) {
        // 8. Record success
        circuit = recordSuccess(deps.getCircuit(dagId), deps.clock());
        deps.setCircuit(dagId, circuit);

        return successResponse(c, result.value, { runId: ctx.runId, durationMs });
      } else {
        // Framework error
        circuit = recordFailure(deps.getCircuit(dagId), deps.clock());
        deps.setCircuit(dagId, circuit);

        const msg = formatFrameworkError(result.error);
        return errorResponse(c, 500, result.error.kind, msg, {
          dagId,
          runId: ctx.runId,
        });
      }
    } catch (e: unknown) {
      clearTimeout(timeoutId);

      // Handle abort (timeout)
      if (e instanceof Error && e.name === "AbortError") {
        circuit = recordFailure(deps.getCircuit(dagId), deps.clock());
        deps.setCircuit(dagId, circuit);

        const timeoutErr: HostError = {
          kind: "timeout",
          dagId,
          runId: ctx.runId,
          timeoutMs,
        };
        return errorResponse(c, 408, timeoutErr.kind, formatHostError(timeoutErr), {
          dagId,
          runId: ctx.runId,
          details: { timeoutMs },
        });
      }

      // Record failure for circuit breaker
      circuit = recordFailure(deps.getCircuit(dagId), deps.clock());
      deps.setCircuit(dagId, circuit);

      // Wrap with context for the error handler middleware
      const wrapped = new Error(`Unhandled error executing DAG '${dagId}'`, { cause: e });
      throw wrapped;
    } finally {
      // 9. Release concurrency token
      const currentConcurrency = deps.getConcurrency();
      deps.setConcurrency(release(currentConcurrency, token));
    }
  };
};
