// bot.test.ts — Bot Framework in-Teams review transport (ADR-0060):
// pure card builder, proactive notifier, and the inbound activity handler
// (approve/reject buttons, bot-added capture, auth), all with fakes.

import { describe, it, expect, mock } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { DagId, RunId, NodeId } from "@fuguejs/framework";
import type { ReviewNotification } from "../../../types.js";
import type { RunRecord } from "../../../types.js";
import type { HitlRunService } from "../../../service.js";
import { buildReviewCard, buildReviewActivity, REVIEW_VERB } from "../card.js";
import { createBotFrameworkNotifier } from "../notifier.js";
import { createInMemoryConversationStore } from "../conversation-store.js";
import type { BotConnectorPort, VerifyBotToken } from "../ports.js";
import { handleBotActivity } from "../messages-handler.js";

const notification: ReviewNotification = {
  runId: "run-1" as RunId,
  dagId: "lead-desk" as DagId,
  nodeId: "review" as NodeId,
  prompt: "Approve the reply?",
  output: { reply: "Hi" },
};

// ── card ─────────────────────────────────────────────────────────────────────

describe("bot card", () => {
  it("builds an Adaptive Card with verb-tagged Approve/Reject Execute actions and a reason input", () => {
    const card = buildReviewCard(notification) as {
      body: { type: string; id?: string }[];
      actions: { type: string; title: string; verb: string; data: Record<string, unknown> }[];
    };
    expect(card.actions.map((a) => a.title)).toEqual(["Approve", "Reject"]);
    for (const a of card.actions) {
      expect(a.type).toBe("Action.Execute");
      expect(a.verb).toBe(REVIEW_VERB);
      expect(a.data.verb).toBe(REVIEW_VERB);
      expect(a.data.runId).toBe("run-1");
      expect(a.data.nodeId).toBe("review");
    }
    expect(card.actions[0]!.data.decision).toBe("approve");
    expect(card.actions[1]!.data.decision).toBe("reject");
    expect(card.body.some((b) => b.type === "Input.Text" && b.id === "reason")).toBe(true);
  });

  it("wraps the card in a message activity attachment", () => {
    const act = buildReviewActivity(notification) as { type: string; attachments: { contentType: string }[] };
    expect(act.type).toBe("message");
    expect(act.attachments[0]!.contentType).toBe("application/vnd.microsoft.card.adaptive");
  });
});

// ── notifier ─────────────────────────────────────────────────────────────────

describe("bot notifier", () => {
  it("posts the review activity to the stored conversation", async () => {
    const sent: { ref: unknown; activity: unknown }[] = [];
    const connector: BotConnectorPort = { sendToConversation: async (ref, activity) => { sent.push({ ref, activity }); return ok(undefined); } };
    const conversations = createInMemoryConversationStore();
    await conversations.saveDefaultReference({ serviceUrl: "https://smba.example/", conversationId: "19:abc" });

    const res = await createBotFrameworkNotifier({ connector, conversations }).notify(notification);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.ref as { conversationId: string }).conversationId).toBe("19:abc");
  });

  it("errs notification-failed when the bot has no conversation reference yet", async () => {
    const connector: BotConnectorPort = { sendToConversation: async () => ok(undefined) };
    const res = await createBotFrameworkNotifier({ connector, conversations: createInMemoryConversationStore() }).notify(notification);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
  });
});

// ── inbound handler ──────────────────────────────────────────────────────────

const okVerify: VerifyBotToken = async () => ok(undefined);

const suspendedRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId: "run-1" as RunId,
  dagId: "lead-desk" as DagId,
  input: {},
  identity: { kind: "admin" },
  status: { kind: "suspended", nodeId: "review" as NodeId, prompt: "ok?" },
  checkpoint: "{}",
  createdAtMs: 1,
  updatedAtMs: 1,
  ...overrides,
});

const fakeHitl = (overrides: Partial<HitlRunService> = {}): HitlRunService => ({
  startRun: async () => ok({ runId: "run-1" as RunId }),
  processRun: async () => ok(undefined),
  recordDecision: mock(async () => ok(undefined)),
  getRun: async () => ok(suspendedRecord()),
  ...overrides,
});

const invokeActivity = (data: Record<string, unknown>, from = "Alice") => ({
  type: "invoke",
  name: "adaptiveCard/action",
  from: { name: from },
  value: { action: { data } },
});

describe("bot messages handler", () => {
  it("rejects an inbound activity with an invalid token (401)", async () => {
    const verify: VerifyBotToken = async () => err({ kind: "invalid", reason: "bad" });
    const res = await handleBotActivity(
      { verify, hitl: fakeHitl(), conversations: createInMemoryConversationStore() },
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when token verification is unavailable (JWKS down)", async () => {
    const verify: VerifyBotToken = async () => err({ kind: "unavailable", reason: "jwks" });
    const res = await handleBotActivity(
      { verify, hitl: fakeHitl(), conversations: createInMemoryConversationStore() },
      { authHeader: "Bearer x", activity: {} },
    );
    expect(res.status).toBe(503);
  });

  it("captures the conversation reference when the bot is added", async () => {
    const conversations = createInMemoryConversationStore();
    const res = await handleBotActivity(
      { verify: okVerify, hitl: fakeHitl(), conversations },
      { authHeader: "Bearer x", activity: { type: "conversationUpdate", serviceUrl: "https://smba/", conversation: { id: "19:team" }, channelId: "msteams" } },
    );
    expect(res.status).toBe(200);
    const ref = await conversations.getDefaultReference();
    expect(ref.ok && ref.value?.conversationId).toBe("19:team");
  });

  it("records an approve decision and refreshes the card", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      { verify: okVerify, hitl, conversations: createInMemoryConversationStore() },
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string }).type).toBe("application/vnd.microsoft.card.adaptive");
    const call = (hitl.recordDecision as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[1]).toBe("review" as NodeId);
    expect(call[2]).toEqual({ kind: "approve", actor: "Alice" });
  });

  it("maps reject with the card's reason input", async () => {
    const hitl = fakeHitl();
    await handleBotActivity(
      { verify: okVerify, hitl, conversations: createInMemoryConversationStore() },
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "reject", reason: "wrong tone" }) },
    );
    const call = (hitl.recordDecision as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[2]).toEqual({ kind: "reject", reason: "wrong tone", actor: "Alice" });
  });

  it("does not record a decision when the run is already resolved", async () => {
    const hitl = fakeHitl({ getRun: async () => ok(suspendedRecord({ status: { kind: "completed", output: 1 } })) });
    const res = await handleBotActivity(
      { verify: okVerify, hitl, conversations: createInMemoryConversationStore() },
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("ignores a card action that isn't ours (foreign verb)", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      { verify: okVerify, hitl, conversations: createInMemoryConversationStore() },
      { authHeader: "Bearer x", activity: invokeActivity({ verb: "someone.else", runId: "x", nodeId: "y", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});
