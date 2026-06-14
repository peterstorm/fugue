/**
 * Webhook review notifier (ADR-0060) — the smoke-test Teams transport.
 *
 * Posts an Adaptive Card to a Teams Incoming Webhook (Workflows) URL. Incoming
 * webhooks CANNOT receive interactive button callbacks — a card posted this way
 * only supports `Action.OpenUrl` — so the card deep-links OUT to the run's status
 * endpoint (`<approvalBaseUrl>/runs/<runId>`), which returns auth-protected JSON
 * (there is no rendered approval page). Actually approving over this transport is
 * the authenticated `POST /runs/<runId>/approve` call — the deep-link only points
 * the reviewer at the run. This is deliberately the low-ceremony transport that
 * proves the whole loop end-to-end with zero Azure setup; the in-Teams
 * Approve/Reject button UX is the Bot Framework adapter (a later, additive layer
 * — the engine is identical).
 *
 * The HTTP transport is INJECTED so the card body + target URL are unit-testable
 * with no network. `buildAdaptiveCardPayload` is pure and exported for the same
 * reason.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { HumanReviewNotifierPort } from "../ports.js";
import type { ReviewNotification } from "../types.js";

/** A minimal JSON POST transport — injected so the notifier is fakeable. */
export interface WebhookHttp {
  /** POST a JSON body to `url`. Resolves to the HTTP status; rejects only on a transport-level failure. */
  readonly post: (url: string, jsonBody: string) => Promise<{ readonly status: number }>;
}

export interface WebhookNotifierConfig {
  /** Teams Incoming Webhook (Workflows) URL the card is POSTed to. */
  readonly webhookUrl: string;
  /**
   * Base URL of the host, e.g. `https://fugue.example.com`. The card's "Review"
   * button deep-links to the run's status endpoint `<approvalBaseUrl>/runs/<runId>`
   * (auth-protected JSON); approval itself is `POST <approvalBaseUrl>/runs/<runId>/approve`.
   */
  readonly approvalBaseUrl: string;
}

/** The approval deep-link a reviewer follows from the card. */
export const approvalUrl = (approvalBaseUrl: string, runId: string): string =>
  `${approvalBaseUrl.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}`;

/**
 * Build the Teams `attachments`-envelope Adaptive Card for a parked review.
 * PURE and exported so a test asserts the prompt, the run/node identity, and the
 * single `Action.OpenUrl` deep-link without any network.
 */
export const buildAdaptiveCardPayload = (
  notification: ReviewNotification,
  approvalBaseUrl: string,
): unknown => {
  const link = approvalUrl(approvalBaseUrl, notification.runId);
  // A compact, valid preview of the output under review (best-effort stringify).
  let outputPreview: string;
  try {
    outputPreview = JSON.stringify(notification.output, null, 2) ?? String(notification.output);
  } catch {
    outputPreview = String(notification.output);
  }
  // Bound the preview so a large output doesn't bloat the card.
  if (outputPreview.length > 4000) outputPreview = `${outputPreview.slice(0, 4000)}\n… (truncated)`;

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", size: "Large", weight: "Bolder", text: "Human review required" },
            {
              type: "TextBlock",
              isSubtle: true,
              wrap: true,
              text: `DAG \`${notification.dagId}\` · node \`${notification.nodeId}\` · run \`${notification.runId}\``,
            },
            { type: "TextBlock", wrap: true, text: notification.prompt },
            { type: "TextBlock", weight: "Bolder", text: "Output under review:" },
            { type: "TextBlock", wrap: true, fontType: "Monospace", text: outputPreview },
          ],
          actions: [{ type: "Action.OpenUrl", title: "Review", url: link }],
        },
      },
    ],
  };
};

/**
 * Construct the webhook notifier. `notify` POSTs the card; a non-2xx status is a
 * `redis-unavailable`-style infra failure on the Result channel (the review
 * hook treats a notify failure as non-fatal — the run stays parked — and logs
 * it), and a transport rejection is mapped the same way rather than thrown.
 */
export const createWebhookNotifier = (
  config: WebhookNotifierConfig,
  http: WebhookHttp,
): HumanReviewNotifierPort => ({
  async notify(notification): Promise<Result<void, HostError>> {
    const body = JSON.stringify(buildAdaptiveCardPayload(notification, config.approvalBaseUrl));
    let res: { status: number };
    try {
      res = await http.post(config.webhookUrl, body);
    } catch (e) {
      return err({
        kind: "notification-failed",
        operation: `Teams webhook POST: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (res.status < 200 || res.status >= 300) {
      return err({ kind: "notification-failed", operation: `Teams webhook POST returned HTTP ${res.status}` });
    }
    return ok(undefined);
  },
});

/** Production `WebhookHttp` over `fetch`. */
export const fetchWebhookHttp = (): WebhookHttp => ({
  async post(url, jsonBody) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBody,
    });
    return { status: res.status };
  },
});
