/**
 * DecisionStore adapters (ADR-0060) — in-memory (tests/dev) and Redis (prod).
 *
 * Tracks, per `(runId, nodeId)` human gate: whether it is pending (so a
 * resume-then-re-park loop notifies only once) and the human's decision (so a
 * resume resolves the gate). `markPending` is atomic create-once via `SET NX`.
 *
 * Redis key layout (KEY_SEP between runId/nodeId — see below):
 *   fugue:hitl:pending:<runId>␟<nodeId>   →  "1"            (presence = pending)
 *   fugue:hitl:decision:<runId>␟<nodeId>  →  JSON HumanAction
 */

import { z } from "zod";
import { ok, err } from "@fuguejs/framework";
import type { Result, RunId, NodeId, HumanAction } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { RedisPort, LogPort } from "../../ports.js";
import type { DecisionStorePort } from "../ports.js";

/**
 * Shape validator for a persisted `HumanAction` (ADR-0060). The decision is read
 * back off the wire (Redis) and then drives the exhaustive transition match on
 * resume, so — exactly like the `tryRunId`/`tryNodeId` smart constructors on the
 * HTTP/bot read paths — it must be PARSED, not `as`-cast: a structurally-invalid
 * value (unknown `kind`, an `approve-with-edit` missing `newOutput`, a `reject`
 * missing `reason`) must be rejected here rather than resuming a run with a
 * corrupt decision. Branded ids validate as strings (the brand is compile-time).
 */
const HumanActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve"), actor: z.string().optional() }),
  z.object({ kind: z.literal("approve-with-edit"), newOutput: z.unknown(), actor: z.string().optional() }),
  z.object({ kind: z.literal("reject"), reason: z.string(), actor: z.string().optional() }),
  z.object({ kind: z.literal("reroute"), targetNodeId: z.string().min(1), reason: z.string().optional(), actor: z.string().optional() }),
]);

/**
 * Composite-key separator between `runId` and `nodeId`. The unit separator
 * (U+001F) is chosen deliberately: it is OUTSIDE the id alphabet
 * (`ID_REGEX = /^[A-Za-z0-9_:-]+$/`) so the two-part key is injective — unlike
 * a `:` separator, which collides because `:` is a legal id character
 * (`(runId="a:b", nodeId="c")` and `(runId="a", nodeId="b:c")` would otherwise
 * map to the same key). Unlike a NUL byte (also outside the alphabet) it keeps
 * the source/keys git-text and grep-friendly rather than classifying the file
 * as binary.
 */
const KEY_SEP = "\x1f";

// ── In-Memory Adapter (tests/dev) ───────────────────────────────────────────

export const createInMemoryDecisionStore = (): DecisionStorePort => {
  const pending = new Set<string>();
  const decisions = new Map<string, HumanAction>();
  const key = (runId: RunId, nodeId: NodeId) => `${runId}${KEY_SEP}${nodeId}`;
  return {
    async markPending(runId, nodeId) {
      const k = key(runId, nodeId);
      if (pending.has(k)) return ok(false);
      pending.add(k);
      return ok(true);
    },
    async isPending(runId, nodeId) {
      return ok(pending.has(key(runId, nodeId)));
    },
    async putDecision(runId, nodeId, action) {
      decisions.set(key(runId, nodeId), action);
      return ok(undefined);
    },
    async getDecision(runId, nodeId) {
      return ok(decisions.get(key(runId, nodeId)) ?? null);
    },
    async clear(runId, nodeId) {
      const k = key(runId, nodeId);
      pending.delete(k);
      decisions.delete(k);
      return ok(undefined);
    },
  };
};

// ── Redis Adapter (production) ───────────────────────────────────────────────

const PENDING_PREFIX = "fugue:hitl:pending:";
const DECISION_PREFIX = "fugue:hitl:decision:";

const pendingKey = (runId: RunId, nodeId: NodeId): string => `${PENDING_PREFIX}${runId}${KEY_SEP}${nodeId}`;
const decisionKey = (runId: RunId, nodeId: NodeId): string => `${DECISION_PREFIX}${runId}${KEY_SEP}${nodeId}`;

export interface RedisDecisionStoreConfig {
  /** TTL applied to pending/decision keys, in seconds. Should exceed the run TTL. */
  readonly ttlSec: number;
}

export const createRedisDecisionStore = (
  redis: RedisPort,
  config: RedisDecisionStoreConfig,
  logger?: LogPort,
): DecisionStorePort => {
  const expiry = { expiresInSec: config.ttlSec };

  return {
    async markPending(runId, nodeId) {
      // Atomic create-once WITH TTL (SET NX EX): the marker can never exist
      // without an expiry, so a crash never leaves a TTL-less pending marker.
      const set = await redis.setNx(pendingKey(runId, nodeId), "1", expiry);
      if (!set.ok) return err(set.error);
      return ok(set.value);
    },

    async isPending(runId, nodeId) {
      const res = await redis.get(pendingKey(runId, nodeId));
      if (!res.ok) return err(res.error);
      return ok(res.value !== null);
    },

    async putDecision(runId, nodeId, action) {
      const res = await redis.set(decisionKey(runId, nodeId), JSON.stringify(action), expiry);
      if (!res.ok) return err(res.error);
      return ok(undefined);
    },

    async getDecision(runId, nodeId) {
      const res = await redis.get(decisionKey(runId, nodeId));
      if (!res.ok) return err(res.error);
      if (res.value === null) return ok(null);
      let raw: unknown;
      try {
        raw = JSON.parse(res.value);
      } catch (e) {
        logger?.error?.("hitl: corrupt decision in store (malformed JSON)", { runId, nodeId, error: e instanceof Error ? e.message : String(e) });
        return err({ kind: "internal-invariant-violated", message: `corrupt decision for '${runId}/${nodeId}'`, context: {} });
      }
      const parsed = HumanActionSchema.safeParse(raw);
      if (!parsed.success) {
        // Parses as JSON but is not a well-formed HumanAction — never resume a
        // run on a malformed decision; surface it via the same error channel.
        logger?.error?.("hitl: corrupt decision in store (invalid shape)", { runId, nodeId, error: parsed.error.message });
        return err({ kind: "internal-invariant-violated", message: `corrupt decision for '${runId}/${nodeId}'`, context: {} });
      }
      return ok(parsed.data as HumanAction);
    },

    async clear(runId, nodeId): Promise<Result<void, HostError>> {
      const dp = await redis.del(pendingKey(runId, nodeId));
      if (!dp.ok) return err(dp.error);
      const dd = await redis.del(decisionKey(runId, nodeId));
      if (!dd.ok) return err(dd.error);
      return ok(undefined);
    },
  };
};
