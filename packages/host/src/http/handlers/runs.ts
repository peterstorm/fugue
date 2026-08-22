/**
 * HITL run handlers (ADR-0060):
 *   GET  /runs/:runId          — poll a run's status (queued/running/suspended/
 *                                completed/failed). The async counterpart to the
 *                                synchronous run response.
 *   POST /runs/:runId/approve  — record a human decision for the run's current
 *                                gate and re-enqueue it to resume. Body:
 *                                { decision: "approve" | "reject" |
 *                                  "approve-with-edit" | "reroute", ... }.
 *
 * Authorization mirrors run submission: the caller's identity must be able to
 * access the run's owning DAG team (admin, or the owning team). A run for an
 * unknown/forbidden DAG is treated as not-found / forbidden respectively.
 */

import { match } from "ts-pattern";
import type { Context } from "hono";
import type { HumanAction } from "@fuguejs/framework";
import { formatFrameworkError, tryRunId, tryNodeId } from "@fuguejs/framework";
import type { HostEnv } from "../env.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { canAccessDag } from "../../domain/auth.js";
import { errorResponse, successResponse } from "../response.js";
import { httpStatusFor, formatHostError } from "../../domain/host-error.js";
import { getRegistry } from "../../domain/host-state.js";
import { lookupDag } from "../../domain/registry.js";
import type { HitlRunService } from "../../hitl/service.js";
import type { RunRecord, RunStatus } from "../../hitl/types.js";

interface RunsHandlerDeps {
  readonly hitl?: HitlRunService;
}

/** Public JSON view of a run's status (never leaks internal checkpoint/identity). */
const statusView = (record: RunRecord): unknown =>
  match(record.status)
    .with({ kind: "queued" }, () => ({ runId: record.runId, dagId: record.dagId, status: "queued" }))
    .with({ kind: "running" }, () => ({ runId: record.runId, dagId: record.dagId, status: "running" }))
    .with({ kind: "suspended" }, (s) => ({
      runId: record.runId,
      dagId: record.dagId,
      status: "suspended",
      review: { nodeId: s.nodeId, prompt: s.prompt },
    }))
    .with({ kind: "completed" }, (s) => ({
      runId: record.runId,
      dagId: record.dagId,
      status: "completed",
      output: s.output,
    }))
    .with({ kind: "failed" }, (s) => ({
      runId: record.runId,
      dagId: record.dagId,
      status: "failed",
      error: { kind: s.error.kind, message: formatFrameworkError(s.error) },
    }))
    .exhaustive();

/**
 * Authorize the caller against the run's owning DAG team. Returns the team's id
 * via `ok`, or an HTTP response to short-circuit. A run whose DAG is no longer
 * registered is treated as not-found (we cannot establish its team).
 */
const authorizeRunAccess = (
  c: Context<HostEnv>,
  record: RunRecord,
): { ok: true } | { ok: false; response: Response } => {
  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  if (!identity) {
    return { ok: false, response: errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied") };
  }
  const hostState = c.get("hostState");
  const registry = getRegistry(hostState);
  const registered = registry ? lookupDag(registry, record.dagId) : undefined;
  if (!registered) {
    return { ok: false, response: errorResponse(c, 404, "run-not-found", `Run '${record.runId}' references unknown DAG '${record.dagId}'`) };
  }
  if (!canAccessDag(identity, registered.team)) {
    const callerTeam = identity.kind === "team" ? identity.team : identity.kind;
    return {
      ok: false,
      response: errorResponse(c, 403, "forbidden",
        `Token for '${callerTeam}' cannot access run '${record.runId}' (DAG owned by '${registered.team}')`,
        { dagId: record.dagId },
      ),
    };
  }
  return { ok: true };
};

export const createGetRunHandler = (deps: RunsHandlerDeps) =>
  async (c: Context<HostEnv>): Promise<Response> => {
    if (!deps.hitl) {
      return errorResponse(c, 501, "hitl-not-configured", "HITL is not configured on this host");
    }
    const runIdRaw = c.req.param("runId") ?? "";
    const runIdParsed = tryRunId(runIdRaw);
    if (!runIdParsed.ok) {
      // A malformed id can reference no run; treat as not-found (don't leak the
      // id-format rule), and never feed an unparsed string into the store.
      return errorResponse(c, 404, "run-not-found", `Run '${runIdRaw}' not found`);
    }
    const runId = runIdParsed.value;
    const fetched = await deps.hitl.getRun(runId);
    if (!fetched.ok) {
      return errorResponse(c, httpStatusFor(fetched.error), fetched.error.kind, formatHostError(fetched.error));
    }
    if (fetched.value === null) {
      return errorResponse(c, 404, "run-not-found", `Run '${runId}' not found`);
    }
    const auth = authorizeRunAccess(c, fetched.value);
    if (!auth.ok) return auth.response;
    return successResponse(c, statusView(fetched.value));
  };

// ── Approval body parsing ────────────────────────────────────────────────────

/** Parse the request body into a `HumanAction`, or a human-readable error. */
const parseDecision = (body: unknown): { ok: true; action: HumanAction } | { ok: false; message: string } => {
  if (typeof body !== "object" || body === null) return { ok: false, message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const decision = b.decision;
  const actor = typeof b.actor === "string" ? b.actor : undefined;
  const actorPatch = actor ? { actor } : {};

  return match(decision)
    .with("approve", () => ({ ok: true as const, action: { kind: "approve" as const, ...actorPatch } }))
    .with("approve-with-edit", () =>
      "newOutput" in b
        ? { ok: true as const, action: { kind: "approve-with-edit" as const, newOutput: b.newOutput, ...actorPatch } }
        : { ok: false as const, message: "approve-with-edit requires 'newOutput'" })
    .with("reject", () =>
      typeof b.reason === "string"
        ? { ok: true as const, action: { kind: "reject" as const, reason: b.reason, ...actorPatch } }
        : { ok: false as const, message: "reject requires a string 'reason'" })
    .with("reroute", () => {
      if (typeof b.targetNodeId !== "string") {
        return { ok: false as const, message: "reroute requires a string 'targetNodeId'" };
      }
      // Parse the target through the smart constructor — the body is untrusted.
      const target = tryNodeId(b.targetNodeId);
      if (!target.ok) return { ok: false as const, message: target.error };
      return {
        ok: true as const,
        action: {
          kind: "reroute" as const,
          targetNodeId: target.value,
          ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
          ...actorPatch,
        },
      };
    })
    .otherwise(() => ({ ok: false as const, message: "decision must be one of: approve, approve-with-edit, reject, reroute" }));
};

export const createApproveRunHandler = (deps: RunsHandlerDeps) =>
  async (c: Context<HostEnv>): Promise<Response> => {
    if (!deps.hitl) {
      return errorResponse(c, 501, "hitl-not-configured", "HITL is not configured on this host");
    }
    const runIdRaw = c.req.param("runId") ?? "";
    const runIdParsed = tryRunId(runIdRaw);
    if (!runIdParsed.ok) {
      return errorResponse(c, 404, "run-not-found", `Run '${runIdRaw}' not found`);
    }
    const runId = runIdParsed.value;

    const fetched = await deps.hitl.getRun(runId);
    if (!fetched.ok) {
      return errorResponse(c, httpStatusFor(fetched.error), fetched.error.kind, formatHostError(fetched.error));
    }
    const record = fetched.value;
    if (record === null) {
      return errorResponse(c, 404, "run-not-found", `Run '${runId}' not found`);
    }

    const auth = authorizeRunAccess(c, record);
    if (!auth.ok) return auth.response;

    // The gate being decided is the run's CURRENT suspended gate. Approving a run
    // that isn't parked is a conflict (nothing to decide).
    const status: RunStatus = record.status;
    if (status.kind !== "suspended") {
      return errorResponse(c, 409, "run-not-suspended",
        `Run '${runId}' is '${status.kind}', not awaiting human review`,
        { runId, details: { status: status.kind } },
      );
    }
    const gateNodeId = status.nodeId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "body-parse-failed", "request body is not valid JSON", { runId });
    }
    const parsed = parseDecision(body);
    if (!parsed.ok) {
      return errorResponse(c, 400, "invalid-decision", parsed.message, { runId });
    }

    const recorded = await deps.hitl.recordDecision(record.runId, gateNodeId, parsed.action);
    if (!recorded.ok) {
      return errorResponse(c, httpStatusFor(recorded.error), recorded.error.kind, formatHostError(recorded.error), { runId });
    }
    return successResponse(c, { runId: record.runId, status: "resuming", nodeId: gateNodeId }, { runId: record.runId });
  };
