import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId } from "../types/ids.js";
import { ok } from "../types/result.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import type { CompositeNodeKeyOpts } from "./composite-node-key.js";

// Mirrors the Redis checkpointer's 24-hour TTL. Production runs longer than
// this should re-checkpoint anyway; the in-memory implementation enforces the
// same contract so tests that drive both backends through `checkpointerSuite`
// observe the same expiry behaviour. TTL evaluation is lazy at read time
// (load-order parity with the Redis backend) — not ADR-0017, which is the
// framework-version-mismatch contract enforced in `load` below.
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
  /**
   * Stored node entries keyed by the STORED nodeKey — the canonical `nodeId`
   * for canonical saves, or the composite key
   * `${namespace}@${nodeId}@${index}@${attempt}` for composite saves (AD-1;
   * encode/decode via `compositeNodeKey`/`parseCompositeNodeKey`). `NodeState.nodeId`
   * inside each entry still names the real node, so mapped/fan-out instances
   * of the same node appear as separate entries under distinct composite keys
   * in backends that implement composite addressing (the file backend). The
   * in-memory and Redis backends collapse composite saves onto the bare
   * `nodeId` key instead (FR-023: they ignore `SaveNodeOpts` entirely).
   */
  readonly nodes: Record<string, NodeState>;
  /**
   * Backend-specific addresses of stored entries that could not be decoded and
   * were dropped from `nodes`. Redis reports hash-field node ids; the file
   * backend reports a recoverable stored nodeKey, or the digest filename when
   * no address can be recovered. Empty / absent on a clean load.
   */
  readonly corruptNodeIds?: readonly string[];
}

// --- Checkpointer interface ---

/**
 * Per-call options for `Checkpointer.saveNode` — composite checkpoint
 * addressing (AD-1, see `composite-node-key.ts`).
 *
 * Canonical folding: when `index` AND `attempt` are BOTH absent, the entry is
 * stored under the bare `nodeId` — byte-identical to pre-extension behavior.
 * When either is present, the entry is stored under
 * `${namespace ?? "dag"}@${nodeId}@${index ?? 0}@${attempt ?? 0}`, a distinct
 * durable key so indexed fan-out instances (F1) and subgraph namespaces (F8)
 * never overwrite each other or the canonical entry.
 */
export type SaveNodeOpts = CompositeNodeKeyOpts;

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
    runId: RunId,
    opts?: CheckpointerLoadOpts,
  ): Promise<Result<RunState | null, FrameworkError>>;
  /**
   * Persist a node's terminal state under `runId`.
   *
   * The optional 4th argument enables composite addressing (AD-1): with
   * `index`/`attempt` both absent the entry is stored under the canonical
   * `nodeId` key (existing behavior, byte-identical); with either present the
   * entry is stored under the composite key (see `SaveNodeOpts`). The
   * in-memory and Redis backends ignore `opts` exactly as today (FR-023);
   * composite addressing is a versioned opt-in implemented by the file
   * backend. `load` returns entries keyed by the stored nodeKey.
   */
  saveNode(runId: RunId, nodeId: string, state: NodeState, opts?: SaveNodeOpts): Promise<Result<void, FrameworkError>>;
  setMeta(runId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>>;
}

// --- InMemoryCheckpointer ---

import { err } from "../types/result.js";

/**
 * Internal storage shape. `createdAt` is split out so the checkpointer owns
 * the timestamp the same way the Redis variant does (stamped at write time by
 * the writer process in `setMeta`, evaluated against `TTL_SECONDS` on load).
 * Held in a separate field
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
    runId: RunId,
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
        expiredAt: createdAt.toISOString(),
      });
    }

    return ok({ meta, nodes: this.nodes.get(runId) ?? {} });
  }

  async saveNode(
    runId: RunId,
    nodeId: string,
    state: NodeState,
    _opts?: SaveNodeOpts,
  ): Promise<Result<void, FrameworkError>> {
    // FR-023: options are intentionally unobserved. In-memory behavior remains
    // identical to the pre-extension implementation: the bare nodeId is the
    // only key and no log, warning, validation, or other side effect occurs.
    const existing = this.nodes.get(runId) ?? {};
    this.nodes.set(runId, { ...existing, [nodeId]: state });
    return ok(undefined);
  }

  async setMeta(runId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>> {
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
