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
 * access the immutable owning team captured on the run at durable acceptance.
 * Later DAG reassignment or removal cannot change historical-run access.
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

/** Authorize the caller against the run's immutable resource owner. */
const authorizeRunAccess = (
  c: Context<HostEnv>,
  record: RunRecord,
): { ok: true; identity: AuthIdentity } | { ok: false; response: Response } => {
  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  if (!identity) {
    return { ok: false, response: errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied") };
  }
  if (!canAccessDag(identity, record.ownerTeam)) {
    const callerTeam = identity.kind === "team" ? identity.team : identity.kind;
    return {
      ok: false,
      response: errorResponse(c, 403, "forbidden",
        `Token for '${callerTeam}' cannot access run '${record.runId}' (run owned by '${record.ownerTeam}')`,
        { dagId: record.dagId },
      ),
    };
  }
  return { ok: true, identity };
};

const loadAuthorizedRun = async (
  c: Context<HostEnv>,
  hitl: HitlRunService,
): Promise<{ ok: true; record: RunRecord; identity: AuthIdentity } | { ok: false; response: Response }> => {
  const runIdRaw = c.req.param("runId") ?? "";
  const parsed = tryRunId(runIdRaw);
  if (!parsed.ok) {
    return { ok: false, response: errorResponse(c, 404, "run-not-found", `Run '${runIdRaw}' not found`) };
  }

  const fetched = await hitl.getRun(parsed.value);
  if (!fetched.ok) {
    return {
      ok: false,
      response: errorResponse(c, httpStatusFor(fetched.error), fetched.error.kind, formatHostError(fetched.error)),
    };
  }
  if (fetched.value === null) {
    return { ok: false, response: errorResponse(c, 404, "run-not-found", `Run '${parsed.value}' not found`) };
  }

  const authorized = authorizeRunAccess(c, fetched.value);
  return authorized.ok
    ? { ok: true, record: fetched.value, identity: authorized.identity }
    : authorized;
};

export const createGetRunHandler = (deps: RunsHandlerDeps) =>
  async (c: Context<HostEnv>): Promise<Response> => {
    if (!deps.hitl) {
      return errorResponse(c, 501, "hitl-not-configured", "HITL is not configured on this host");
    }
    const loaded = await loadAuthorizedRun(c, deps.hitl);
    if (!loaded.ok) return loaded.response;
    return successResponse(c, statusView(loaded.record));
  };

// ── Approval body parsing ────────────────────────────────────────────────────

/** Parse the request body into a `HumanAction`, or a human-readable error. */
const parseDecision = (body: unknown): { ok: true; action: HumanAction } | { ok: false; message: string } => {
  if (typeof body !== "object" || body === null) return { ok: false, message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const decision = b.decision;

  return match(decision)
    .with("approve", () => ({ ok: true as const, action: { kind: "approve" as const } }))
    .with("approve-with-edit", () =>
      "newOutput" in b
        ? { ok: true as const, action: { kind: "approve-with-edit" as const, newOutput: b.newOutput } }
        : { ok: false as const, message: "approve-with-edit requires 'newOutput'" })
    .with("reject", () =>
      typeof b.reason === "string"
        ? { ok: true as const, action: { kind: "reject" as const, reason: b.reason } }
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
        },
      };
    })
    .otherwise(() => ({ ok: false as const, message: "decision must be one of: approve, approve-with-edit, reject, reroute" }));
};

const auditActor = (identity: AuthIdentity): string =>
  match(identity)
    .with({ kind: "admin" }, () => "admin")
    .with({ kind: "team" }, (teamIdentity) => `team:${teamIdentity.team}`)
    .with({ kind: "user" }, (userIdentity) => `user:${userIdentity.sub}`)
    .exhaustive();

const attributeDecision = (action: HumanAction, identity: AuthIdentity): HumanAction => ({
  ...action,
  actor: auditActor(identity),
});

export const createApproveRunHandler = (deps: RunsHandlerDeps) =>
  async (c: Context<HostEnv>): Promise<Response> => {
    if (!deps.hitl) {
      return errorResponse(c, 501, "hitl-not-configured", "HITL is not configured on this host");
    }
    const loaded = await loadAuthorizedRun(c, deps.hitl);
    if (!loaded.ok) return loaded.response;
    const { record, identity } = loaded;
    const runId = record.runId;

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

    const recorded = await deps.hitl.recordDecision(
      record.runId,
      gateNodeId,
      attributeDecision(parsed.action, identity),
    );
    if (!recorded.ok) {
      return errorResponse(c, httpStatusFor(recorded.error), recorded.error.kind, formatHostError(recorded.error), { runId });
    }
    return successResponse(c, { runId: record.runId, status: "resuming", nodeId: gateNodeId }, { runId: record.runId });
  };
