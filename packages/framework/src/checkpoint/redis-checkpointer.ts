import Redis from "ioredis";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId, NodeId } from "../types/ids.js";
import { __brandDagIdUnchecked, __brandNodeIdUnchecked } from "../types/ids.js";
import { ok, err } from "../types/result.js";
import type { Checkpointer, CheckpointerLoadOpts, RunMeta, NodeState, RunState } from "./checkpointer.js";
import { TTL_SECONDS } from "./checkpointer.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import { fwLogger } from "../logger.js";

interface StoredMeta {
  readonly dagId: string;
  readonly startedAt: string;
  readonly nodeCount: number;
  readonly createdAt: string;
  readonly subject?: string;
  readonly dagFingerprint?: string;
  readonly frameworkVersion?: string;
}

interface StoredNodeState {
  readonly nodeId: string;
  readonly output: unknown;
  readonly completedAt: string;
}

const nodesKey = (runId: RunId) => `chkpt:${runId}`;
const metaKey = (runId: RunId) => `chkpt:${runId}:meta`;

const serializeMeta = (meta: RunMeta): string =>
  JSON.stringify({
    dagId: meta.dagId,
    startedAt: meta.startedAt.toISOString(),
    nodeCount: meta.nodeCount,
    createdAt: new Date().toISOString(),
    ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
    ...(meta.dagFingerprint !== undefined ? { dagFingerprint: meta.dagFingerprint } : {}),
    // ADR-0017: always stamp the writing framework's version so load() can
    // reject resumes that cross framework releases. Explicit caller value
    // wins (lets tests construct stale-version payloads).
    frameworkVersion: meta.frameworkVersion ?? FRAMEWORK_VERSION,
  } satisfies StoredMeta);

const deserializeMeta = (raw: string): { meta: RunMeta; createdAt: Date } => {
  const stored: StoredMeta = JSON.parse(raw);
  const startedAt = new Date(stored.startedAt);
  const createdAt = new Date(stored.createdAt);
  if (isNaN(startedAt.getTime()) || isNaN(createdAt.getTime())) {
    throw new Error(
      `Invalid date in checkpoint meta: startedAt=${stored.startedAt}, createdAt=${stored.createdAt}`,
    );
  }
  return {
    meta: {
      // Read-side parse boundary: the stored bytes were written by a consumer
      // of the (now branded) port. The Redis backend's frozen domain is
      // pass-through — it neither re-derives nor validates the id domain at
      // read time, so the brand is applied unchecked (an honest re-typing of
      // the deserialized value, not a new gate).
      dagId: __brandDagIdUnchecked(stored.dagId),
      startedAt,
      nodeCount: stored.nodeCount,
      ...(stored.subject !== undefined ? { subject: stored.subject } : {}),
      ...(stored.dagFingerprint !== undefined ? { dagFingerprint: stored.dagFingerprint } : {}),
      ...(stored.frameworkVersion !== undefined ? { frameworkVersion: stored.frameworkVersion } : {}),
    },
    createdAt,
  };
};

const serializeNode = (state: NodeState): string =>
  JSON.stringify({
    nodeId: state.nodeId,
    output: state.output,
    completedAt: state.completedAt.toISOString(),
  } satisfies StoredNodeState);

const deserializeNode = (raw: string): NodeState => {
  const stored: StoredNodeState = JSON.parse(raw);
  const completedAt = new Date(stored.completedAt);
  if (isNaN(completedAt.getTime())) {
    throw new Error(`Invalid date in checkpoint node: completedAt=${stored.completedAt}`);
  }
  return {
    nodeId: __brandNodeIdUnchecked(stored.nodeId), // read-side pass-through (see the meta twin above)
    output: stored.output,
    completedAt,
  };
};

/**
 * Atomic save: HSET node + EXPIRE both keys in a single Lua script. Without
 * this, a worker crash between the HSET and either EXPIRE call would leave
 * one key without a TTL, leaking checkpoint data forever.
 */
const SAVE_NODE_SCRIPT = `\
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], ARGV[3])
redis.call("EXPIRE", KEYS[2], ARGV[3])
return 1
`;

export class RedisCheckpointer implements Checkpointer {
  /** EVALSHA hash, populated on first saveNode (lazy SCRIPT LOAD). */
  private saveNodeSha: string | null = null;
  private readonly now: () => number;

  constructor(private readonly redis: Redis, opts?: { readonly now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  async load(
    runId: RunId,
    opts?: CheckpointerLoadOpts,
  ): Promise<Result<RunState | null, FrameworkError>> {
    let rawMeta: string | null;
    try {
      rawMeta = await this.redis.get(metaKey(runId));
    } catch (e) {
      return err({
        kind: "cache-error" as const,
        operation: "load:get-meta",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (!rawMeta) return ok(null);

    let meta: RunMeta;
    let createdAt: Date;
    try {
      ({ meta, createdAt } = deserializeMeta(rawMeta));
    } catch (e) {
      return err({
        kind: "checkpoint-corrupt" as const,
        runId,
        message: `meta deserialize failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // ADR-0017: reject checkpoints produced by a different framework version.
    // Validation, retry, and output-coercion semantics may have changed across
    // releases; resuming v1 state under v2 code can corrupt the run silently.
    if (meta.frameworkVersion !== FRAMEWORK_VERSION) {
      return err({
        kind: "checkpoint-version-mismatch" as const,
        runId,
        expected: FRAMEWORK_VERSION,
        actual: meta.frameworkVersion,
      });
    }

    // Reject when caller supplied an expected DAG fingerprint and it does not
    // match the stored one (or no fingerprint is stored). A re-shaped DAG —
    // added nodes, changed edges, evolved output schemas — would otherwise
    // replay cached outputs into the new graph and skip the validations they
    // depend on. Opt-in: callers who omit `expectedDagFingerprint` keep the
    // legacy no-check behaviour.
    if (opts?.expectedDagFingerprint !== undefined) {
      if (meta.dagFingerprint !== opts.expectedDagFingerprint) {
        return err({
          kind: "checkpoint-version-mismatch" as const,
          runId,
          expected: opts.expectedDagFingerprint,
          actual: meta.dagFingerprint,
        });
      }
    }

    const nowMs = this.now();
    if (nowMs - createdAt.getTime() > TTL_SECONDS * 1000) {
      return err({
        kind: "checkpoint-expired" as const,
        runId,
        expiredAt: createdAt.toISOString(),
      });
    }

    let rawNodes: Record<string, string>;
    try {
      rawNodes = await this.redis.hgetall(nodesKey(runId));
    } catch (e) {
      return err({
        kind: "cache-error" as const,
        operation: "load:hgetall-nodes",
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // Per-entry deserialize: a single corrupt row must not poison the rest.
    // Missing nodes will be re-executed (DAG nodes are idempotency-safe by design).
    // Surface dropped ids on `corruptNodeIds` so callers can distinguish
    // "node never ran" from "node ran but checkpoint is unreadable".
    const nodes: Record<string, NodeState> = {};
    const corruptNodeIds: string[] = [];
    for (const [nodeId, raw] of Object.entries(rawNodes)) {
      try {
        // `__proto__` matches ID_PATTERN (`_` is in the charset), so it is a
        // LEGAL nodeId — plain bracket assignment would hit Object.prototype's
        // `__proto__` SETTER and re-parent the returned map instead of defining
        // an own entry (round-17: the file backend's defineProperty choice,
        // parity-pinned across all legs in the shared `checkpointerSuite`).
        Object.defineProperty(nodes, nodeId, {
          value: deserializeNode(raw),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } catch (e) {
        fwLogger().warn(
          `[RedisCheckpointer] Dropping corrupt checkpoint entry runId=${runId} nodeId=${nodeId}: ${e instanceof Error ? e.message : e}`,
        );
        corruptNodeIds.push(nodeId);
      }
    }

    return ok({
      meta,
      nodes,
      ...(corruptNodeIds.length > 0 ? { corruptNodeIds } : {}),
    });
  }

  async saveNode(runId: RunId, nodeId: NodeId, state: NodeState): Promise<Result<void, FrameworkError>> {
    const payload = serializeNode(state);
    try {
      if (!this.saveNodeSha) {
        this.saveNodeSha = await this.redis.script("LOAD", SAVE_NODE_SCRIPT) as string;
      }
      try {
        await this.redis.evalsha(
          this.saveNodeSha,
          2,
          nodesKey(runId),
          metaKey(runId),
          nodeId,
          payload,
          String(TTL_SECONDS),
        );
      } catch (e) {
        // NOSCRIPT (script flushed from server cache) — fall back to inline EVAL
        // and re-prime the SHA.
        if (e instanceof Error && e.message.includes("NOSCRIPT")) {
          this.saveNodeSha = null;
          await this.redis.eval(
            SAVE_NODE_SCRIPT,
            2,
            nodesKey(runId),
            metaKey(runId),
            nodeId,
            payload,
            String(TTL_SECONDS),
          );
        } else {
          throw e;
        }
      }
      return ok(undefined);
    } catch (e) {
      return err({
        kind: "cache-error" as const,
        operation: "saveNode",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async setMeta(runId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>> {
    try {
      await this.redis.set(metaKey(runId), serializeMeta(meta), "EX", TTL_SECONDS);
      return ok(undefined);
    } catch (e) {
      return err({
        kind: "cache-error" as const,
        operation: "setMeta",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
