import Redis from "ioredis";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import type { Checkpointer, RunMeta, NodeState, RunState } from "./checkpointer.js";

const TTL_SECONDS = 86400; // 24 hours

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

const nodesKey = (runId: string) => `chkpt:${runId}`;
const metaKey = (runId: string) => `chkpt:${runId}:meta`;

const serializeMeta = (meta: RunMeta): string =>
  JSON.stringify({
    dagId: meta.dagId,
    startedAt: meta.startedAt.toISOString(),
    nodeCount: meta.nodeCount,
    createdAt: new Date().toISOString(),
    ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
    ...(meta.dagFingerprint !== undefined ? { dagFingerprint: meta.dagFingerprint } : {}),
    ...(meta.frameworkVersion !== undefined ? { frameworkVersion: meta.frameworkVersion } : {}),
  } satisfies StoredMeta);

const deserializeMeta = (raw: string): { meta: RunMeta; createdAt: Date } => {
  const stored: StoredMeta = JSON.parse(raw);
  return {
    meta: {
      dagId: stored.dagId,
      startedAt: new Date(stored.startedAt),
      nodeCount: stored.nodeCount,
      ...(stored.subject !== undefined ? { subject: stored.subject } : {}),
      ...(stored.dagFingerprint !== undefined ? { dagFingerprint: stored.dagFingerprint } : {}),
      ...(stored.frameworkVersion !== undefined ? { frameworkVersion: stored.frameworkVersion } : {}),
    },
    createdAt: new Date(stored.createdAt),
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
  return {
    nodeId: stored.nodeId,
    output: stored.output,
    completedAt: new Date(stored.completedAt),
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

  constructor(private readonly redis: Redis) {}

  async load(runId: string): Promise<Result<RunState | null, FrameworkError>> {
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

    const now = new Date();
    if (now.getTime() - createdAt.getTime() > TTL_SECONDS * 1000) {
      return err({
        kind: "checkpoint-expired" as const,
        runId,
        expiredAt: createdAt,
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
    const nodes: Record<string, NodeState> = {};
    for (const [nodeId, raw] of Object.entries(rawNodes)) {
      try {
        nodes[nodeId] = deserializeNode(raw);
      } catch (e) {
        console.warn(
          `[RedisCheckpointer] Dropping corrupt checkpoint entry runId=${runId} nodeId=${nodeId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    return ok({ meta, nodes });
  }

  async saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>> {
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

  async setMeta(runId: string, meta: RunMeta): Promise<Result<void, FrameworkError>> {
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
