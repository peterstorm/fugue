import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";

// Mirrors the Redis checkpointer's 24-hour TTL. Production runs longer than
// this should re-checkpoint anyway; the in-memory implementation enforces the
// same contract so tests that drive both backends through `checkpointerSuite`
// observe the same expiry behaviour. ADR-0017.
const TTL_SECONDS = 86_400;

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
  /**
   * Node ids whose stored entry deserialize failed and were silently dropped
   * from `nodes`. Empty / absent on a clean load. Surfaced so resume callers
   * can distinguish "node never ran" from "node ran but checkpoint corrupt".
   */
  readonly corruptNodeIds?: readonly string[];
}

// --- Checkpointer interface ---

/** Per-call options for `Checkpointer.load`. */
export interface CheckpointerLoadOpts {
  /**
   * When provided, resume rejects with `checkpoint-version-mismatch` if the
   * stored fingerprint differs from this value, or if no fingerprint was
   * stored. Without this option, no fingerprint check runs (legacy resumes).
   *
   * Compute via `dagFingerprint(currentDag)` from the same `checkpoint/`
   * module that produced the stored value, so a re-shaped DAG (added nodes,
   * changed edges, evolved schemas) is rejected before any cached node output
   * is replayed into the new graph.
   */
  readonly expectedDagFingerprint?: string;
}

export interface Checkpointer {
  load(
    runId: string,
    opts?: CheckpointerLoadOpts,
  ): Promise<Result<RunState | null, FrameworkError>>;
  saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>>;
  setMeta(runId: string, meta: RunMeta): Promise<Result<void, FrameworkError>>;
}

// --- InMemoryCheckpointer ---

import { err } from "../types/result.js";

/**
 * Internal storage shape. `createdAt` is split out so the checkpointer owns
 * the timestamp the same way the Redis variant does (server-side stamped on
 * setMeta, evaluated against `TTL_SECONDS` on load). Held in a separate field
 * rather than smuggled onto `RunMeta` so the public type stays clean.
 */
interface StoredMeta {
  readonly meta: RunMeta;
  readonly createdAt: Date;
}

export class InMemoryCheckpointer implements Checkpointer {
  private readonly metas = new Map<string, StoredMeta>();
  private readonly nodes = new Map<string, Record<string, NodeState>>();
  private readonly now: () => number;

  constructor(opts?: { readonly now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  async load(
    runId: string,
    opts?: CheckpointerLoadOpts,
  ): Promise<Result<RunState | null, FrameworkError>> {
    const stored = this.metas.get(runId);
    if (!stored) return ok(null);
    const { meta, createdAt } = stored;

    // ADR-0017 — reject checkpoints produced by a different framework
    // version. The Redis path performs the same check; the in-memory variant
    // used to skip it, hiding cross-version-replay bugs from unit tests that
    // never reached Redis.
    if (meta.frameworkVersion !== FRAMEWORK_VERSION) {
      return err({
        kind: "checkpoint-version-mismatch",
        runId,
        expected: FRAMEWORK_VERSION,
        actual: meta.frameworkVersion,
      });
    }

    if (opts?.expectedDagFingerprint !== undefined) {
      if (meta.dagFingerprint !== opts.expectedDagFingerprint) {
        return err({
          kind: "checkpoint-version-mismatch",
          runId,
          expected: opts.expectedDagFingerprint,
          actual: meta.dagFingerprint,
        });
      }
    }

    // Mirror the Redis TTL semantics — past-TTL meta is reported as
    // `checkpoint-expired` so callers see the same surface across backends.
    if (this.now() - createdAt.getTime() > TTL_SECONDS * 1000) {
      return err({
        kind: "checkpoint-expired",
        runId,
        expiredAt: createdAt,
      });
    }

    return ok({ meta, nodes: this.nodes.get(runId) ?? {} });
  }

  async saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>> {
    const existing = this.nodes.get(runId) ?? {};
    this.nodes.set(runId, { ...existing, [nodeId]: state });
    return ok(undefined);
  }

  async setMeta(runId: string, meta: RunMeta): Promise<Result<void, FrameworkError>> {
    // Always stamp the writer's framework version unless the caller supplied
    // their own (lets tests construct stale-version payloads). Matches
    // `RedisCheckpointer.setMeta` exactly so backend swap is transparent.
    this.metas.set(runId, {
      meta: {
        ...meta,
        frameworkVersion: meta.frameworkVersion ?? FRAMEWORK_VERSION,
      },
      createdAt: new Date(this.now()),
    });
    return ok(undefined);
  }

  /**
   * Test-only escape hatch — exposes raw meta storage so the shared
   * `checkpointerSuite` can construct meta payloads that bypass `setMeta`'s
   * framework-version stamping (missing-field case) or rewind `createdAt`
   * (expired case). The Redis counterpart uses `redis.set` directly for the
   * same purpose. Production code MUST go through `setMeta`.
   */
  __testRawMetas(): Map<string, StoredMeta> {
    return this.metas;
  }
}
