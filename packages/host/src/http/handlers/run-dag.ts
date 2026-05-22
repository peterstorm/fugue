/**
 * Run DAG handler — POST /dags/:id/run
 *
 * FR-020: Executes DAG and returns result as JSON with 200
 * FR-026: Error responses are machine-readable JSON with error/message/details/dagId/runId
 * FR-027: Per-DAG concurrency limit exceeded returns 429 with Retry-After
 * FR-028: Per-DAG timeout returns 408 with run ID (enables future resumption)
 */

import type { Context } from "hono";
import type { DagId, Result, NodeContext, FrameworkError } from "@fugue/framework";
import { formatFrameworkError, tryDagId } from "@fugue/framework";
import type { DagDef, RunOptions } from "@fugue/framework";
import type { HostEnv } from "../router.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { canAccessDag } from "../../domain/auth.js";
import { errorResponse, successResponse } from "../response.js";
import type { HostError } from "../../domain/host-error.js";
import { formatHostError } from "../../domain/host-error.js";
import { canServeRequests, getRegistry } from "../../domain/host-state.js";
import { lookupDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { acquire, release } from "../../domain/concurrency.js";
import type { ConcurrencyState } from "../../domain/concurrency.js";
import { checkCircuit, markSuccess, markFailure } from "../../domain/circuit-guard.js";
import type { CircuitPort, CircuitConfig } from "../../domain/circuit-guard.js";

// ---------------------------------------------------------------------------
// Types for the handler's dependencies (injectable for testing)
// ---------------------------------------------------------------------------

export interface RunDagDeps {
  readonly getConcurrency: () => ConcurrencyState;
  readonly setConcurrency: (s: ConcurrencyState) => void;
  readonly circuit: CircuitPort;
  readonly circuitConfig: CircuitConfig;
  readonly createContext: (registered: RegisteredDag, signal?: AbortSignal) => NodeContext;
  readonly executeDag: <I, O>(dag: DagDef, input: I, ctx: NodeContext, opts?: RunOptions) => Promise<Result<O, FrameworkError>>;
  readonly clock: () => number;
}

/**
 * Creates the run-dag handler with injected dependencies.
 */
export const createRunDagHandler = (deps: RunDagDeps) => {
  return async (c: Context<HostEnv>): Promise<Response> => {
    const rawId = c.req.param("id") ?? "";
    const dagIdResult = tryDagId(rawId);
    if (!dagIdResult.ok) {
      return errorResponse(c, 400, "invalid-dag-id", `Invalid DAG ID '${rawId}': ${dagIdResult.error}`, {
        details: { raw: rawId },
      });
    }
    const dagId = dagIdResult.value;
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
    if (registered.status.kind === "disabled") {
      const disabled: HostError = { kind: "dag-disabled", dagId, reason: registered.status.reason };
      return errorResponse(c, 503, disabled.kind, formatHostError(disabled), { dagId });
    }

    // 1.5. Authorization — check team scope
    const identity = c.get("authIdentity") as AuthIdentity | undefined;
    if (!identity) {
      return errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied");
    }
    if (!canAccessDag(identity, registered.team)) {
      const callerTeam = identity.kind === "team" ? identity.team : "admin";
      return errorResponse(c, 403, "forbidden",
        `Token for team '${callerTeam}' cannot access DAG '${dagId}' (owned by '${registered.team}')`,
        { dagId, details: { callerTeam, dagTeam: registered.team } },
      );
    }

    // 2. Parse and validate input
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      const parseErr: HostError = {
        kind: "body-parse-failed",
        dagId,
        message: errorMsg,
      };
      return errorResponse(c, 400, parseErr.kind, formatHostError(parseErr), {
        dagId,
        details: { message: errorMsg },
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
    const circuitCheck = checkCircuit(deps.circuit, dagId, now);

    if (!circuitCheck.allowed) {
      return errorResponse(c, 503, "dag-disabled", `Circuit breaker open for DAG '${dagId}'`, {
        dagId,
        headers: { "Retry-After": "30" },
      });
    }

    const { permit } = circuitCheck;

    // 4. Acquire per-DAG concurrency token
    const concurrency = deps.getConcurrency();
    const acquireResult = acquire(concurrency, dagId, now);

    if (!acquireResult.ok) {
      const concErr: HostError = acquireResult.error === "global-at-capacity"
        ? { kind: "global-concurrency-exceeded" }
        : { kind: "dag-concurrency-exceeded", dagId };
      return errorResponse(c, 429, concErr.kind, formatHostError(concErr), {
        dagId,
        details: { scope: acquireResult.error === "global-at-capacity" ? "global" : "dag" },
        headers: { "Retry-After": "5" },
      });
    }

    deps.setConcurrency(acquireResult.value.state);
    const token = acquireResult.value.token;

    // 5. Execute DAG with timeout
    // INVARIANT: The outer try/finally guarantees token release even if
    // createContext or setTimeout throws. The inner try/catch handles
    // execution-level errors (timeout, framework errors, unhandled throws).
    try {
      const timeoutMs = registered.config.timeout;
      const HOST_TIMEOUT = Symbol("host-timeout");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(HOST_TIMEOUT), timeoutMs);
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

        // 6. Map Result to HTTP response
        if (result.ok) {
          markSuccess(permit, deps.clock());
          return successResponse(c, result.value, { runId: ctx.runId, durationMs });
        } else {
          markFailure(permit, deps.clock(), deps.circuitConfig);
          const msg = formatFrameworkError(result.error);
          return errorResponse(c, 500, result.error.kind, msg, {
            dagId,
            runId: ctx.runId,
          });
        }
      } catch (e: unknown) {
        clearTimeout(timeoutId);

        // Handle abort (timeout) — only if caused by HOST_TIMEOUT sentinel
        if (e instanceof Error && e.name === "AbortError" && controller.signal.reason === HOST_TIMEOUT) {
          markFailure(permit, deps.clock(), deps.circuitConfig);
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

        markFailure(permit, deps.clock(), deps.circuitConfig);

        // Wrap with context for the error handler middleware
        const wrapped = new Error(`Unhandled error executing DAG '${dagId}'`, { cause: e });
        throw wrapped;
      }
    } finally {
      // 7. Release concurrency token
      // INVARIANT: This read-transform-write MUST remain synchronous (no await).
      // Single-threaded event loop guarantees atomicity within a tick.
      const currentConcurrency = deps.getConcurrency();
      deps.setConcurrency(release(currentConcurrency, token));
    }
  };
};
