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
import { reviewCardBody } from "./bot/card.js";

/** A minimal JSON POST transport — injected so the notifier is fakeable. */
export interface WebhookHttp {
  /** POST a JSON body to `url`. Resolves to the HTTP status; rejects only on a transport-level failure. */
  readonly post: (url: string, jsonBody: string) => Promise<{ readonly status: number }>;
}

interface WebhookNotifierConfig {
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
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: reviewCardBody(notification),
          actions: [{ type: "Action.OpenUrl", title: "Review", url: link }],
        },
      },
    ],
  };
};

/**
 * Construct the webhook notifier. `notify` POSTs the card; a non-2xx status is
 * surfaced as a `notification-failed` (HTTP 502) on the Result channel — the
 * review hook treats a notify failure as non-fatal (the run stays parked) and
 * logs it — and a transport rejection is mapped the same way rather than thrown.
 */
export const createWebhookNotifier = (
  config: WebhookNotifierConfig,
  http: WebhookHttp,
): HumanReviewNotifierPort => ({
  async notify(notification): Promise<Result<void, HostError>> {
    // The whole card build runs INSIDE the try so any residual throw (a
    // hostile output that defeats both JSON.stringify and the total fallback)
    // maps to `notification-failed` instead of escaping as a raw rejection
    // (the review hook would escalate a PARKED run to a retriable node-failed).
    let body: string;
    try {
      body = JSON.stringify(buildAdaptiveCardPayload(notification, config.approvalBaseUrl));
    } catch (e) {
      return err({
        kind: "notification-failed",
        operation: `Teams webhook card build: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
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
