import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";

// --- Domain types ---

export interface RunMeta {
  readonly dagId: string;
  readonly startedAt: Date;
  readonly nodeCount: number;
}

export interface NodeState {
  readonly nodeId: string;
  readonly output: unknown;
  readonly completedAt: Date;
}

export interface RunState {
  readonly meta: RunMeta;
  readonly nodes: Record<string, NodeState>;
}

// --- Checkpointer interface ---

export interface Checkpointer {
  load(runId: string): Promise<Result<RunState | null, FrameworkError>>;
  saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>>;
  setMeta(runId: string, meta: RunMeta): Promise<Result<void, FrameworkError>>;
}

// --- InMemoryCheckpointer ---

export class InMemoryCheckpointer implements Checkpointer {
  private readonly metas = new Map<string, RunMeta>();
  private readonly nodes = new Map<string, Record<string, NodeState>>();

  async load(runId: string): Promise<Result<RunState | null, FrameworkError>> {
    const meta = this.metas.get(runId);
    if (!meta) return ok(null);
    return ok({ meta, nodes: this.nodes.get(runId) ?? {} });
  }

  async saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>> {
    const existing = this.nodes.get(runId) ?? {};
    this.nodes.set(runId, { ...existing, [nodeId]: state });
    return ok(undefined);
  }

  async setMeta(runId: string, meta: RunMeta): Promise<Result<void, FrameworkError>> {
    this.metas.set(runId, meta);
    return ok(undefined);
  }
}
