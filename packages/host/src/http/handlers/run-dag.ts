/**
 * Run DAG handler — POST /dags/:id/run
 *
 * FR-020: Executes a DAG and returns the result as JSON with 200 (the
 *         synchronous, non-HITL path). DAGs declaring a `humanReview` gate fork
 *         to the durable HITL engine and return 202 + runId instead (see step 2.5).
 * FR-026: Error responses are machine-readable JSON with error/message/details/dagId/runId
 * FR-027: Per-DAG concurrency limit exceeded returns 429 with Retry-After
 * FR-028: Per-DAG timeout returns 408 with run ID (enables future resumption)
 */

import type { Context } from "hono";
import type { Result, NodeContext, FrameworkError, InvocationOrigin } from "@fuguejs/framework";
import { formatFrameworkError, tryDagId } from "@fuguejs/framework";
import type { DagDef } from "@fuguejs/framework";
import type { HostEnv } from "../env.js";
import type { NodeContextForDag } from "../../domain/run-context.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { authorizeDagAccess } from "./dag-access.js";
import { errorResponse, hostUnavailableResponse, successResponse } from "../response.js";
import type { HostError } from "../../domain/host-error.js";
import { formatHostError, httpStatusFor } from "../../domain/host-error.js";
import { getRegistry } from "../../domain/host-state.js";
import { lookupDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { acquire, release } from "../../domain/concurrency.js";
import type { ConcurrencyState } from "../../domain/concurrency.js";
import { checkCircuit, markSuccess, markFailure } from "../../domain/circuit-guard.js";
import type { CircuitPort, CircuitConfig } from "../../domain/circuit-guard.js";
import { classifyFrameworkError } from "../../domain/framework-error-http.js";
import type { HitlRunService } from "../../hitl/service.js";

// ---------------------------------------------------------------------------
// Types for the handler's dependencies (injectable for testing)
// ---------------------------------------------------------------------------

export interface RunDagDeps {
  /**
   * Durable HITL run service (ADR-0060). When a target DAG declares a
   * `humanReview` gate, the run is enqueued here and the request returns
   * `202 {runId}` (poll `GET /runs/:runId`) instead of executing inline. When
   * undefined, a HITL DAG is refused (501) — the host must be configured for
   * human review. Non-HITL DAGs never touch this and keep the synchronous path.
   */
  readonly hitl?: HitlRunService;
  readonly getConcurrency: () => ConcurrencyState;
  readonly setConcurrency: (s: ConcurrencyState) => void;
  readonly circuit: CircuitPort;
  readonly circuitConfig: CircuitConfig;
  /**
   * Build the base NodeContext for a run, plus the run `origin`. The resolved
   * inbound `AuthIdentity` is threaded in (FR-W3-007) so a user-initiated run
   * carries the user's `sub` into the `origin`, which is handed to `executeDag`
   * so the broker can authorize each node's per-dispatch mint against it.
   */
  readonly createContext: (
    registered: RegisteredDag,
    signal: AbortSignal,
    identity: AuthIdentity,
  ) => Promise<NodeContextForDag>;
  /**
   * Execute the DAG. `origin` (from `createContext`) is threaded through to the
   * framework's per-node minting broker so each node's declared scopes are
   * authorized + minted at dispatch against the initiating identity. `undefined`
   * only on the no-minting static path (no broker wired AND DAG unmapped), where
   * the implementation skips minting entirely.
   */
  readonly executeDag: <I, O>(
    dag: DagDef,
    input: I,
    ctx: NodeContext,
    origin: InvocationOrigin | undefined,
  ) => Promise<Result<O, FrameworkError>>;
  readonly clock: () => number;
}

/**
 * Creates the run-dag handler with injected dependencies.
 *
 * `resolveRawId` extracts the target DAG id from the request — defaults to the
 * `:id` path param. The custom-route fallback (router.ts) injects a resolver
 * that maps a registration's `route` override back to its DAG id, so both
 * entry points share this one handler (auth, concurrency, circuit, caching).
 */
export const createRunDagHandler = (
  deps: RunDagDeps,
  resolveRawId: (c: Context<HostEnv>) => string = (c) => c.req.param("id") ?? "",
) => {
  return async (c: Context<HostEnv>): Promise<Response> => {
    const rawId = resolveRawId(c);
    const dagIdResult = tryDagId(rawId);
    if (!dagIdResult.ok) {
      return errorResponse(c, 400, "invalid-dag-id", `Invalid DAG ID '${rawId}': ${dagIdResult.error}`, {
        details: { raw: rawId },
      });
    }
    const dagId = dagIdResult.value;
    const hostState = c.get("hostState");

    // 1. Reject if host cannot serve requests (booting, draining, stopped)
    const unavailable = hostUnavailableResponse(c, hostState);
    if (unavailable) return unavailable;

    // "no registry yet" and "registry without this DAG" are the SAME answer to the
    // caller — this DAG is not servable — and differ only in what can be listed
    // as available. Deriving `available` from the registry (empty when there is
    // none) keeps one 404 shape instead of two that could drift apart.
    const registry = getRegistry(hostState);
    const registered = registry ? lookupDag(registry, dagId) : undefined;
    if (!registered) {
      const available = registry ? Array.from(registry.dags.keys()) : [];
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

    // 1.5. Authorization — check team scope and carry the parsed identity.
    const access = authorizeDagAccess(c, dagId, registered);
    if (!access.ok) return access.response;
    const { identity } = access;

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

    // 2.5. HITL fork (ADR-0060): a DAG declaring a `humanReview` gate cannot run
    // synchronously — it may park for a human for an unbounded time. Enqueue it
    // on the durable run engine and return 202 + runId; the client polls
    // `GET /runs/:runId`. Non-HITL DAGs fall through to the synchronous path
    // below, byte-for-byte unchanged.
    const isHitlDag = registered.dag.nodes.some((n) => n.humanReview !== undefined);
    if (isHitlDag) {
      if (!deps.hitl) {
        return errorResponse(c, 501, "hitl-not-configured",
          `DAG '${dagId}' declares human review but this host is not configured for HITL`,
          { dagId },
        );
      }
      const started = await deps.hitl.startRun(dagId, registered.team, parseResult.data, identity);
      if (!started.ok) {
        return errorResponse(c, httpStatusFor(started.error), started.error.kind, formatHostError(started.error), { dagId });
      }
      // 202 Accepted: the run is queued for durable execution; poll GET /runs/:id.
      return c.json(
        { ok: true as const, data: { runId: started.value.runId, status: "queued" }, runId: started.value.runId },
        202,
      );
    }

    // 3. Acquire per-DAG concurrency token BEFORE consuming the circuit probe.
    //
    // INVARIANT: the circuit's half-open probe is a single-use resource. It must
    // only be spent on a request we are actually going to execute. If we consumed
    // it before concurrency admission and then rejected with 429, the breaker would
    // be stranded at half-open{testRequestAllowed:false} with no mark* call to move
    // it forward — wedged until the next git sync force-reset. So admission first.
    const now = deps.clock();

    // Effective circuit config: per-DAG override (if declared) merged over the host
    // default. Each field the DAG omits falls back to the host-level config.
    // No branch on whether an override EXISTS: each field already falls back to
    // the host default on its own, so "no override" and "an override that sets
    // nothing" are the same merge — writing it once removes the chance of the
    // two arms drifting to different defaults.
    const cbOverride = registered.config.circuitBreaker;
    const circuitConfig: CircuitConfig = {
      threshold: cbOverride?.failureThreshold ?? deps.circuitConfig.threshold,
      windowMs: deps.circuitConfig.windowMs,
      cooldownMs: cbOverride?.resetTimeoutMs ?? deps.circuitConfig.cooldownMs,
    };

    const concurrency = deps.getConcurrency();
    const acquireResult = acquire(concurrency, dagId, now);

    if (!acquireResult.ok) {
      // ONE test of the capacity scope: the error kind and the `scope` detail
      // are two views of the same fact, and deriving them from separate
      // comparisons let them disagree if either side were ever edited alone.
      const atGlobalCapacity = acquireResult.error.kind === "global-at-capacity";
      const concErr: HostError = atGlobalCapacity
        ? { kind: "global-concurrency-exceeded" }
        : { kind: "dag-concurrency-exceeded", dagId };
      return errorResponse(c, 429, concErr.kind, formatHostError(concErr), {
        dagId,
        details: { scope: atGlobalCapacity ? "global" : "dag" },
        headers: { "Retry-After": "5" },
      });
    }

    deps.setConcurrency(acquireResult.value.state);
    const token = acquireResult.value.token;

    // 4. Check circuit breaker state. If it denies, release the slot we just took
    // so a rejected request leaves no trace on the concurrency counters.
    const circuitCheck = checkCircuit(deps.circuit, dagId, now, circuitConfig);

    if (!circuitCheck.allowed) {
      deps.setConcurrency(release(deps.getConcurrency(), token));
      return errorResponse(c, 503, "dag-disabled", `Circuit breaker open for DAG '${dagId}'`, {
        dagId,
        headers: { "Retry-After": "30" },
      });
    }

    const { permit } = circuitCheck;

    // 5. Execute DAG with timeout
    // INVARIANT: The outer try/finally guarantees token release.
    // The setup guard (above) clears the timer if createContext throws.
    // The inner try/catch handles execution-level errors.
    try {
      const timeoutMs = registered.config.timeout;
      const HOST_TIMEOUT = Symbol("host-timeout");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(HOST_TIMEOUT), timeoutMs);

      // Declare ctx before the execution try so it's accessible in the catch block.
      // Guard the createContext call so the timer is cleared if it throws (leak prevention).
      let ctx: NodeContext;
      let origin: InvocationOrigin | undefined;
      try {
        // `await` preserves the setup-guard semantics: a synchronous throw or a
        // rejected promise from `createContext` both land in this catch.
        // Thread the resolved inbound identity (user `sub`/`azp`, or admin/team)
        // into context creation so user-initiated runs are attributable and the
        // broker builds a per-node `Invocation` carrying the run `origin`.
        const built = await deps.createContext(registered, controller.signal, identity);
        ctx = built.ctx;
        origin = built.origin;
      } catch (setupErr) {
        clearTimeout(timeoutId);
        markFailure(permit, deps.clock(), circuitConfig);
        throw setupErr;
      }
      const startTime = deps.clock();

      try {
        const result = await deps.executeDag(
          registered.dag,
          parseResult.data,
          ctx,
          origin,
        );

        clearTimeout(timeoutId);
        const durationMs = deps.clock() - startTime;

        // 6. Map Result to HTTP response (review I4). A settled authorization
        // "no" (policy-refusal / downstream-denied → 403) and a per-run usage
        // limit (llm-budget-exceeded → 429) are NOT host malfunctions: they map
        // to client-facing statuses and do NOT trip the circuit breaker. Genuine
        // execution failures (500) and transient infra-unreachable (503) do. The
        // half-open probe is always resolved — markFailure on a real failure,
        // markSuccess on a settled refusal — so it never wedges.
        if (result.ok) {
          markSuccess(permit, deps.clock());
          return successResponse(c, result.value, { runId: ctx.runId, durationMs });
        } else {
          const cls = classifyFrameworkError(result.error);
          if (cls.countsAsCircuitFailure) {
            markFailure(permit, deps.clock(), circuitConfig);
          } else {
            markSuccess(permit, deps.clock());
          }
          const msg = formatFrameworkError(result.error);
          return errorResponse(c, cls.status, result.error.kind, msg, {
            dagId,
            runId: ctx.runId,
            ...(cls.retryAfterSeconds !== undefined
              ? { headers: { "Retry-After": String(cls.retryAfterSeconds) } }
              : {}),
          });
        }
      } catch (e: unknown) {
        clearTimeout(timeoutId);

        // Handle abort (timeout) — only if caused by HOST_TIMEOUT sentinel
        if (e instanceof Error && e.name === "AbortError" && controller.signal.reason === HOST_TIMEOUT) {
          markFailure(permit, deps.clock(), circuitConfig);
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

        markFailure(permit, deps.clock(), circuitConfig);

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
