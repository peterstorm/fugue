/**
 * Redis-backed freshness index for cross-process stale-read detection.
 *
 * Uses a ZSET per resource:
 *   Key:    `fugue:freshness:{resource}`
 *   Score:  `succeededAtMs`
 *   Member: `freshnessMemberKey` — the port-owned
 *           `[runId, nodeId, witnessKind, witnessValue]` JSON array
 *           (types/freshness.js), shared with the file backend's
 *           equal-score tie-break (ADR-0079).
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
import {
  FRESHNESS_TTL_SECONDS,
  __brandWitness,
  freshnessMemberKey,
  isWitnessKind,
} from "../types/freshness.js";
import type { RunId, NodeId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import { __brandRunId, __brandNodeId } from "../types/ids.js";
import { fwLogger } from "../logger.js";
import { safeErrorMessage } from "../types/safe-error.js";

const KEY_PREFIX = "fugue:freshness:";

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
    if (typeof parsed[3] !== "string" || parsed[3].length === 0) {
      fwLogger().warn(
        `[RedisFreshnessIndex] decodeMember: witnessValue must be a non-empty string: ${member.slice(0, 100)}`,
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
    // This catch spans BOTH `JSON.parse` and the `__brandRunId`/`__brandNodeId`
    // smart constructors below it, which throw on a grammar-invalid id. Naming
    // it unconditionally "JSON parse failed" sent whoever was debugging a
    // corrupt freshness entry after the wrong root cause. Report what actually
    // failed instead; either way the entry is dropped and the read fails closed.
    fwLogger().warn(
      `[RedisFreshnessIndex] decodeMember: ${
        e instanceof SyntaxError ? "JSON parse failed" : "entry rejected"
      }: ${safeErrorMessage(e)}: ${member.slice(0, 100)}`,
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
    const member = freshnessMemberKey(
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
        message: `resource '${event.newWitness.resource}': ${safeErrorMessage(e)}`,
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
        if (decoded === null) {
          // Fail closed (ADR-0025): the LATEST write's member is undecodable
          // (partial write, out-of-band mutation, format change). This index
          // exists to detect stale writes; an unreadable latest member is not
          // a verified no-conflict verdict — the caller must abort the wave
          // rather than proceed without conflict detection. Deterministic:
          // the same bytes reproduce the same rejection, so pin "permanent"
          // like the sibling verdicts. onFailure keeps the failure surface
          // observable to the port's instrumentation.
          this.onFailure(new Error(`undecodable freshness member for resource '${resource}'`));
          return err({
            kind: "cache-error",
            operation: "freshness:findConflict",
            message: `resource '${resource}': latest write member is corrupt/undecodable — conflict verdict withheld (fail closed)`,
            failureClass: "permanent",
          });
        }
        if (decoded.witnessValue !== conditionedOnValue) {
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
        message: `resource '${resource}': ${safeErrorMessage(e)}`,
      });
    }
  }
}

// Exported for unit testing of the encoding roundtrip.
export { freshnessMemberKey as __testEncodeMember, decodeMember as __testDecodeMember };
