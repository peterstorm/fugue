/**
 * Redis-backed freshness index for cross-process stale-read detection.
 *
 * Uses a ZSET per resource:
 *   Key:    `fugue:freshness:{resource}`
 *   Score:  `succeededAtMs`
 *   Member: JSON array `[runId, nodeId, witnessKind, witnessValue]`
 *
 * `recordWrite` is an atomic ZADD + EXPIRE (Lua script). `findConflict`
 * uses `ZREVRANGEBYSCORE ... LIMIT 0 1` to fetch the latest write only.
 * Both operations are O(log N).
 *
 * TTL: 24 hours (matches checkpoint TTL). Stale entries self-evict; no
 * background sweep needed.
 *
 * For single-process detection, use `InMemoryFreshnessIndex` instead — it
 * avoids the Redis round-trip and is the default when no `freshnessIndex`
 * is wired into `DagRunOpts`.
 */

import type Redis from "ioredis";
import type { WriteAttemptedEvent } from "../types/events.js";
import type { FreshnessIndex, WriteEntry, WitnessKind } from "../types/freshness.js";
import { FRESHNESS_TTL_SECONDS, __brandWitness, isWitnessKind } from "../types/freshness.js";
import type { RunId, NodeId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import { __brandRunId, __brandNodeId } from "../types/ids.js";
import { fwLogger } from "../logger.js";

const KEY_PREFIX = "fugue:freshness:";

/**
 * Encode a write entry as a ZSET member. Uses a JSON array for unambiguous
 * parsing — witness values are freeform strings that may contain any
 * delimiter character.
 */
const encodeMember = (
  runId: RunId,
  nodeId: NodeId,
  witnessKind: string,
  witnessValue: string,
): string => JSON.stringify([runId, nodeId, witnessKind, witnessValue]);

/**
 * Decode a ZSET member back to its components. Returns `null` on parse
 * failure (corrupt entry or format change).
 */
const decodeMember = (
  member: string,
): { runId: RunId; nodeId: NodeId; witnessKind: WitnessKind; witnessValue: string } | null => {
  try {
    const parsed = JSON.parse(member);
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      fwLogger().warn(
        `[RedisFreshnessIndex] decodeMember: unexpected shape (length=${Array.isArray(parsed) ? parsed.length : "not-array"}): ${member.slice(0, 100)}`,
      );
      return null;
    }
    // Persisted bytes are untrusted: an off-contract kind must not flow into
    // conflict decisions (the file adapter enforces the same gate; the
    // in-memory adapter mints through the kind-checked constructors). An
    // off-contract kind is a corrupt entry, exactly like a shape failure.
    if (!isWitnessKind(parsed[2])) {
      fwLogger().warn(
        `[RedisFreshnessIndex] decodeMember: unknown witnessKind ${String(parsed[2]).slice(0, 100)}: ${member.slice(0, 100)}`,
      );
      return null;
    }
    return {
      runId: __brandRunId(parsed[0]),
      nodeId: __brandNodeId(parsed[1]),
      witnessKind: parsed[2],
      witnessValue: parsed[3],
    };
  } catch (e) {
    fwLogger().warn(
      `[RedisFreshnessIndex] decodeMember: JSON parse failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
};

/**
 * Atomic ZADD + EXPIRE. Runs as a single Lua script to prevent a crash
 * between ZADD and EXPIRE from leaking entries without a TTL.
 */
const RECORD_WRITE_SCRIPT = `\
redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], ARGV[3])
return 1
`;

export class RedisFreshnessIndex implements FreshnessIndex {
  private scriptSha: string | null = null;
  private _consecutiveFailures = 0;
  private _lastError: Error | null = null;

  /** Number of consecutive Redis failures. Resets on success. */
  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /** Last observed error, or null if healthy. */
  get lastError(): Error | null {
    return this._lastError;
  }

  constructor(private readonly redis: Redis) {}

  private onSuccess(): void {
    this._consecutiveFailures = 0;
    this._lastError = null;
  }

  private onFailure(e: unknown): void {
    this._consecutiveFailures++;
    this._lastError = e instanceof Error ? e : new Error(String(e));
    if (this._consecutiveFailures >= 5) {
      fwLogger().warn(
        `[RedisFreshnessIndex] degraded: ${this._consecutiveFailures} consecutive failures`,
      );
    }
  }

  async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
    const key = KEY_PREFIX + event.newWitness.resource;
    const member = encodeMember(
      event.runId,
      event.nodeId,
      event.newWitness.kind,
      event.newWitness.value,
    );
    const score = String(event.succeededAtMs);

    try {
      if (!this.scriptSha) {
        this.scriptSha = (await this.redis.script(
          "LOAD",
          RECORD_WRITE_SCRIPT,
        )) as string;
      }
      try {
        await this.redis.evalsha(
          this.scriptSha,
          1,
          key,
          score,
          member,
          String(FRESHNESS_TTL_SECONDS),
        );
      } catch (e) {
        // NOSCRIPT — fall back to inline EVAL and re-prime the SHA.
        if (e instanceof Error && e.message.includes("NOSCRIPT")) {
          this.scriptSha = null;
          await this.redis.eval(
            RECORD_WRITE_SCRIPT,
            1,
            key,
            score,
            member,
            String(FRESHNESS_TTL_SECONDS),
          );
        } else {
          throw e;
        }
      }
      this.onSuccess();
      return ok(undefined);
    } catch (e) {
      this.onFailure(e);
      return err({
        kind: "cache-error",
        operation: "freshness:recordWrite",
        message: `resource '${event.newWitness.resource}': ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async findConflict(
    conditionedOn: import("../types/freshness.js").Witness,
    sinceMs: number,
  ): Promise<Result<WriteEntry | null, FrameworkError>> {
    const { resource, value: conditionedOnValue } = conditionedOn;
    const key = KEY_PREFIX + resource;

    try {
      // Get the LATEST write (highest score) since `sinceMs`. Only the most
      // recent write matters — older writes may have values that were
      // subsequently superseded. ZREVRANGEBYSCORE returns descending order;
      // LIMIT 0 1 gives us just the latest.
      const members = await this.redis.zrevrangebyscore(
        key,
        "+inf",
        sinceMs,
        "WITHSCORES",
        "LIMIT",
        0,
        1,
      );

      // Result is [member, score] (single entry due to LIMIT 0 1)
      if (members.length >= 2) {
        const memberStr = members[0]!;
        const score = Number(members[1]!);
        const decoded = decodeMember(memberStr);
        if (decoded && decoded.witnessValue !== conditionedOnValue) {
          this.onSuccess();
          return ok({
            runId: decoded.runId,
            nodeId: decoded.nodeId,
            newWitness: __brandWitness({
              kind: decoded.witnessKind as WitnessKind,
              resource,
              value: decoded.witnessValue,
            }),
            succeededAtMs: score,
          });
        }
      }

      this.onSuccess();
      return ok(null);
    } catch (e) {
      this.onFailure(e);
      return err({
        kind: "cache-error",
        operation: "freshness:findConflict",
        message: `resource '${resource}': ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

// Exported for unit testing of the encoding roundtrip.
export { encodeMember as __testEncodeMember, decodeMember as __testDecodeMember };
