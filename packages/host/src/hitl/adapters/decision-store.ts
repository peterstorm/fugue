/**
 * DecisionStore adapter (ADR-0060) — Redis (prod).
 *
 * Tracks, per `(runId, nodeId)` human gate: whether it is pending (so a
 * resume-then-re-park loop notifies only once) and the human's decision (so a
 * resume resolves the gate). `preparePending` uses atomic create-once `SET NX
 * EX`; first-writer decision resolution is atomic too.
 *
 * Redis key layout (KEY_SEP between runId/nodeId — see below), tenant-prefixed
 * (AD-4 / FR-013 / SC-001):
 *   fugue:<tenant>:hitl:pending:<runId>␟<nodeId>   →  "notification-required:<marker>"
 *                                                       | "notified:<marker>"
 *   fugue:<tenant>:hitl:decision:<runId>␟<nodeId>  →  JSON HumanAction
 *
 * SECURITY INVARIANT (load-bearing for AD-4 / FR-013 / SC-001): the store is
 * constructed bound to ONE `TenantId`, so a single instance can only ever
 * read/write its own tenant's pending markers & decisions — under the per-tenant
 * Redis ACL (`~fugue:<tenant>:*`) it physically cannot name another tenant's
 * gates, making a flat cross-tenant decision key unrepresentable.
 */

import { z } from "zod";
import { ok, err, safeErrorMessage, tryNodeId } from "@fuguejs/framework";
import type { Result, RunId, NodeId, HumanAction } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { TenantId } from "../../domain/tenant.js";
import type { HitlRedisPort, LogPort } from "../../ports.js";
import type { DecisionResolution, DecisionStorePort, PendingReview } from "../ports.js";
import { logWithoutThrowing } from "../diagnostic-logging.js";

/**
 * Shape validator for a persisted `HumanAction` (ADR-0060). The decision is read
 * back off the wire (Redis) and then drives the exhaustive transition match on
 * resume, so — exactly like the `tryRunId`/`tryNodeId` smart constructors on the
 * HTTP/bot read paths — it must be PARSED, not `as`-cast: a structurally-invalid
 * value (unknown `kind`, an `approve-with-edit` missing `newOutput`, a `reject`
 * missing `reason`) must be rejected here rather than resuming a run with a
 * corrupt decision. `targetNodeId` is refined through the same `tryNodeId` smart
 * constructor the ingress paths use, so a persisted reroute target outside
 * `ID_PATTERN` is rejected rather than flowing in as a branded `NodeId`.
 */
const PersistedNodeIdSchema: z.ZodType<NodeId> = z.string().transform((value, context) => {
  const parsed = tryNodeId(value);
  if (parsed.ok) return parsed.value;
  context.addIssue({ code: "custom", message: "value is not a valid branded id" });
  return z.NEVER;
});

const HumanActionSchemaDefinition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve"), actor: z.string().optional() }),
  z.object({ kind: z.literal("approve-with-edit"), newOutput: z.unknown(), actor: z.string().optional() }),
  z.object({ kind: z.literal("reject"), reason: z.string(), actor: z.string().optional() }),
  z.object({ kind: z.literal("reroute"), targetNodeId: PersistedNodeIdSchema, reason: z.string().optional(), actor: z.string().optional() }),
]);
type MissingHumanActionKind = Exclude<
  HumanAction["kind"],
  z.output<typeof HumanActionSchemaDefinition>["kind"]
>;
type ExhaustiveHumanActionSchema = [MissingHumanActionKind] extends [never]
  ? z.ZodType<HumanAction>
  : never;
const HumanActionSchema: ExhaustiveHumanActionSchema = HumanActionSchemaDefinition;

/**
 * Composite-key separator between `runId` and `nodeId`. The unit separator
 * (U+001F) is chosen deliberately: it is OUTSIDE the id alphabet
 * (`ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/`) so the two-part key is injective — unlike
 * a `:` separator, which collides because `:` is a legal id character
 * (`(runId="a:b", nodeId="c")` and `(runId="a", nodeId="b:c")` would otherwise
 * map to the same key). Unlike a NUL byte (also outside the alphabet) it keeps
 * the source/keys git-text and grep-friendly rather than classifying the file
 * as binary.
 */
const KEY_SEP = "\x1f";

// ── Redis Adapter (production) ───────────────────────────────────────────────

// The prefixes are derived from the bound `TenantId`, so every key a store
// instance emits is forced under `fugue:<tenant>:hitl:`. There is no code path
// that builds a pending/decision key without a tenant.
const pendingKey = (tenant: TenantId, runId: RunId, nodeId: NodeId): string => `fugue:${tenant}:hitl:pending:${runId}${KEY_SEP}${nodeId}`;
const decisionKey = (tenant: TenantId, runId: RunId, nodeId: NodeId): string => `fugue:${tenant}:hitl:decision:${runId}${KEY_SEP}${nodeId}`;

interface RedisDecisionStoreConfig {
  /** TTL applied to pending/decision keys, in seconds. Should exceed the run TTL. */
  readonly ttlSec: number;
  /** Fresh marker token for notification-delivery CAS. Defaults to randomUUID. */
  readonly newPendingMarker?: () => string;
}

const notificationRequired = (marker: string): string => `notification-required:${marker}`;
const notified = (marker: string): string => `notified:${marker}`;

type RedisDecisionOutcome = "not-present" | "created" | "exists";

const DECISION_RESOLUTION_BY_REDIS_OUTCOME = {
  "not-present": { kind: "not-pending" },
  created: { kind: "accepted" },
  exists: { kind: "already-resolved" },
} as const satisfies Record<RedisDecisionOutcome, DecisionResolution>;

const parsePendingReview = (raw: string): Result<PendingReview, HostError> => {
  if (raw.startsWith("notification-required:") && raw.length > "notification-required:".length) {
    return ok({ kind: "notification-required", marker: raw.slice("notification-required:".length) });
  }
  if (raw.startsWith("notified:") && raw.length > "notified:".length) {
    return ok({ kind: "notified" });
  }
  return err({
    kind: "internal-invariant-violated",
    message: "corrupt pending-review notification state",
    context: {},
  });
};

export const createRedisDecisionStore = (
  redis: HitlRedisPort,
  tenant: TenantId,
  config: RedisDecisionStoreConfig,
  logger?: LogPort,
): DecisionStorePort => {
  const expiry = { expiresInSec: config.ttlSec };
  const newPendingMarker = config.newPendingMarker ?? (() => crypto.randomUUID());

  return {
    async preparePending(runId, nodeId) {
      const key = pendingKey(tenant, runId, nodeId);
      for (;;) {
        const marker = newPendingMarker();
        const created = await redis.setNx(key, notificationRequired(marker), expiry);
        if (!created.ok) return err(created.error);
        if (created.value) return ok({ kind: "notification-required", marker });

        const existing = await redis.get(key);
        if (!existing.ok) return err(existing.error);
        // A concurrent post-commit clear can remove the marker between SET NX
        // and GET. Retry creation rather than returning an impossible state.
        if (existing.value === null) continue;
        return parsePendingReview(existing.value);
      }
    },

    async markNotified(runId, nodeId, marker) {
      const key = pendingKey(tenant, runId, nodeId);
      const committed = await redis.setIfValue(
        key,
        notificationRequired(marker),
        key,
        notified(marker),
        expiry,
      );
      return committed;
    },

    async resolvePending(runId, nodeId, action) {
      // The guard check and first-writer decision publication share one Redis
      // optimistic transaction. A concurrent clear invalidates EXEC and retries,
      // so a resolver cannot recreate a decision after its gate has closed.
      const resolved = await redis.setNxIfPresent(
        pendingKey(tenant, runId, nodeId),
        decisionKey(tenant, runId, nodeId),
        JSON.stringify(action),
        expiry,
      );
      if (!resolved.ok) return err(resolved.error);
      return ok(DECISION_RESOLUTION_BY_REDIS_OUTCOME[resolved.value]);
    },

    async getDecision(runId, nodeId) {
      const res = await redis.get(decisionKey(tenant, runId, nodeId));
      if (!res.ok) return err(res.error);
      if (res.value === null) return ok(null);
      let raw: unknown;
      try {
        raw = JSON.parse(res.value);
      } catch (e) {
        logWithoutThrowing(logger, "error", "hitl: corrupt decision in store (malformed JSON)", {
          runId,
          nodeId,
          error: safeErrorMessage(e),
        });
        return err({ kind: "internal-invariant-violated", message: `corrupt decision for '${runId}/${nodeId}'`, context: {} });
      }
      const parsed = HumanActionSchema.safeParse(raw);
      if (!parsed.success) {
        // Parses as JSON but is not a well-formed HumanAction — never resume a
        // run on a malformed decision; surface it via the same error channel.
        logWithoutThrowing(logger, "error", "hitl: corrupt decision in store (invalid shape)", {
          runId,
          nodeId,
          error: parsed.error.message,
        });
        return err({ kind: "internal-invariant-violated", message: `corrupt decision for '${runId}/${nodeId}'`, context: {} });
      }
      return ok(parsed.data);
    },

    async clear(runId, nodeId): Promise<Result<void, HostError>> {
      // Redis DEL over multiple keys is one atomic command: a consumed gate can
      // never retain its decision after its pending marker has disappeared.
      const cleared = await redis.del(
        pendingKey(tenant, runId, nodeId),
        decisionKey(tenant, runId, nodeId),
      );
      return cleared.ok ? ok(undefined) : err(cleared.error);
    },
  };
};
