// webhook-notifier.test.ts — the smoke-test Teams transport (ADR-0060).
// Asserts the Adaptive Card body, the approval deep-link, and status mapping
// with an injected fake HTTP transport (no network).

import { describe, it, expect } from "bun:test";
import { nonEmptyString } from "@fuguejs/framework";
import type { DagId, RunId, NodeId } from "@fuguejs/framework";
import { markTeam } from "../../../domain/auth.js";
import type { ReviewNotification } from "../../types.js";
import {
  buildAdaptiveCardPayload,
  approvalUrl,
  createWebhookNotifier,
  type WebhookHttp,
} from "../webhook-notifier.js";

const notification: ReviewNotification = {
  runId: "run-42" as RunId,
  dagId: "lead-desk" as DagId,
  ownerTeam: markTeam("sales"),
  nodeId: "review" as NodeId,
  prompt: nonEmptyString("Approve the drafted reply?"),
  output: { reply: "Hello!" },
};

describe("webhook notifier — card payload", () => {
  it("builds an Adaptive Card with the prompt and an OpenUrl approval deep-link", () => {
    const payload = buildAdaptiveCardPayload(notification, "https://fugue.example.com/") as {
      attachments: { content: { body: { text?: string }[]; actions: { type: string; url: string }[] } }[];
    };
    const card = payload.attachments[0]!.content;
    const texts = card.body.map((b) => b.text ?? "").join("\n");

    expect(texts).toContain("Approve the drafted reply?");
    expect(texts).toContain("lead-desk");
    expect(texts).toContain("review");
    expect(texts).toContain("run-42");

    expect(card.actions).toHaveLength(1);
    expect(card.actions[0]!.type).toBe("Action.OpenUrl");
    expect(card.actions[0]!.url).toBe("https://fugue.example.com/runs/run-42");
  });

  it("approvalUrl trims a trailing slash and encodes the run id", () => {
    expect(approvalUrl("https://h.example.com/", "run/1")).toBe("https://h.example.com/runs/run%2F1");
  });
});

describe("webhook notifier — POST + status mapping", () => {
  const cfg = { webhookUrl: "https://teams.example.com/hook", approvalBaseUrl: "https://fugue.example.com" };

  it("POSTs the card to the webhook URL and returns ok on 2xx", async () => {
    const calls: { url: string; body: string }[] = [];
    const http: WebhookHttp = { post: async (url, body) => { calls.push({ url, body }); return { status: 200 }; } };

    const res = await createWebhookNotifier(cfg, http).notify(notification);

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://teams.example.com/hook");
    expect(calls[0]!.body).toContain("Approve the drafted reply?");
  });

  it("maps a non-2xx status to notification-failed", async () => {
    const http: WebhookHttp = { post: async () => ({ status: 429 }) };
    const res = await createWebhookNotifier(cfg, http).notify(notification);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("notification-failed");
      expect("operation" in res.error && res.error.operation).toContain("429");
    }
  });

  it("maps a transport rejection to notification-failed (never throws)", async () => {
    const http: WebhookHttp = { post: async () => { throw new Error("socket reset"); } };
    const res = await createWebhookNotifier(cfg, http).notify(notification);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
  });

  it("renders a hostile output through the TOTAL preview fallback (never a raw rejection, never a throw)", async () => {
    // A cyclic NULL-PROTOTYPE output: JSON.stringify throws (circular), and
    // the old catch fallback `String(output)` threw AGAIN (null-prototype has
    // no toString) — a raw rejection that would escalate a parked run to
    // node-failed. The shared total renderer must produce a preview string
    // for this class; the card build itself is inside notify's guarded body.
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile; // circular AND null-prototype
    const bodies: string[] = [];
    const http: WebhookHttp = {
      post: async (_url, body) => { bodies.push(body); return { status: 200 }; },
    };
    const res = await createWebhookNotifier(cfg, http).notify({ ...notification, output: hostile });
    expect(res.ok).toBe(true);
    // A preview is still embedded in the POSTed body — the fallback rendered.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.length).toBeGreaterThan(0);
    expect(() => JSON.parse(bodies[0]!)).not.toThrow();
  });
});
