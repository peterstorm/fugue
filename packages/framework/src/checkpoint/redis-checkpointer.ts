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
  } satisfies StoredMeta);

const deserializeMeta = (raw: string): { meta: RunMeta; createdAt: Date } => {
  const stored: StoredMeta = JSON.parse(raw);
  return {
    meta: {
      dagId: stored.dagId,
      startedAt: new Date(stored.startedAt),
      nodeCount: stored.nodeCount,
      ...(stored.subject !== undefined ? { subject: stored.subject } : {}),
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

export class RedisCheckpointer implements Checkpointer {
  constructor(private readonly redis: Redis) {}

  async load(runId: string): Promise<Result<RunState | null, FrameworkError>> {
    try {
      const rawMeta = await this.redis.get(metaKey(runId));
      if (!rawMeta) return ok(null);

      const { meta, createdAt } = deserializeMeta(rawMeta);
      const now = new Date();
      if (now.getTime() - createdAt.getTime() > TTL_SECONDS * 1000) {
        return err({
          kind: "checkpoint-expired" as const,
          runId,
          expiredAt: createdAt,
        });
      }

      const rawNodes = await this.redis.hgetall(nodesKey(runId));
      const nodes: Record<string, NodeState> = {};
      for (const [nodeId, raw] of Object.entries(rawNodes)) {
        nodes[nodeId] = deserializeNode(raw);
      }

      return ok({ meta, nodes });
    } catch (e) {
      return err({
        kind: "cache-error" as const,
        operation: "load",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>> {
    try {
      await this.redis.hset(nodesKey(runId), nodeId, serializeNode(state));
      // Extend TTL on both keys so they expire together
      await this.redis.expire(nodesKey(runId), TTL_SECONDS);
      await this.redis.expire(metaKey(runId), TTL_SECONDS);
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
