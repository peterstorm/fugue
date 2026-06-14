/**
 * ConversationStore adapters (ADR-0060) — in-memory (tests/dev) and Redis
 * (production). Persists the Teams conversation reference the bot was added to,
 * so proactive review cards can be posted there. v1 stores a single default
 * reference under one key.
 */

import { z } from "zod";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";
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
  return {
    async saveDefaultReference(r) { ref = r; return ok(undefined); },
    async getDefaultReference() { return ok(ref); },
  };
};

const REF_KEY = "fugue:hitl:bot:convref:default";

export const createRedisConversationStore = (
  redis: RedisPort,
  logger?: LogPort,
): ConversationStorePort => ({
  async saveDefaultReference(ref): Promise<Result<void, HostError>> {
    // Deliberately written WITHOUT an expiry — unlike the run/decision/pending
    // keys (bounded by a run's lifetime), the default conversation reference is
    // the long-lived "where the bot can post" pointer captured once when the bot
    // is added to a channel; a TTL would silently disable proactive review cards
    // after it lapsed. v1 keeps a single such key, so it does not grow unbounded.
    const res = await redis.set(REF_KEY, JSON.stringify(ref));
    if (!res.ok) return err(res.error);
    return ok(undefined);
  },
  async getDefaultReference(): Promise<Result<ConversationReference | null, HostError>> {
    const res = await redis.get(REF_KEY);
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
  },
});
