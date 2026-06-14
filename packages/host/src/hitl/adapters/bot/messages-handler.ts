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
 * Behaviour by activity type:
 *   - conversationUpdate (bot added) → capture + persist the conversation
 *     reference so proactive review cards can be posted there later.
 *   - invoke `adaptiveCard/action` with our verb → map the button to a
 *     HumanAction, record the decision (resuming the run), refresh the card.
 *   - anything else → 200 no-op.
 *
 * SECURITY CONSTRAINT (v1, ADR-0060): unlike the HTTP approval path
 * (`runs.ts#authorizeRunAccess`, which authorizes the caller against the run's
 * owning DAG team), the in-Teams button path does NOT yet bind the clicking user
 * to the run's team — v1 keeps a single default conversation reference and there
 * is no AAD→fugue-identity→team mapping. Therefore ANYONE who can click a card
 * in the channel the bot was added to can approve/reject ANY run. The bot MUST
 * only be installed in a channel whose members are all authorised approvers for
 * every team whose runs gate through it. Per-team conversation routing +
 * click-time authorization is tracked as a follow-up (see docs/hitl-teams.md and
 * ADR-0060 Consequences).
 */

import { match } from "ts-pattern";
import type { HumanAction } from "@fuguejs/framework";
import { tryRunId, tryNodeId } from "@fuguejs/framework";
import type { HitlRunService } from "../../service.js";
import type { LogPort } from "../../../ports.js";
import type { ConversationStorePort, VerifyBotToken, ConversationReference } from "./ports.js";
import { REVIEW_VERB, buildResolvedCard } from "./card.js";
import { isTrustedBotServiceUrl } from "./trusted-host.js";

export interface BotMessagesDeps {
  readonly verify: VerifyBotToken;
  readonly hitl: Pick<HitlRunService, "getRun" | "recordDecision">;
  readonly conversations: ConversationStorePort;
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
      const saved = await deps.conversations.saveDefaultReference(ref);
      if (!saved.ok) deps.logger?.error?.("hitl/bot: failed to persist conversation reference", { error: saved.error.kind });
      else deps.logger?.info?.("hitl/bot: captured conversation reference for proactive reviews");
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
  const actor = str(obj(activity.from).name) ?? str(obj(activity.from).aadObjectId) ?? "teams-user";
  const action = toAction(decision, str(data.reason), actor);
  if (action === null) return messageInvokeResponse(`Unknown decision '${decision}'.`);

  // 4. The gate must still be open. If the run already resolved, refresh the
  // card to say so rather than recording a stale decision.
  const fetched = await deps.hitl.getRun(runId);
  if (!fetched.ok) return messageInvokeResponse("Could not load the run.");
  const record = fetched.value;
  if (record === null) return messageInvokeResponse(`Run '${runId}' not found.`);
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
