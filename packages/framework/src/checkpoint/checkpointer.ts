import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, RunId } from "../types/ids.js";
import { err, ok } from "../types/result.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import type { CompositeNodeKeyOpts } from "./composite-node-key.js";
import { ID_PATTERN, __brandNodeId, __brandRunId } from "../types/ids.js";
import { frameworkError } from "../types/error-factories.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";

/**
 * The checkpointer port's 24-hour TTL contract (FR-027) — ONE encoding,
 * owned by the port file that specifies the expiry semantics. The in-memory
 * adapter below evaluates it lazily on `load`; the file backend consumes the
 * same constant directly from this port file (`file/checkpointer.ts`,
 * `file/freshness-index.ts`), and the Redis backend mirrors the same
 * 24-hour contract. Production runs longer than
 * this should re-checkpoint anyway. TTL evaluation is lazy at read time
 * (load-order parity with the Redis backend) — not ADR-0017, which is the
 * framework-version-mismatch contract enforced in `load` below.
 */
export const TTL_SECONDS = 86_400;

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

/**
 * Total renderer for a rejected raw boundary value: strings are carried
 * UNMODIFIED — the additive `invalidRunId`/`invalidNodeId` fields preserve
 * the rejected RAW bytes, and log-line bounding is `formatFrameworkError`'s
 * single job; non-strings stringify safely, degrading to the unprintable
 * placeholder when `toString` itself throws (FR-040). One encoding with the
 * file backend's `writeFailed` (checkpointer-codec.ts).
 */
const stringOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
};

/**
 * Grammar-valid placeholder for a rejected raw `nodeId` — truthful branding
 * (parity with the file backend's `checkpoint-write-failed` construction): a
 * raw id that fails `ID_PATTERN` never inhabits the branded `nodeId` field;
 * the rejected bytes are preserved additively in `invalidNodeId`.
 */
const INVALID_NODE_ID: NodeId = __brandNodeId("checkpoint_invalid_node");

/** Grammar-valid placeholder for a rejected raw `runId` — identical
 * placeholder to the file backend's `writeFailed` (one naming rule). */
const INVALID_RUN_ID: RunId = __brandRunId("checkpoint_invalid_run");

/**
 * Typed `checkpoint-write-failed` for the in-memory adapter that never throws
 * on a hostile raw `runId`/`nodeId` — the port parameters are unvalidated
 * strings, so branding them unconditionally would turn a cloneable-state
 * refusal into a second raw rejection (FR-040).
 *
 * Truthful branding, in PARITY with the file backend's `writeFailed`
 * (checkpointer-codec.ts) — the policy is manually mirrored in each layer, so
 * any change to it must land on BOTH sides (the hostile-value corpus pins it
 * per backend): a raw id that fails `ID_PATTERN` never inhabits the branded
 * field; the rejected RAW bytes are preserved additively in
 * `invalidRunId`/`invalidNodeId` through the total `stringOf` renderer (no
 * pre-quoting or truncation — `formatFrameworkError` is the single bounding
 * point).
 *
 * `typeof` guard before the pattern test (parity with the file backend's
 * `writeFailed` and with `isIdComponent`/`isBoundaryId`): `RegExp.test`
 * coerces non-strings, so a bypassed numeric brand would otherwise match
 * `ID_PATTERN` and inhabit the branded field instead of routing
 * through the placeholder + `invalid*` diagnostic.
 */
const checkpointWriteFailed = (
  runIdRaw: string,
  nodeIdRaw: string,
  message: string,
): FrameworkError => {
  const runIdValid = typeof runIdRaw === "string" && ID_PATTERN.test(runIdRaw);
  const nodeIdValid = typeof nodeIdRaw === "string" && ID_PATTERN.test(nodeIdRaw);
  return {
    kind: "checkpoint-write-failed",
    runId: runIdValid ? __brandRunId(runIdRaw) : INVALID_RUN_ID,
    nodeId: nodeIdValid ? __brandNodeId(nodeIdRaw) : INVALID_NODE_ID,
    ...(runIdValid ? {} : { invalidRunId: stringOf(runIdRaw) }),
    ...(nodeIdValid ? {} : { invalidNodeId: stringOf(nodeIdRaw) }),
    message,
  };
};

/** Typed `cache-error` mapper for the in-memory adapter's I/O-free failure
 * classes. `failureClass` is the additive permanent/transient discriminant
 * (parity with the file backend's `checkpointerCacheError`): deterministic
 * rejections — like a non-finite injected clock — are pinned `"permanent"` so
 * `retriabilityOf` fast-fails them instead of burning the retry budget. */
const cacheError = (
  operation: string,
  message: string,
  failureClass?: "transient" | "permanent",
): FrameworkError => ({
  kind: "cache-error",
  operation,
  message,
  ...(failureClass === undefined ? {} : { failureClass }),
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
    // throwing clock must become a typed error, never a raw rejection, and a
    // non-finite clock output must fail closed too — a NaN TTL comparison is
    // always `false`, which would silently void the FR-027 expiry (the file
    // backend's twin rejects the identical input as a permanent `cache-error`;
    // pinned in `redis-checkpointer.test.ts`).
    let nowMs: number;
    try {
      nowMs = this.now();
    } catch (error) {
      return err(cacheError("checkpoint:load", safeErrorMessage(error)));
    }
    if (!Number.isFinite(nowMs) || Number.isNaN(new Date(nowMs).getTime())) {
      return err(
        cacheError(
          "checkpoint:load",
          `load clock returned a non-representable timestamp for run ${safeDiagnosticRender(runId)}: ${safeDiagnosticRender(nowMs)}`,
          "permanent",
        ),
      );
    }
    const expired = nowMs - createdAt.getTime() > TTL_SECONDS * 1000;
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
      // `checkpoint-corrupt`, and ADR-0080 forbids a raw rejection here. The
      // error construction must be TOTAL: a brand-bypassed non-string `runId`
      // (hostile `toString` included) must not re-throw out of the catch that
      // `toRunId` re-validation would cause — grammar-valid ids go through
      // the factory exactly as before; every other raw value takes the
      // truthful placeholder with the rejected bytes rendered into the message
      // (the `checkpoint-corrupt` variant has no additive field for them).
      return typeof runId === "string" && ID_PATTERN.test(runId)
        ? err(
            frameworkError.checkpointCorrupt(
              runId,
              `stored checkpoint state could not be detached: ${safeErrorMessage(error)}`,
            ),
          )
        : err({
            kind: "checkpoint-corrupt",
            runId: INVALID_RUN_ID,
            message: `stored checkpoint state could not be detached for run ${safeDiagnosticRender(runId)}: ${safeErrorMessage(error)}`,
          });
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
      // The message must render the id through the total diagnostic renderer
      // (FR-040): a hostile raw `nodeId` whose `toString` throws is caught
      // above and must not throw AGAIN inside this catch's own template.
      return err(
        checkpointWriteFailed(
          runId,
          nodeId,
          `state for node ${safeDiagnosticRender(nodeId)} is not cloneable (stored checkpoint state is never aliased by reference): ${safeErrorMessage(error)}`,
        ),
      );
    }
    // Total key coercion (FR-040): a brand-bypassed non-string `nodeId` whose
    // `toString` throws must not reject the port raw from the computed key —
    // strings key byte-identically as before, hostile values degrade to the
    // unprintable placeholder.
    this.nodes.set(runId, { ...existing, [stringOf(nodeId)]: detached });
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
      const createdAtMs = this.now();
      // The injected clock is an untrusted seam: a throwing clock must become
      // a typed error, never a raw rejection, and a non-finite clock output
      // must fail closed too — `new Date(NaN)` is an invalid `Date` that would
      // be stored silently and make every `load` TTL comparison a NaN
      // comparison that is always `false` (the file backend's twin rejects the
      // identical input as a permanent `cache-error`; pinned in
      // `redis-checkpointer.test.ts`).
      if (
        !Number.isFinite(createdAtMs) ||
        Number.isNaN(new Date(createdAtMs).getTime())
      ) {
        return err(
          cacheError(
            "checkpoint:setMeta",
            `setMeta clock returned a non-representable timestamp for run ${safeDiagnosticRender(runId)}: ${safeDiagnosticRender(createdAtMs)}`,
            "permanent",
          ),
        );
      }
      createdAt = new Date(createdAtMs);
    } catch (error) {
      return err(cacheError("checkpoint:setMeta", safeErrorMessage(error)));
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
