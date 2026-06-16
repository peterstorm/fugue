// bot.test.ts — Bot Framework in-Teams review transport (ADR-0060):
// pure card builder, proactive notifier, and the inbound activity handler
// (approve/reject buttons, bot-added capture, auth), all with fakes.

import { describe, it, expect, mock } from "bun:test";
import { ok, err } from "@fuguejs/framework";
import type { DagId, RunId, NodeId, Result } from "@fuguejs/framework";
import type { ReviewNotification } from "../../../types.js";
import type { RunRecord } from "../../../types.js";
import type { HitlRunService } from "../../../service.js";
import { buildReviewCard, buildReviewActivity, REVIEW_VERB } from "../card.js";
import { createBotFrameworkNotifier } from "../notifier.js";
import { createInMemoryConversationStore, createRedisConversationStore } from "../conversation-store.js";
import type { BotConnectorPort, VerifyBotToken } from "../ports.js";
import { handleBotActivity } from "../messages-handler.js";
import { isTrustedBotServiceUrl } from "../trusted-host.js";
import type { RedisPort } from "../../../../ports.js";
import type { HostError } from "../../../../domain/host-error.js";

/** A trusted Teams channel serviceUrl (matches the Bot Framework allowlist). */
const TRUSTED_SERVICE_URL = "https://smba.trafficmanager.net/amer/";

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

// A notifier whose `resolveDagTeam` always misses (no team routing) — exercises
// the back-compat default-only delivery path.
const noTeam = (): string | undefined => undefined;

describe("bot notifier", () => {
  it("posts the review activity to the stored default conversation (unmapped team)", async () => {
    const sent: { ref: unknown; activity: unknown }[] = [];
    const connector: BotConnectorPort = { sendToConversation: async (ref, activity) => { sent.push({ ref, activity }); return ok(undefined); } };
    const conversations = createInMemoryConversationStore();
    await conversations.saveDefaultReference({ serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:abc" });

    const res = await createBotFrameworkNotifier({ connector, conversations, resolveDagTeam: noTeam }).notify(notification);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.ref as { conversationId: string }).conversationId).toBe("19:abc");
  });

  it("errs notification-failed when the bot has no conversation reference yet", async () => {
    const connector: BotConnectorPort = { sendToConversation: async () => ok(undefined) };
    const res = await createBotFrameworkNotifier({ connector, conversations: createInMemoryConversationStore(), resolveDagTeam: noTeam }).notify(notification);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("notification-failed");
  });

  // ── Per-team routing (FR-041, confidentiality) ───────────────────────────────
  it("routes to the TEAM channel (not the default) when the run's team has its own reference", async () => {
    const sent: { ref: { conversationId: string }; activity: unknown }[] = [];
    const connector: BotConnectorPort = { sendToConversation: async (ref, activity) => { sent.push({ ref: ref as { conversationId: string }, activity }); return ok(undefined); } };
    const conversations = createInMemoryConversationStore();
    // Both a default AND a per-team reference exist; the team reference must win.
    await conversations.saveDefaultReference({ serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:default" });
    await conversations.saveTeamReference("sales", { serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:sales" });

    const res = await createBotFrameworkNotifier({ connector, conversations, resolveDagTeam: () => "sales" }).notify(notification);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // Confidentiality: the card went to the team channel, NEVER the default.
    expect(sent[0]!.ref.conversationId).toBe("19:sales");
  });

  it("falls back to the default channel when the run's team has NO team reference", async () => {
    const sent: { ref: { conversationId: string } }[] = [];
    const connector: BotConnectorPort = { sendToConversation: async (ref) => { sent.push({ ref: ref as { conversationId: string } }); return ok(undefined); } };
    const conversations = createInMemoryConversationStore();
    await conversations.saveDefaultReference({ serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:default" });
    // Team resolves, but it has no stored reference → fall back to default.
    const res = await createBotFrameworkNotifier({ connector, conversations, resolveDagTeam: () => "sales" }).notify(notification);
    expect(res.ok).toBe(true);
    expect(sent[0]!.ref.conversationId).toBe("19:default");
  });

  it("errs notification-failed when a team resolves but neither a team NOR a default reference exists", async () => {
    const connector: BotConnectorPort = { sendToConversation: async () => ok(undefined) };
    const res = await createBotFrameworkNotifier({ connector, conversations: createInMemoryConversationStore(), resolveDagTeam: () => "sales" }).notify(notification);
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

// ── Approver-authz fixtures (FR-041, US5, SC-006) ────────────────────────────
// The `lead-desk` DAG (the default suspendedRecord) is owned by team "sales".
// Alice (aadObjectId "aad-alice") is a member of "sales" → authorized. Mallory
// ("aad-mallory") is a member of "marketing" only → a non-member, refused.
const DAG_TEAM = "sales";
const APPROVER_TEAMS = { "aad-alice": ["sales"], "aad-mallory": ["marketing"] };
// The Teams team `aadGroupId` → fugue team map (HITL_TEAM_CHANNELS).
const TEAM_CHANNELS: Record<string, string> = { "grp-sales": "sales" };
const resolveDagTeamOk = (): string | undefined => DAG_TEAM;

/** Build the bot deps with the FR-041 authz wiring (team resolver + approver map). */
const botDeps = (
  hitl: HitlRunService,
  conversations = createInMemoryConversationStore(),
  overrides: Partial<Parameters<typeof handleBotActivity>[0]> = {},
): Parameters<typeof handleBotActivity>[0] => ({
  verify: okVerify,
  hitl,
  conversations,
  resolveDagTeam: resolveDagTeamOk,
  approverTeams: APPROVER_TEAMS,
  teamChannels: TEAM_CHANNELS,
  ...overrides,
});

// The clicker carries BOTH a display name and an AAD object id; authz keys on the
// id, the actor label prefers the name. Defaults to Alice (an authorized member).
const invokeActivity = (
  data: Record<string, unknown>,
  from: { name?: string; aadObjectId?: string } = { name: "Alice", aadObjectId: "aad-alice" },
) => ({
  type: "invoke",
  name: "adaptiveCard/action",
  from,
  value: { action: { data } },
});

describe("bot messages handler", () => {
  it("rejects an inbound activity with an invalid token (401)", async () => {
    const verify: VerifyBotToken = async () => err({ kind: "invalid", reason: "bad" });
    const res = await handleBotActivity(
      botDeps(fakeHitl(), undefined, { verify }),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when token verification is unavailable (JWKS down)", async () => {
    const verify: VerifyBotToken = async () => err({ kind: "unavailable", reason: "jwks" });
    const res = await handleBotActivity(
      botDeps(fakeHitl(), undefined, { verify }),
      { authHeader: "Bearer x", activity: {} },
    );
    expect(res.status).toBe(503);
  });

  it("captures the conversation reference when the bot is added", async () => {
    const conversations = createInMemoryConversationStore();
    const res = await handleBotActivity(
      botDeps(fakeHitl(), conversations),
      { authHeader: "Bearer x", activity: { type: "conversationUpdate", serviceUrl: TRUSTED_SERVICE_URL, conversation: { id: "19:team" }, channelId: "msteams" } },
    );
    expect(res.status).toBe(200);
    const ref = await conversations.getDefaultReference();
    expect(ref.ok && ref.value?.conversationId).toBe("19:team");
  });

  it("refuses to persist a conversation reference with an untrusted serviceUrl (SSRF guard)", async () => {
    const conversations = createInMemoryConversationStore();
    const res = await handleBotActivity(
      botDeps(fakeHitl(), conversations),
      { authHeader: "Bearer x", activity: { type: "conversationUpdate", serviceUrl: "https://attacker.example.com/", conversation: { id: "19:evil" }, channelId: "msteams" } },
    );
    expect(res.status).toBe(200);
    // Nothing persisted — the connector must never POST its bearer token there.
    const ref = await conversations.getDefaultReference();
    expect(ref.ok && ref.value).toBe(null);
  });

  // ── Per-team capture (FR-041, confidentiality routing) ───────────────────────
  it("conversationUpdate with a MAPPED team aadGroupId stores a per-team reference (and the default)", async () => {
    const conversations = createInMemoryConversationStore();
    const res = await handleBotActivity(
      botDeps(fakeHitl(), conversations),
      { authHeader: "Bearer x", activity: {
        type: "conversationUpdate",
        serviceUrl: TRUSTED_SERVICE_URL,
        conversation: { id: "19:sales" },
        channelId: "msteams",
        channelData: { team: { aadGroupId: "grp-sales" } },
      } },
    );
    expect(res.status).toBe(200);
    // grp-sales maps to fugue team "sales" → stored under that team key.
    const team = await conversations.getTeamReference("sales");
    expect(team.ok && team.value?.conversationId).toBe("19:sales");
    // Default is STILL stored (back-compat / fallback for unmapped teams).
    const def = await conversations.getDefaultReference();
    expect(def.ok && def.value?.conversationId).toBe("19:sales");
  });

  it("conversationUpdate with an UNMAPPED team aadGroupId stores only the default (no team reference)", async () => {
    const conversations = createInMemoryConversationStore();
    const res = await handleBotActivity(
      botDeps(fakeHitl(), conversations),
      { authHeader: "Bearer x", activity: {
        type: "conversationUpdate",
        serviceUrl: TRUSTED_SERVICE_URL,
        conversation: { id: "19:unknown" },
        channelData: { team: { aadGroupId: "grp-not-mapped" } },
      } },
    );
    expect(res.status).toBe(200);
    // No fugue team for this aadGroupId → no per-team reference.
    expect(await conversations.getTeamReference("sales")).toEqual(ok(null));
    const def = await conversations.getDefaultReference();
    expect(def.ok && def.value?.conversationId).toBe("19:unknown");
  });

  it("a prototype-pollution aadGroupId (e.g. 'constructor') does NOT resolve a team (own-property only)", async () => {
    const conversations = createInMemoryConversationStore();
    const res = await handleBotActivity(
      botDeps(fakeHitl(), conversations),
      { authHeader: "Bearer x", activity: {
        type: "conversationUpdate",
        serviceUrl: TRUSTED_SERVICE_URL,
        conversation: { id: "19:evil" },
        channelData: { team: { aadGroupId: "constructor" } },
      } },
    );
    expect(res.status).toBe(200);
    // "constructor" is an inherited key on the map object — it must NOT resolve a
    // team. No team reference is written under any team derived from it.
    expect(await conversations.getTeamReference("sales")).toEqual(ok(null));
    // The default IS captured (the inbound reference is still trusted).
    const def = await conversations.getDefaultReference();
    expect(def.ok && def.value?.conversationId).toBe("19:evil");
  });

  it("records the reject-with-no-reason default ('(no reason provided)')", async () => {
    const hitl = fakeHitl();
    await handleBotActivity(
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "reject" }) },
    );
    const call = (hitl.recordDecision as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[2]).toEqual({ kind: "reject", reason: "(no reason provided)", actor: "Alice" });
  });

  it("returns a 'Malformed review action.' message when runId/nodeId are missing", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("Malformed review action.");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("records an approve decision and refreshes the card", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
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
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "reject", reason: "wrong tone" }) },
    );
    const call = (hitl.recordDecision as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[2]).toEqual({ kind: "reject", reason: "wrong tone", actor: "Alice" });
  });

  it("does not record a decision when the run is already resolved", async () => {
    const hitl = fakeHitl({ getRun: async () => ok(suspendedRecord({ status: { kind: "completed", output: 1 } })) });
    const res = await handleBotActivity(
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("does NOT record when a stale card's gate differs from the run's current gate", async () => {
    // The run has resumed and re-parked at a LATER gate ("review-2"); the click
    // arrives from the old card-A ("review"). Recording now would silently
    // approve gate B, which the reviewer never saw.
    const hitl = fakeHitl({
      getRun: async () => ok(suspendedRecord({ status: { kind: "suspended", nodeId: "review-2" as NodeId, prompt: "ok?" } })),
    });
    const res = await handleBotActivity(
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    // Stale card is refreshed, no decision recorded.
    expect((res.body as { type: string }).type).toBe("application/vnd.microsoft.card.adaptive");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("rejects a malformed runId off the wire ('Malformed review action.') without recording", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      // "../secret" contains '/' and '.', neither permitted by ID_REGEX.
      { authHeader: "Bearer x", activity: invokeActivity({ verb: REVIEW_VERB, runId: "../secret", nodeId: "review", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("Malformed review action.");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    // getRun must never see an unparsed id.
  });

  it("ignores a card action that isn't ours (foreign verb)", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity({ verb: "someone.else", runId: "x", nodeId: "y", decision: "approve" }) },
    );
    expect(res.status).toBe(200);
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

// ── Approver team-authz (FR-041, US5, SC-006) — PARITY with the HTTP path ─────
// The Teams button path must authorize the clicking user against the run's
// owning team exactly as `runs.ts#authorizeRunAccess` does: a member records, a
// non-member / unknown user is refused WITHOUT recording.
describe("bot messages handler — approver authorization (FR-041, SC-006)", () => {
  const approve = { verb: REVIEW_VERB, runId: "run-1", nodeId: "review", decision: "approve" };

  it("a member of the run's team (resolved from aadObjectId) records the decision", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      // Alice (aad-alice) ∈ "sales", the lead-desk DAG's team.
      { authHeader: "Bearer x", activity: invokeActivity(approve, { name: "Alice", aadObjectId: "aad-alice" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string }).type).toBe("application/vnd.microsoft.card.adaptive");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  it("SC-006: a NON-MEMBER's click is REFUSED and recordDecision is NEVER called", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      // Mallory (aad-mallory) ∈ "marketing" only — NOT the lead-desk team "sales".
      { authHeader: "Bearer x", activity: invokeActivity(approve, { name: "Mallory", aadObjectId: "aad-mallory" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("You are not authorized to act on this review.");
    // The load-bearing parity assertion: NO decision recorded for a non-member.
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("an UNKNOWN aadObjectId (not in HITL_APPROVER_TEAMS) fails closed — no record", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      { authHeader: "Bearer x", activity: invokeActivity(approve, { name: "Eve", aadObjectId: "aad-unknown" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("You are not authorized to act on this review.");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("a click carrying NO aadObjectId fails closed (cannot resolve a member) — no record", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl),
      // Only a display name, no aadObjectId — unidentifiable, refused.
      { authHeader: "Bearer x", activity: invokeActivity(approve, { name: "Anon" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("You are not authorized to act on this review.");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("a run whose DAG is no longer registered fails closed (team unresolvable) — no record", async () => {
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      // resolveDagTeam returns undefined → cannot establish the run's team.
      botDeps(hitl, undefined, { resolveDagTeam: () => undefined }),
      { authHeader: "Bearer x", activity: invokeActivity(approve, { name: "Alice", aadObjectId: "aad-alice" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("You are not authorized to act on this review.");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("a member of a DIFFERENT team than the run's is refused (cross-team isolation)", async () => {
    // The run is owned by "marketing"; Alice ∈ "sales" only. Even though Alice is
    // a known approver, she is not a member of THIS run's team → refused.
    const hitl = fakeHitl();
    const res = await handleBotActivity(
      botDeps(hitl, undefined, { resolveDagTeam: () => "marketing" }),
      { authHeader: "Bearer x", activity: invokeActivity(approve, { name: "Alice", aadObjectId: "aad-alice" }) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { type: string; value: string }).value).toBe("You are not authorized to act on this review.");
    expect((hitl.recordDecision as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

// ── serviceUrl allowlist ───────────────────────────────────────────────────

describe("isTrustedBotServiceUrl", () => {
  it("accepts the Microsoft Bot Framework / Teams service hosts over https", () => {
    expect(isTrustedBotServiceUrl("https://smba.trafficmanager.net/amer/")).toBe(true);
    expect(isTrustedBotServiceUrl("https://smba.trafficmanager.net/emea/")).toBe(true);
    expect(isTrustedBotServiceUrl("https://uksouth.smba.trafficmanager.net/uk/")).toBe(true);
    expect(isTrustedBotServiceUrl("https://api.botframework.com")).toBe(true);
    expect(isTrustedBotServiceUrl("https://x.skype.com/")).toBe(true);
  });

  it("rejects http, foreign hosts, look-alikes, and unparseable values", () => {
    expect(isTrustedBotServiceUrl("http://smba.trafficmanager.net/amer/")).toBe(false); // not https
    expect(isTrustedBotServiceUrl("https://attacker.example.com/")).toBe(false);
    expect(isTrustedBotServiceUrl("https://smba.trafficmanager.net.evil.com/")).toBe(false); // suffix look-alike
    expect(isTrustedBotServiceUrl("https://evilbotframework.com/")).toBe(false); // not a dot-suffix
    expect(isTrustedBotServiceUrl("not a url")).toBe(false);
    expect(isTrustedBotServiceUrl("")).toBe(false);
  });
});

// ── Redis ConversationStore ─────────────────────────────────────────────────

const fakeRedis = (): RedisPort & { _set: (k: string, v: string) => void } => {
  const m = new Map<string, string>();
  return {
    _set: (k, v) => m.set(k, v),
    async get(k) { return ok(m.get(k) ?? null); },
    async set(k, v) { m.set(k, v); return ok("OK" as string | null); },
    async del(k) { const had = m.delete(k); return ok(had ? 1 : 0); },
    async scan() { return ok({ cursor: "0", keys: [...m.keys()] }); },
    async setNx(k, v) { if (m.has(k)) return ok(false); m.set(k, v); return ok(true); },
  } as RedisPort & { _set: (k: string, v: string) => void };
};

describe("createRedisConversationStore", () => {
  const REF_KEY = "fugue:hitl:bot:convref:default";

  it("round-trips the default reference and returns null when unset", async () => {
    const store = createRedisConversationStore(fakeRedis());
    expect((await store.getDefaultReference())).toEqual(ok(null));
    await store.saveDefaultReference({ serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:abc" });
    const got = await store.getDefaultReference();
    expect(got.ok && got.value?.conversationId).toBe("19:abc");
  });

  it("errs internal-invariant-violated on a corrupt (non-JSON) stored reference", async () => {
    const redis = fakeRedis();
    redis._set(REF_KEY, "{not json");
    const store = createRedisConversationStore(redis);
    const got = await store.getDefaultReference();
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe("internal-invariant-violated");
  });

  it("propagates a Redis get failure", async () => {
    const broken: RedisPort = { ...fakeRedis(), async get(): Promise<Result<string | null, HostError>> { return err({ kind: "redis-unavailable", operation: "GET" }); } };
    const store = createRedisConversationStore(broken);
    const got = await store.getDefaultReference();
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe("redis-unavailable");
  });

  // ── Per-team conversation routing (FR-041) ──────────────────────────────────
  it("round-trips PER-TEAM references under distinct keys; one team's ref does not leak to another", async () => {
    const store = createRedisConversationStore(fakeRedis());
    // A team with no reference returns null (caller falls back to default).
    expect(await store.getTeamReference("sales")).toEqual(ok(null));

    await store.saveTeamReference("sales", { serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:sales" });
    await store.saveTeamReference("marketing", { serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:marketing" });

    const sales = await store.getTeamReference("sales");
    const marketing = await store.getTeamReference("marketing");
    expect(sales.ok && sales.value?.conversationId).toBe("19:sales");
    expect(marketing.ok && marketing.value?.conversationId).toBe("19:marketing");
    // The default key is independent of any team key.
    expect(await store.getDefaultReference()).toEqual(ok(null));
  });

  it("the in-memory store routes per-team references the same way (parity)", async () => {
    const store = createInMemoryConversationStore();
    expect(await store.getTeamReference("sales")).toEqual(ok(null));
    await store.saveTeamReference("sales", { serviceUrl: TRUSTED_SERVICE_URL, conversationId: "19:sales" });
    const got = await store.getTeamReference("sales");
    expect(got.ok && got.value?.conversationId).toBe("19:sales");
    // A different team still has no reference — no cross-team leakage.
    expect(await store.getTeamReference("marketing")).toEqual(ok(null));
  });
});
