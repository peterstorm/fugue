import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";

// --- Domain types ---

export interface RunMeta {
  readonly dagId: string;
  readonly startedAt: Date;
  readonly nodeCount: number;
  /**
   * Caller-supplied principal (e.g. customer_id, tenant_id, user_id).
   * Apps that expose resume should set this and verify it on resume to prevent
   * cross-principal IDOR via stolen/guessed runIds.
   */
  readonly subject?: string;
  /**
   * Stable hash of the DAG's structural shape (node IDs, kinds, edges).
   * Computed via `dagFingerprint(dag)`. Resume must reject when this differs
   * from the current DAG's fingerprint — replaying cached outputs into a
   * re-shaped DAG would skip validation against evolved node schemas.
   */
  readonly dagFingerprint?: string;
  /**
   * Framework version that produced the checkpoint. Resume must reject on
   * mismatch — semantics of validation, retry, or output coercion may have
   * changed between framework releases.
   */
  readonly frameworkVersion?: string;
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
