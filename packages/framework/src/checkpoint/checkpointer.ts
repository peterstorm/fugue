import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, RunId } from "../types/ids.js";
import { ok } from "../types/result.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import type { CompositeNodeKeyOpts } from "./composite-node-key.js";
import { ID_PATTERN, __brandNodeId } from "../types/ids.js";
import { frameworkError } from "../types/error-factories.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";

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
 * stored under the bare `nodeId` — byte-identical to pre-extension behavior
 * (a `namespace` supplied without either is rejected as ambiguous caller
 * error by `compositeNodeKey`).
 * Composite-capable backends (currently the file backend) store an entry with
 * either component under
 * `${namespace ?? "dag"}@${nodeId}@${index ?? 0}@${attempt ?? 0}`, a distinct
 * durable key so indexed fan-out instances (F1) and subgraph namespaces (F8)
 * never overwrite each other or the canonical entry. In-memory and Redis
 * intentionally ignore these options and fold to bare `nodeId` (FR-023).
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
 * Grammar-valid placeholder for a rejected raw `nodeId` — truthful branding
 * (parity with the file backend's `checkpoint-write-failed` construction): a
 * raw id that fails `ID_PATTERN` never inhabits the branded `nodeId` field;
 * the rejected bytes are preserved additively in `invalidNodeId`, rendered
 * through the total bounded diagnostic renderer.
 */
const INVALID_NODE_ID: NodeId = __brandNodeId("checkpoint_invalid_node");

/**
 * Typed `checkpoint-write-failed` for the in-memory adapter that never throws
 * on a hostile raw `nodeId` — the port's `nodeId` parameter is an unvalidated
 * string, so branding it unconditionally would turn a cloneable-state refusal
 * into a second raw rejection (FR-040).
 *
 * `typeof` guard before the pattern test (parity with the file backend's
 * `writeFailed` and with `isIdComponent`/`isBoundaryId`): `RegExp.test`
 * coerces non-strings, so a bypassed numeric brand would otherwise match
 * `ID_PATTERN` and inhabit the branded `nodeId` field instead of routing
 * through `INVALID_NODE_ID` + `invalidNodeId`.
 */
const checkpointWriteFailed = (
  runId: RunId,
  nodeIdRaw: string,
  message: string,
): FrameworkError =>
  typeof nodeIdRaw === "string" && ID_PATTERN.test(nodeIdRaw)
    ? { kind: "checkpoint-write-failed", runId, nodeId: nodeIdRaw as NodeId, message }
    : {
        kind: "checkpoint-write-failed",
        runId,
        nodeId: INVALID_NODE_ID,
        message,
        invalidNodeId: safeDiagnosticRender(nodeIdRaw),
      };

/** Typed `cache-error` mapper for the in-memory adapter's I/O-free failure classes. */
const cacheError = (operation: string, error: unknown): FrameworkError => ({
  kind: "cache-error",
  operation,
  message: safeErrorMessage(error),
});

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

  /**
   * Detach checkpoint state before it crosses the port boundary. `load` must
   * never hand out live internal references, and `saveNode` must never store
   * the caller's object by reference — otherwise caller mutation would bypass
   * `saveNode`'s snapshot/validation semantics and silently rewrite stored
   * checkpoint state (the file/Redis backends cannot be mutated through
   * `load` at all: they read durable bytes). Stored node states are snapshot
   * data by contract, so — mirroring the file backend's losslessness gate —
   * a value that cannot be detached is refused loudly instead of aliased.
   */
  private detachStored<T>(value: T, what: string): T {
    try {
      return structuredClone(value);
    } catch (error) {
      throw new Error(
        `${what} must be a cloneable snapshot value (stored checkpoint state is never aliased by reference): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    // The injected clock is an untrusted seam (hostile tests/proxies): a
    // throwing clock must become a typed error, never a raw rejection.
    let expired: boolean;
    try {
      expired = this.now() - createdAt.getTime() > TTL_SECONDS * 1000;
    } catch (error) {
      return err(cacheError("checkpoint:load", error));
    }
    if (expired) {
      return err({
        kind: "checkpoint-expired",
        runId,
        expiredAt: createdAt.toISOString(),
      });
    }

    try {
      return ok({
        meta: this.detachStored(meta, "checkpoint meta"),
        nodes: this.detachStored(this.nodes.get(runId) ?? {}, `checkpoint nodes for ${runId}`),
      });
    } catch (error) {
      // Stored state that cannot be detached is stored-state corruption: the
      // file backend's read side reports the equivalent class as
      // `checkpoint-corrupt`, and ADR-0080 forbids a raw rejection here.
      return err(
        frameworkError.checkpointCorrupt(
          runId,
          `stored checkpoint state could not be detached: ${safeErrorMessage(error)}`,
        ),
      );
    }
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
    // Non-cloneable state is refused with a typed error — the file backend
    // maps the same value class to `checkpoint-write-failed` (FR-040,
    // ADR-0080); the port must never reject with a raw Error.
    const existing = this.nodes.get(runId) ?? {};
    let detached: NodeState;
    try {
      detached = this.detachStored(state, `node state for ${nodeId}`);
    } catch (error) {
      return err(
        checkpointWriteFailed(
          runId,
          nodeId,
          `state for node ${nodeId} is not cloneable (stored checkpoint state is never aliased by reference): ${safeErrorMessage(error)}`,
        ),
      );
    }
    this.nodes.set(runId, { ...existing, [nodeId]: detached });
    return ok(undefined);
  }

  async setMeta(runId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>> {
    // Snapshot the caller's meta at WRITE time (parity with file/Redis, which
    // serialize at setMeta): storing references would let caller mutation
    // silently rewrite stored checkpoint state after a successful ok(undefined)
    // — the same aliasing class `detachStored` exists to prevent.
    let detached: RunMeta;
    let createdAt: Date;
    try {
      detached = this.detachStored(meta, "checkpoint meta");
      // The injected clock is an untrusted seam; a throwing clock must become
      // a typed error, never a raw rejection.
      createdAt = new Date(this.now());
    } catch (error) {
      return err(cacheError("checkpoint:setMeta", error));
    }
    // Always stamp the writer's framework version unless the caller supplied
    // their own (lets tests construct stale-version payloads). Matches
    // `RedisCheckpointer.setMeta` exactly so backend swap is transparent.
    this.metas.set(runId, {
      meta: {
        ...detached,
        frameworkVersion: detached.frameworkVersion ?? FRAMEWORK_VERSION,
      },
      createdAt,
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
