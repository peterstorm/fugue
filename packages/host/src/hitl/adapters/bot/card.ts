/**
 * Bot Framework Adaptive Card builders (ADR-0060) — the IN-Teams review UX.
 *
 * Unlike the webhook transport (which can only link out), a Bot Framework card
 * carries `Action.Execute` buttons whose clicks POST back to the bot endpoint,
 * so a reviewer approves/rejects WITHOUT leaving Teams. Each button submits a
 * `data` payload tagged with our `verb` plus the `(runId, nodeId)` it resolves;
 * the inbound handler maps that to a `HumanAction`.
 *
 * All builders here are PURE and exported so the exact card body — buttons,
 * verb, run/node identity, and the reason input — is unit-testable with no bot,
 * no network.
 */

import type { ReviewNotification } from "../../types.js";
import { safeErrorMessage } from "@fuguejs/framework";

/** The `verb` tagging our card actions, so the bot endpoint ignores foreign cards. */
export const REVIEW_VERB = "fugue.review" as const;

/** The decision payload an `Action.Execute` button submits back to the bot. */
interface ReviewActionData {
  readonly verb: typeof REVIEW_VERB;
  readonly runId: string;
  readonly nodeId: string;
  readonly decision: "approve" | "reject";
}

/**
 * TOTAL preview renderer for the output under review (shared by the bot and
 * webhook transports — ONE encoding). `JSON.stringify` fails on cyclic
 * values; the catch fallback must itself be total: `String(output)` can THROW
 * again on a null-prototype object or a hostile `toString`/`Symbol.toPrimitive`
 * (a second throw would escape the notify surface as a raw rejection and the
 * review hook would escalate a parked run to a retriable node-failed).
 * `safeErrorMessage` is the framework's never-throwing renderer — constant
 * fallback, diagnostics safe for arbitrary thrown values (FR-040).
 */
export const outputPreview = (output: unknown): string => {
  let s: string;
  try {
    s = JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    s = safeErrorMessage(output);
  }
  return s.length > 4000 ? `${s.slice(0, 4000)}\n… (truncated)` : s;
};

/** Common review content; transports append only their interaction controls. */
export const reviewCardBody = (n: ReviewNotification): readonly unknown[] => [
  { type: "TextBlock", size: "Large", weight: "Bolder", text: "Human review required" },
  {
    type: "TextBlock",
    isSubtle: true,
    wrap: true,
    text: `DAG \`${n.dagId}\` · node \`${n.nodeId}\` · run \`${n.runId}\``,
  },
  { type: "TextBlock", wrap: true, text: n.prompt },
  { type: "TextBlock", weight: "Bolder", text: "Output under review:" },
  { type: "TextBlock", wrap: true, fontType: "Monospace", text: outputPreview(n.output) },
];

/**
 * Build the Adaptive Card CONTENT for a parked review. Two `Action.Execute`
 * buttons (Approve / Reject) tagged with `REVIEW_VERB` + the gate identity, and
 * a `reason` text input the Reject path reads. Exported for assertion.
 */
export const buildReviewCard = (n: ReviewNotification): unknown => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    ...reviewCardBody(n),
    { type: "Input.Text", id: "reason", isMultiline: true, placeholder: "Reason (required to reject)" },
  ],
  actions: [
    {
      type: "Action.Execute",
      title: "Approve",
      style: "positive",
      verb: REVIEW_VERB,
      data: { verb: REVIEW_VERB, runId: n.runId, nodeId: n.nodeId, decision: "approve" } satisfies ReviewActionData,
    },
    {
      type: "Action.Execute",
      title: "Reject",
      style: "destructive",
      verb: REVIEW_VERB,
      data: { verb: REVIEW_VERB, runId: n.runId, nodeId: n.nodeId, decision: "reject" } satisfies ReviewActionData,
    },
  ],
});

/**
 * Build the proactive ACTIVITY body (a Bot Framework `message` with the review
 * card attached) the connector posts to a conversation. Exported for assertion.
 */
export const buildReviewActivity = (n: ReviewNotification): unknown => ({
  type: "message",
  attachments: [
    { contentType: "application/vnd.microsoft.card.adaptive", content: buildReviewCard(n) },
  ],
});

/**
 * Build the Adaptive Card shown AFTER a decision (the invoke response refreshes
 * the original card in place, so the buttons are replaced by an outcome line).
 */
export const buildResolvedCard = (n: { runId: string; nodeId: string; outcome: string }): unknown => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", size: "Large", weight: "Bolder", text: "Review recorded" },
    { type: "TextBlock", wrap: true, text: n.outcome },
    { type: "TextBlock", isSubtle: true, wrap: true, text: `run \`${n.runId}\` · node \`${n.nodeId}\`` },
  ],
});
