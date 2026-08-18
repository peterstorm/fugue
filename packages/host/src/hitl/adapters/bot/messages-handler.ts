/**
 * Inbound Bot Framework activity handler (ADR-0060) — the endpoint Teams POSTs
 * to when a reviewer clicks Approve/Reject, or when the bot is added to a
 * channel. Transport-agnostic: it takes the parsed activity + auth header and
 * returns `{ status, body }`, so it is fully unit-testable without Hono and with
 * a fake token verifier.
 *
 * Security: EVERY activity is verified via `VerifyBotToken` first (fail closed),
 * and the captured `serviceUrl` is allowlisted (`isTrustedBotServiceUrl`) so the
 * connector never sends its bearer token to a forged host.
 *
 * SECURITY — two distinct layers (FR-041, US5, SC-006):
 *
 *  (a) AUTHORIZATION gate (the action-prevention control): the in-Teams button
 *      path authorizes the clicking user against the run's owning DAG team AT
 *      PARITY with the HTTP approve path (`runs.ts#authorizeRunAccess`). The card
 *      click carries the clicker's `from.aadObjectId`; `approverTeamIdentity`
 *      (`hitl/identity.ts`) resolves it — fail-closed on an unknown id — to an
 *      `AuthIdentity`, and the SAME `canAccessDag` predicate the HTTP path uses
 *      gates the decision against the run's DAG-owning team (resolved via the
 *      injected `resolveDagTeam`). A non-member's (or unknown user's) click is
 *      REFUSED and `recordDecision` is NEVER called (SC-006). THIS is what stops
 *      one team's members from acting on another team's runs — even if a card
 *      somehow reached the wrong channel.
 *
 *  (b) Per-team CHANNEL routing (a confidentiality measure, not an action gate):
 *      on `conversationUpdate` the activity's `channelData.team.aadGroupId` is
 *      resolved through `teamChannels` (`HITL_TEAM_CHANNELS`) to a fugue team and
 *      the conversation reference is stored PER TEAM (via
 *      `ConversationStorePort.saveTeamReference`), so the notifier delivers that
 *      team's review cards to that team's own channel. An unmapped team stores
 *      only the default reference and falls back to the default channel. Routing
 *      decides WHERE a card is delivered; it does NOT decide WHO may approve —
 *      that is the authz gate above.
 *
 * Behaviour by activity type:
 *   - conversationUpdate (bot added) → capture + persist the conversation
 *     reference (default, plus per-team when the team is mapped).
 *   - invoke `adaptiveCard/action` with our verb → authorize, then map the button
 *     to a HumanAction, record the decision (resuming the run), refresh the card.
 *   - anything else → 200 no-op.
 */

import { match } from "ts-pattern";
import type { HumanAction, DagId } from "@fuguejs/framework";
import { tryRunId, tryNodeId } from "@fuguejs/framework";
import type { HitlRunService } from "../../service.js";
import type { LogPort } from "../../../ports.js";
import { canAccessDag } from "../../../domain/auth.js";
import type { Team } from "../../../domain/auth.js";
import { approverTeamIdentity, type ApproverTeamMap } from "../../identity.js";
import type { ConversationStorePort, VerifyBotToken, ConversationReference } from "./ports.js";
import { REVIEW_VERB, buildResolvedCard } from "./card.js";
import { isTrustedBotServiceUrl } from "./trusted-host.js";

interface BotMessagesDeps {
  readonly verify: VerifyBotToken;
  readonly hitl: Pick<HitlRunService, "getRun" | "recordDecision">;
  readonly conversations: ConversationStorePort;
  /**
   * Resolve a run's DAG id to its OWNING team (FR-041). Wired from the live
   * registry (the same `lookupDag` the HTTP path uses), so the bot path
   * authorizes against the run's real team at parity. `undefined` when the DAG is
   * no longer registered — treated as fail-closed (cannot establish the team, so
   * the decision is refused, mirroring the HTTP path's not-found handling).
   */
  readonly resolveDagTeam: (dagId: DagId) => Team | undefined;
  /**
   * Config-sourced `aadObjectId → teams` map (FR-041, `HITL_APPROVER_TEAMS`). The
   * clicker's `from.aadObjectId` is resolved through it to the approver identity
   * the decision is authorized with. An unknown id fails closed (SC-006).
   */
  readonly approverTeams: ApproverTeamMap;
  /**
   * Config-sourced `aadGroupId → fugue team` map (FR-041, `HITL_TEAM_CHANNELS`).
   * On `conversationUpdate` the inbound activity's `channelData.team.aadGroupId`
   * is resolved through it to the owning fugue team, and the conversation
   * reference is stored PER TEAM so that team's cards route to its own channel
   * (a confidentiality measure — not the action-prevention gate). An aadGroupId
   * ABSENT from this map is an unmapped team: only the default reference is
   * stored. Own-property lookup only (no prototype-pollution resolution).
   */
  readonly teamChannels: Readonly<Record<string, string>>;
  readonly logger?: LogPort;
}

export interface BotResponse {
  readonly status: number;
  readonly body?: unknown;
}

// ── safe nested readers (activity is `unknown` off the wire) ──────────────────
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A Teams `adaptiveCard/action` invoke response carrying a refreshed card. */
const cardInvokeResponse = (card: unknown): BotResponse => ({
  status: 200,
  body: { statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: card },
});

const messageInvokeResponse = (text: string): BotResponse => ({
  status: 200,
  body: { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: text },
});

/** Map the button payload to a HumanAction. Reject carries the card's reason input. */
const toAction = (decision: string, reason: string | undefined, actor: string): HumanAction | null =>
  match(decision)
    .with("approve", (): HumanAction => ({ kind: "approve", actor }))
    .with("reject", (): HumanAction => ({ kind: "reject", reason: reason && reason.trim() !== "" ? reason : "(no reason provided)", actor }))
    .otherwise(() => null);

const captureReference = (activity: Record<string, unknown>): ConversationReference | null => {
  const serviceUrl = str(activity.serviceUrl);
  const conversationId = str(obj(activity.conversation).id);
  if (serviceUrl === undefined || conversationId === undefined) return null;
  return {
    serviceUrl,
    conversationId,
    ...(str(activity.channelId) !== undefined ? { channelId: str(activity.channelId)! } : {}),
    ...(str(obj(activity.recipient).id) !== undefined ? { botId: str(obj(activity.recipient).id)! } : {}),
  };
};

export const handleBotActivity = async (
  deps: BotMessagesDeps,
  input: { authHeader: string | undefined; activity: unknown },
): Promise<BotResponse> => {
  // 1. Verify the caller is the Bot Framework service (fail closed).
  const verified = await deps.verify(input.authHeader);
  if (!verified.ok) {
    deps.logger?.warn?.("hitl/bot: inbound token rejected", { reason: verified.error.reason });
    return { status: verified.error.kind === "unavailable" ? 503 : 401 };
  }

  const activity = obj(input.activity);
  const type = str(activity.type);

  // 2. Bot added to a channel → remember where to post reviews.
  if (type === "conversationUpdate") {
    const ref = captureReference(activity);
    if (ref && !isTrustedBotServiceUrl(ref.serviceUrl)) {
      // Reject an untrusted serviceUrl: persisting it would later send an
      // app-only bearer token there (SSRF / credential leak).
      deps.logger?.warn?.("hitl/bot: refusing untrusted serviceUrl on conversationUpdate", { serviceUrl: ref.serviceUrl });
      return { status: 200 };
    }
    if (ref) {
      // Per-team routing (FR-041, confidentiality): if the activity carries a
      // Teams team `aadGroupId` that maps to a fugue team, ALSO store the
      // reference under that team so its cards route to its own channel. We
      // STILL store the default for back-compat and as the fallback for unmapped
      // teams. Own-property lookup only — an inherited key (`constructor`, …)
      // must never resolve a team (mirrors identity.ts, fail-closed).
      const aadGroupId = str(obj(obj(activity.channelData).team).aadGroupId);
      const mappedTeam =
        aadGroupId !== undefined && Object.prototype.hasOwnProperty.call(deps.teamChannels, aadGroupId)
          ? deps.teamChannels[aadGroupId]
          : undefined;
      if (mappedTeam !== undefined) {
        const savedTeam = await deps.conversations.saveTeamReference(mappedTeam, ref);
        if (!savedTeam.ok) deps.logger?.error?.("hitl/bot: failed to persist team conversation reference", { team: mappedTeam, error: savedTeam.error.kind });
        else deps.logger?.info?.("hitl/bot: captured per-team conversation reference", { team: mappedTeam });
      } else {
        deps.logger?.info?.("hitl/bot: conversationUpdate with no mapped team — default reference only", { aadGroupId });
      }
      const saved = await deps.conversations.saveDefaultReference(ref);
      if (!saved.ok) deps.logger?.error?.("hitl/bot: failed to persist conversation reference", { error: saved.error.kind });
      else deps.logger?.info?.("hitl/bot: captured default conversation reference for proactive reviews");
    }
    return { status: 200 };
  }

  // 3. Card button click.
  const isCardAction = type === "invoke" && str(activity.name) === "adaptiveCard/action";
  if (!isCardAction) return { status: 200 };

  const data = obj(obj(obj(activity.value).action).data);
  if (data.verb !== REVIEW_VERB) return { status: 200 }; // not ours

  const runIdRaw = str(data.runId);
  const nodeIdRaw = str(data.nodeId);
  const decision = str(data.decision) ?? "";
  if (runIdRaw === undefined || nodeIdRaw === undefined) {
    return messageInvokeResponse("Malformed review action.");
  }
  // Parse BOTH off-the-wire ids through their smart constructors rather than
  // `as`-casting: the card `data` is POSTed back by a client and is not trusted
  // (parse-don't-validate at the boundary). Parsing nodeId too keeps the
  // staleness guard below a brand-correct NodeId-vs-NodeId comparison.
  const runIdParsed = tryRunId(runIdRaw);
  if (!runIdParsed.ok) return messageInvokeResponse("Malformed review action.");
  const runId = runIdParsed.value;
  const nodeIdParsed = tryNodeId(nodeIdRaw);
  if (!nodeIdParsed.ok) return messageInvokeResponse("Malformed review action.");
  const nodeId = nodeIdParsed.value;
  const aadObjectId = str(obj(activity.from).aadObjectId);
  const actor = str(obj(activity.from).name) ?? aadObjectId ?? "teams-user";
  const action = toAction(decision, str(data.reason), actor);
  if (action === null) return messageInvokeResponse(`Unknown decision '${decision}'.`);

  // 4. Load the run, then AUTHORIZE BEFORE disclosing ANY run state — PARITY with
  //    the HTTP approve path (`runs.ts#createApproveRunHandler`: getRun → authorize
  //    → only then reveal status). The card `data` (runId/nodeId) is client-supplied
  //    and a Bot-Framework token only proves the request came from Bot Framework,
  //    NOT that this clicker is authorized for this run's team. Checking run
  //    existence/status BEFORE authz (as this handler previously did) lets any
  //    mapped approver of ANY team probe arbitrary runIds and learn whether a run
  //    exists and its lifecycle stage for OTHER teams' runs. So every not-authorized
  //    / unknown-run outcome returns the SAME generic refusal — no existence or
  //    status detail leaks to an unauthorized clicker.
  const fetched = await deps.hitl.getRun(runId);
  if (!fetched.ok) return messageInvokeResponse("Could not load the run.");
  const record = fetched.value;
  if (record === null) {
    // No record → no owning team to authorize against. By design indistinguishable
    // from an unauthorized click: return the generic refusal so a missing run is
    // not an existence oracle for an unauthorized prober.
    return messageInvokeResponse("You are not authorized to act on this review.");
  }

  // ── Approver authorization (FR-041, US5, SC-006) — BEFORE any state disclosure ──
  // Resolve the run's DAG-owning team, resolve the clicker's `aadObjectId` to an
  // approver identity (fail-closed on an unknown id), and gate on the SAME
  // `canAccessDag` predicate the HTTP path uses. A non-member's (or unknown user's)
  // click is REFUSED with NO run detail and `recordDecision` is NEVER reached
  // (SC-006 — zero side effect on refusal).
  const dagTeam = deps.resolveDagTeam(record.dagId);
  if (dagTeam === undefined) {
    // The DAG is no longer registered — its owning team can't be established, so
    // the decision can't be authorized. Fail closed.
    deps.logger?.warn?.("hitl/bot: refusing decision — run references an unregistered DAG", { runId, dagId: record.dagId });
    return messageInvokeResponse("You are not authorized to act on this review.");
  }
  const approver = approverTeamIdentity(deps.approverTeams, aadObjectId);
  if (approver === undefined || !canAccessDag(approver, dagTeam)) {
    // Unknown approver (no aadObjectId / unmapped) OR a member of a DIFFERENT
    // team. Refuse WITHOUT recording — one channel's members cannot approve
    // another team's runs. Identical outcome (no decision, no detail) whether the
    // user is unknown or merely not a member, so the refusal leaks neither
    // membership nor run state.
    deps.logger?.warn?.("hitl/bot: refusing decision — approver not authorized for the run's team", { runId, dagTeam });
    return messageInvokeResponse("You are not authorized to act on this review.");
  }

  // 5. AUTHORIZED. Only now may run state be disclosed. The gate must still be
  //    open; if the run already resolved, refresh the card to say so rather than
  //    recording a stale decision.
  if (record.status.kind !== "suspended") {
    // `queued`/`running` are TRANSIENT, not terminal: the run may be mid-slice
    // with its `suspended` status not yet folded back into the store (the notify
    // that produced this card fires from inside the slice while status is still
    // `running` — see service.ts recordDecision). Rendering a resolved card here
    // would replace the buttons and mislead the reviewer into thinking the review
    // is over, when the gate is in fact still open and re-approvable, and no
    // re-notification fires for the same gate. Keep the card and ask them to
    // retry shortly. Only `completed`/`failed` are genuinely resolved.
    if (record.status.kind === "queued" || record.status.kind === "running") {
      return messageInvokeResponse("This review is still being prepared; please try again in a moment.");
    }
    return cardInvokeResponse(buildResolvedCard({ runId, nodeId, outcome: `This review is already ${record.status.kind}.` }));
  }
  // The card embeds the gate it was issued for. If the run has since resumed and
  // re-parked at a DIFFERENT gate, this card is stale — recording now would
  // silently resolve a gate the reviewer never saw (sequential gates A→B: a
  // click on the old card-A must not approve the current gate B). Refuse and
  // refresh the stale card instead.
  if (record.status.nodeId !== nodeId) {
    return cardInvokeResponse(buildResolvedCard({ runId, nodeId, outcome: "This review has moved on to a later step; use the current review card." }));
  }

  const recorded = await deps.hitl.recordDecision(record.runId, record.status.nodeId, action);
  if (!recorded.ok) {
    deps.logger?.error?.("hitl/bot: recordDecision failed", { runId, error: recorded.error.kind });
    return messageInvokeResponse("Failed to record the decision; please retry.");
  }

  const outcome = action.kind === "approve" ? `Approved by ${actor}.` : `Rejected by ${actor}.`;
  return cardInvokeResponse(buildResolvedCard({ runId, nodeId, outcome }));
};
