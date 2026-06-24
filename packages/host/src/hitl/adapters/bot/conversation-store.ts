/**
 * ConversationStore adapters (ADR-0060) — in-memory (tests/dev) and Redis
 * (production). Persists the Teams conversation reference the bot was added to,
 * so proactive review cards can be posted there. It stores a per-team reference
 * (FR-041, so a team's cards reach its own channel) and a single default
 * reference as fallback.
 *
 * SECURITY INVARIANT (load-bearing for AD-4 / FR-013 / SC-001): the Redis store
 * is constructed bound to ONE `TenantId`, so every key is forced under
 * `fugue:<tenant>:hitl:bot:`. Under the per-tenant Redis ACL (`~fugue:<tenant>:*`)
 * a store for tenant A can never name tenant B's conversation references — making
 * a flat cross-tenant convref key unrepresentable.
 */

import { z } from "zod";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";
import type { TenantId } from "../../../domain/tenant.js";
import type { RedisPort, LogPort } from "../../../ports.js";
import type { ConversationStorePort, ConversationReference } from "./ports.js";

/**
 * Shape validator for a persisted conversation reference. Read back off the wire
 * and fed to the connector's `serviceUrl` allowlist check + proactive send, so
 * (like the run/decision read paths) it is PARSED, not `as`-cast — a malformed
 * reference is rejected rather than handed to the outbound transport.
 */
const ConversationReferenceSchema = z.object({
  serviceUrl: z.string().min(1),
  conversationId: z.string().min(1),
  channelId: z.string().optional(),
  botId: z.string().optional(),
});

export const createInMemoryConversationStore = (): ConversationStorePort => {
  let ref: ConversationReference | null = null;
  const teamRefs = new Map<string, ConversationReference>();
  return {
    async saveDefaultReference(r) { ref = r; return ok(undefined); },
    async getDefaultReference() { return ok(ref); },
    async saveTeamReference(team, r) { teamRefs.set(team, r); return ok(undefined); },
    async getTeamReference(team) { return ok(teamRefs.get(team) ?? null); },
  };
};

// The keys are derived from the bound `TenantId`, so every key a store instance
// emits is forced under `fugue:<tenant>:hitl:bot:`. There is no code path that
// builds a convref key without a tenant.
const refKey = (tenant: TenantId): string => `fugue:${tenant}:hitl:bot:convref:default`;
/** Per-team reference key (FR-041). The team id is the routing discriminator so
 *  the notifier delivers a team's cards to its own channel (a confidentiality
 *  measure). It does NOT gate who may act — the authz gate (`canAccessDag`) on the
 *  button-click path does that, regardless of which channel the card reached. */
const teamRefKey = (tenant: TenantId, team: string): string => `fugue:${tenant}:hitl:bot:convref:team:${team}`;

export const createRedisConversationStore = (
  redis: RedisPort,
  tenant: TenantId,
  logger?: LogPort,
): ConversationStorePort => {
  // Persist a reference under `key` WITHOUT an expiry — unlike the
  // run/decision/pending keys (bounded by a run's lifetime), a conversation
  // reference is the long-lived "where the bot can post" pointer captured once
  // when the bot is added to a channel; a TTL would silently disable proactive
  // review cards after it lapsed. One key per channel (default + per team), so it
  // does not grow unbounded.
  const saveRef = async (key: string, ref: ConversationReference): Promise<Result<void, HostError>> => {
    const res = await redis.set(key, JSON.stringify(ref));
    if (!res.ok) return err(res.error);
    return ok(undefined);
  };
  const getRef = async (key: string): Promise<Result<ConversationReference | null, HostError>> => {
    const res = await redis.get(key);
    if (!res.ok) return err(res.error);
    if (res.value === null) return ok(null);
    let raw: unknown;
    try {
      raw = JSON.parse(res.value);
    } catch (e) {
      logger?.error?.("hitl/bot: corrupt conversation reference (malformed JSON)", { error: e instanceof Error ? e.message : String(e) });
      return err({ kind: "internal-invariant-violated", message: "corrupt conversation reference", context: {} });
    }
    const parsed = ConversationReferenceSchema.safeParse(raw);
    if (!parsed.success) {
      logger?.error?.("hitl/bot: corrupt conversation reference (invalid shape)", { error: parsed.error.message });
      return err({ kind: "internal-invariant-violated", message: "corrupt conversation reference", context: {} });
    }
    return ok(parsed.data);
  };
  return {
    saveDefaultReference: (ref) => saveRef(refKey(tenant), ref),
    getDefaultReference: () => getRef(refKey(tenant)),
    saveTeamReference: (team, ref) => saveRef(teamRefKey(tenant, team), ref),
    getTeamReference: (team) => getRef(teamRefKey(tenant, team)),
  };
};
