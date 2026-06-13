/**
 * ConversationStore adapters (ADR-0060) — in-memory (tests/dev) and Redis
 * (production). Persists the Teams conversation reference the bot was added to,
 * so proactive review cards can be posted there. v1 stores a single default
 * reference under one key.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";
import type { RedisPort, LogPort } from "../../../ports.js";
import type { ConversationStorePort, ConversationReference } from "./ports.js";

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
    const res = await redis.set(REF_KEY, JSON.stringify(ref));
    if (!res.ok) return err(res.error);
    return ok(undefined);
  },
  async getDefaultReference(): Promise<Result<ConversationReference | null, HostError>> {
    const res = await redis.get(REF_KEY);
    if (!res.ok) return err(res.error);
    if (res.value === null) return ok(null);
    try {
      return ok(JSON.parse(res.value) as ConversationReference);
    } catch (e) {
      logger?.error?.("hitl/bot: corrupt conversation reference", { error: e instanceof Error ? e.message : String(e) });
      return err({ kind: "internal-invariant-violated", message: "corrupt conversation reference", context: {} });
    }
  },
});
