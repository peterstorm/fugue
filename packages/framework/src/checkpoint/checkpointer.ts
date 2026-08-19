import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { err, ok } from "../types/result.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import type { CompositeNodeKeyOpts } from "./composite-node-key.js";
import {
  ID_PATTERN,
  __brandDagIdUnchecked,
  __brandNodeId,
} from "../types/ids.js";
import { isRepresentableTimestampMs } from "../types/clock.js";
import {
  CHECKPOINT_INVALID_RUN_ID,
  frameworkError,
  stringOf,
} from "../types/error-factories.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";

/**
 * The checkpointer port's 24-hour TTL contract (FR-027) — ONE encoding,
 * owned by the port file that specifies the expiry semantics. The in-memory
 * adapter below evaluates it lazily on `load`; the file CHECKPOINTER backend
 * consumes the same constant directly from this port file
 * (`file/checkpointer.ts`), and the Redis backend mirrors the same
 * 24-hour contract. The file FRESHNESS backend consumes the FreshnessIndex
 * port's own 24-hour constant (`FRESHNESS_TTL_SECONDS`,
 * `types/freshness.ts`) — value parity with this TTL is pinned in
 * `file-freshness-index.test.ts` while ADR-0079's parity target holds — so
 * a future FR-027 change cannot silently redefine freshness expiry. Production runs longer than
 * this should re-checkpoint anyway. TTL evaluation is lazy at read time
 * (load-order parity with the Redis backend) — not ADR-0017, which is the
 * framework-version-mismatch contract enforced in `load` below.
 */
export const TTL_SECONDS = 86_400;

// ── Checkpoint load-gate decision (ADR-0017 / FR-025/26/27) ────────────────

/**
 * The checkpoint load-gate DECISION, one encoding shared by the in-memory,
 * Redis, and file adapters (round-22 atl-1). A pure function owning the gate
 * ORDER (framework version → DAG fingerprint → TTL expiry) and the verdict
 * construction — the three adapters previously re-encoded this identical
 * sequence interleaved with their storage reads; a change to gate order or
 * verdict semantics used to require three coordinated edits, and the per-
 * backend divergence was prevented only by the parity suite, not by
 * structure.
 *
 * Each adapter keeps its own storage read, its hostile-seam `opts`
 * snapshot-once guard, and its clock guard, then delegates here. The clock
 * arrives as a THUNK (`readNowMs`) so the version gates evaluate BEFORE the
 * clock read — the exact failure precedence every adapter already exhibits
 * (a throwing clock must not mask a version mismatch).
 */
export const evaluateCheckpointLoadGates = (input: {
  readonly runId: RunId;
  /** `meta.frameworkVersion` (optional in `RunMeta` — absent means stale/unknown). */
  readonly frameworkVersion: string | undefined;
  /** `meta.dagFingerprint` (optional in `RunMeta`). */
  readonly dagFingerprint: string | undefined;
  /** Caller-supplied expected fingerprint from load opts (snapshot-once read by the adapter). */
  readonly expectedDagFingerprint: string | undefined;
  /** Checkpoint write time (the projection's `createdAt`). */
  readonly createdAt: Date;
}, readNowMs: () => Result<number, FrameworkError>): Result<"ok", FrameworkError> => {
  // ADR-0017: reject checkpoints produced by a different framework version.
  // A stored meta WITHOUT the field is a stale format and mismatches too.
  if (input.frameworkVersion !== FRAMEWORK_VERSION) {
    return err({
      kind: "checkpoint-version-mismatch",
      runId: input.runId,
      expected: FRAMEWORK_VERSION,
      actual: input.frameworkVersion,
    });
  }

  // FR-026: opt-in structural gate. A re-shaped DAG would replay cached
  // outputs into a graph whose nodes no longer validate them, so an ABSENT
  // stored fingerprint is a mismatch too — not a pass.
  if (
    input.expectedDagFingerprint !== undefined &&
    input.dagFingerprint !== input.expectedDagFingerprint
  ) {
    return err({
      kind: "checkpoint-version-mismatch",
      runId: input.runId,
      expected: input.expectedDagFingerprint,
      actual: input.dagFingerprint,
    });
  }

  // FR-027: lazy expiry — evaluated here, at read time, against the
  // injected clock. No sweeper, no physical GC in this pass. The clock is
  // read only AFTER the version gates (adapter failure-precedence parity):
  // a throwing/non-representable clock settles as a typed `cache-error` — a
  // NaN timestamp would otherwise void the check (`NaN > TTL` is always
  // false) — but never masks a version mismatch.
  const nowClock = readNowMs();
  if (!nowClock.ok) return nowClock;
  if (nowClock.value - input.createdAt.getTime() > TTL_SECONDS * 1000) {
    return err({
      kind: "checkpoint-expired",
      runId: input.runId,
      expiredAt: input.createdAt.toISOString(),
    });
  }
  return ok("ok");
};

// ── Shared record grammar (round-23 atl-1) ─────────────────────────────────

/**
 * Parse the exact timestamp grammar emitted on write. `Date` accepts many
 * non-canonical spellings (`2025-01-01`, offsets, missing milliseconds); a
 * persisted checkpoint timestamp is valid only when parsing and re-emitting
 * it produces byte-identical text. The parse/re-emit pair is guarded so corrupt
 * bytes can only become an `Err`, never a raw date exception.
 *
 * ONE encoding owned by the checkpoint core: the file codec and the Redis
 * adapter's read gates delegate here, so the two backends cannot drift on the
 * date grammar (round-23 atl-1 — Redis previously accepted any parseable
 * string where the file codec required canonical ISO).
 */
export const parseCanonicalIsoDate = (
  value: string,
  field: "startedAt" | "createdAt" | "completedAt",
): Result<Date, string> => {
  try {
    const parsed = new Date(value);
    const canonical = Date.prototype.toISOString.call(parsed);
    return canonical === value
      ? ok(parsed)
      : err(`${field} must be a canonical ISO timestamp, got ${safeDiagnosticRender(value)}`);
  } catch {
    return err(`${field} must be a canonical ISO timestamp, got ${safeDiagnosticRender(value)}`);
  }
};

/**
 * Strict parse of the checkpoint META record fields shared by every backend
 * (round-23 atl-1): parse, don't validate — every field is checked before it
 * becomes a `RunMeta`, so a half-readable meta can never be served as a
 * usable checkpoint. The file codec and the Redis adapter previously
 * re-encoded these gates separately and drifted (Redis accepted any
 * `Date`-parseable timestamp where the file codec required canonical ISO);
 * this is the ONE encoding, with the file codec's pinned message vocabulary.
 * Each adapter keeps its own storage envelope (file: `meta.json` bytes +
 * digest naming; Redis: flat JSON hash fields) and maps the `Err` into its
 * local style. Unknown additive top-level fields are deliberately ignored so
 * newer writers may extend metadata without older readers rejecting
 * otherwise usable checkpoints.
 */
export const parseRunMetaRecord = (
  raw: unknown,
): Result<{ readonly meta: RunMeta; readonly createdAt: Date }, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(`meta must be a JSON object, got ${safeDiagnosticRender(raw)}`);
  }
  const {
    dagId,
    startedAt,
    nodeCount,
    createdAt,
    subject,
    dagFingerprint,
    frameworkVersion,
  } = raw as Record<string, unknown>;
  if (typeof dagId !== "string") {
    return err(`dagId must be a string, got ${safeDiagnosticRender(dagId)}`);
  }
  if (typeof startedAt !== "string") {
    return err(`startedAt must be a string, got ${safeDiagnosticRender(startedAt)}`);
  }
  if (typeof createdAt !== "string") {
    return err(`createdAt must be a string, got ${safeDiagnosticRender(createdAt)}`);
  }
  if (
    typeof nodeCount !== "number" ||
    !Number.isSafeInteger(nodeCount) ||
    nodeCount < 0
  ) {
    return err(
      `nodeCount must be a non-negative safe integer, got ${safeDiagnosticRender(nodeCount)}`,
    );
  }
  if (subject !== undefined && typeof subject !== "string") {
    return err(`subject must be a string when present, got ${safeDiagnosticRender(subject)}`);
  }
  if (dagFingerprint !== undefined && typeof dagFingerprint !== "string") {
    return err(`dagFingerprint must be a string when present, got ${safeDiagnosticRender(dagFingerprint)}`);
  }
  if (frameworkVersion !== undefined && typeof frameworkVersion !== "string") {
    return err(`frameworkVersion must be a string when present, got ${safeDiagnosticRender(frameworkVersion)}`);
  }
  const parsedStartedAt = parseCanonicalIsoDate(startedAt, "startedAt");
  if (!parsedStartedAt.ok) return err(parsedStartedAt.error);
  const parsedCreatedAt = parseCanonicalIsoDate(createdAt, "createdAt");
  if (!parsedCreatedAt.ok) return err(parsedCreatedAt.error);
  return ok({
    meta: {
      // Read-side parse boundary: the stored bytes were written by a consumer
      // of the (now branded) port. The frozen acceptance domain is a
      // `typeof`/grammar shape check (it does NOT re-derive the `DagId`
      // pattern domain at read time — that would newly reject stored values,
      // a behavior change to a frozen surface), so the brand is applied
      // unchecked: an honest re-typing of the deserialized value.
      dagId: __brandDagIdUnchecked(dagId),
      startedAt: parsedStartedAt.value,
      nodeCount,
      ...(subject !== undefined ? { subject } : {}),
      ...(dagFingerprint !== undefined ? { dagFingerprint } : {}),
      ...(frameworkVersion !== undefined ? { frameworkVersion } : {}),
    },
    createdAt: parsedCreatedAt.value,
  });
};

/**
 * Strict parse of the checkpoint NODE record fields shared by every backend
 * (round-23 atl-1): `nodeId` must match `ID_PATTERN` (the file backend's
 * path-safety domain — Redis previously accepted any string, so bytes Redis
 * served as valid were `checkpoint-corrupt` on the file backend) and
 * `completedAt` must be canonical ISO. The file codec additionally verifies
 * its envelope (`nodeKey`, digest filename) and serializer-tagged `output`
 * around this gate; the Redis adapter passes `output` through.
 */
export const parseNodeStateRecord = (
  raw: unknown,
): Result<{ readonly nodeId: NodeId; readonly completedAt: Date }, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(`node entry must be a JSON object, got ${safeDiagnosticRender(raw)}`);
  }
  const { nodeId, completedAt } = raw as Record<string, unknown>;
  if (typeof nodeId !== "string" || !ID_PATTERN.test(nodeId)) {
    return err(`nodeId ${safeDiagnosticRender(nodeId)} does not match ${ID_PATTERN.source}`);
  }
  if (typeof completedAt !== "string") {
    return err(`completedAt must be a string, got ${safeDiagnosticRender(completedAt)}`);
  }
  const parsedCompletedAt = parseCanonicalIsoDate(completedAt, "completedAt");
  if (!parsedCompletedAt.ok) return err(parsedCompletedAt.error);
  // ID_PATTERN was just verified — the validating brand cannot reject.
  return ok({ nodeId: __brandNodeId(nodeId), completedAt: parsedCompletedAt.value });
};

// ── Guarded checkpoint-clock read (round-23 cs-2) ──────────────────────────

export interface GuardedCheckpointClockReadInput {
  readonly operation: "setMeta" | "load";
  readonly runId: RunId;
  readonly now: () => number;
  /** Total diagnostics renderer (each adapter's `safeDiagnosticRender`). */
  readonly render: (value: unknown) => string;
  /**
   * Adapter's `cache-error` constructor — must classify the verdict
   * "permanent". Receives the RAW operation (`"setMeta"` / `"load"`); each
   * adapter formats its own operation vocabulary (the in-memory and Redis
   * twins stamp `checkpoint:<op>`, the file backend stamps the bare
   * operation — pre-existing, pinned divergence preserved byte-for-byte).
   */
  readonly cacheError: (operation: "setMeta" | "load", message: string) => FrameworkError;
  /** Adapter-specific total renderer for the throwing-clock arm (preserves each backend's pinned message bytes). */
  readonly throwMessage: (error: unknown) => string;
}

/**
 * ONE encoding for the guarded checkpoint-clock read (round-23 cs-2): throw
 * guard + representability gate + "permanent" classification, previously
 * triplicated near-verbatim across the in-memory, Redis, and file adapters.
 * A throwing clock must become a typed error, never a raw rejection, and a
 * non-representable clock output must fail closed too — a NaN TTL comparison
 * is always `false`, which would silently void the FR-027 expiry (a finite
 * timestamp outside the ±100,000-year Time Value range yields an Invalid
 * `Date`). Both rejections are code-constructed and deterministic, so both
 * settle "permanent" (retriabilityOf fast-fails instead of burning the retry
 * budget). Message construction stays adapter-owned via
 * `render`/`throwMessage`/`cacheError`, so every existing pin's bytes are
 * preserved.
 */
export const guardedCheckpointClockRead = (
  input: GuardedCheckpointClockReadInput,
): Result<number, FrameworkError> => {
  const { operation, runId, now, render, cacheError, throwMessage } = input;
  try {
    const ms = now();
    if (!isRepresentableTimestampMs(ms)) {
      return err(
        cacheError(
          operation,
          `${operation} clock returned a non-representable timestamp for run ${render(runId)}: ${render(ms)}`,
        ),
      );
    }
    return ok(ms);
  } catch (error) {
    return err(cacheError(operation, throwMessage(error)));
  }
};

// --- Domain types ---

export interface RunMeta {
  /**
   * The DAG this run belongs to. Branded `DagId` (the stricter domain —
   * `DAG_ID_REGEX`, no `:` — which exists to keep dagIds out of Redis key
   * namespaces; construct via `dagId()` from `types/ids.ts`). Every valid
   * `DagDef.id` is already in this domain (validated at `validateDagShape`
   * time), so honest consumers brand at zero runtime cost; the adapters
   * still shape-re-validate at their hostile boundary (ADR-0080) — the brand
   * declares the domain, it never relaxes a runtime gate.
   */
  readonly dagId: DagId;
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
  /** The node this state belongs to (branded `NodeId` — see `RunMeta.dagId`). */
  readonly nodeId: NodeId;
  readonly output: unknown;
  readonly completedAt: Date;
}

export interface RunState {
  readonly meta: RunMeta;
  /**
   * Stored node entries keyed by the STORED nodeKey — the canonical `nodeId`
   * for canonical saves, or the composite key
   * `${namespace}@${nodeId}@${index}@${attempt}` for composite saves (ADR-0075;
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
   * no address can be recovered. Always present — empty on a clean load — so
   * the drop-and-surface contract is visible to exhaustive consumers
   * (round-23 tda-3).
   */
  readonly corruptNodeIds: readonly string[];
}

// --- Checkpointer interface ---

/**
 * Per-call options for `Checkpointer.saveNode` — composite checkpoint
 * addressing (ADR-0075, see `composite-node-key.ts`).
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
  /**
   * Identifier ownership (one encoding for the
   * whole checkpoint domain): the port parameters and the meta/node id fields
   * carry the branded ids — `RunId`, `NodeId`, `DagId` — the same brands the
   * engine's sibling `CheckpointWriter.write(runId: RunId, nodeId: NodeId, …)`
   * port already declared. The brands are the DOMAIN declaration at the
   * consumer level (argument-swap safety; `DagId`'s colon-free domain is
   * enforced at the smart constructor, not re-derived per adapter). They do
   * NOT relax any runtime gate: a brand-bypassed hostile value still reaches
   * each adapter's boundary, which keeps its own shape/path re-validation
   * (the file backend re-validates against `ID_PATTERN` for path safety,
   * NFR-010/ADR-0080; the other backends keep their frozen acceptance
   * domains). Backend-swap parity of RUNTIME behavior is unchanged by the
   * re-typing — it is a compile-time contract move, byte-identical at every
   * runtime input.
   */
  load(
    runId: RunId,
    opts?: CheckpointerLoadOpts,
  ): Promise<Result<RunState | null, FrameworkError>>;
  /**
   * Persist a node's terminal state under `runId`.
   *
   * The optional 4th argument enables composite addressing (ADR-0075): with
   * `index`/`attempt` both absent the entry is stored under the canonical
   * `nodeId` key (existing behavior, byte-identical); with either present the
   * entry is stored under the composite key (see `SaveNodeOpts`). The
   * in-memory and Redis backends ignore `opts` exactly as today (FR-023);
   * composite addressing is a versioned opt-in implemented by the file
   * backend. `load` returns entries keyed by the stored nodeKey.
   */
  saveNode(runId: RunId, nodeId: NodeId, state: NodeState, opts?: SaveNodeOpts): Promise<Result<void, FrameworkError>>;
  setMeta(runId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>>;
}

/**
 * `setMeta` write-failure kind mapping — an explicit port decision, not an
 * accident of sequencing (pinned per backend: in-memory in
 * redis-checkpointer.test.ts, "setMeta with unreadable metadata is a typed
 * cache-error(checkpoint:setMeta), never a raw rejection"; file in
 * file-checkpointer.test.ts): for the SAME input class
 * (metadata that cannot be stored — a non-cloneable value, an unreadable
 * getter-bearing bag), each backend's failure kind is:
 *
 * | backend   | kind                                          |
 * |-----------|-----------------------------------------------|
 * | file      | `checkpoint-write-failed` (ADR-0080)          |
 * | in-memory | `cache-error`, operation `checkpoint:setMeta` |
 * | Redis     | `cache-error`, operation `setMeta`            |
 *
 * The file backend's row is mandated by ADR-0080's surface table (nothing
 * was written, and it is that backend's honest write-failure kind); the
 * in-memory and Redis rows are the pre-existing kinds frozen by FR-001/
 * FR-042. A backend-swap caller classifying `setMeta` failures by kind must
 * expect this divergence — it is pinned per backend (`file-checkpointer.
 * test.ts` for file; the hostile-totality suite in `redis-checkpointer.
 * test.ts` for in-memory).
 */

// --- InMemoryCheckpointer ---

/**
 * Internal storage shape — exported as the in-memory backend's TEST-SURFACE
 * type (seam redesign): the shared `checkpointerSuite` and the
 * hostile-totality tests construct and seed these records directly through a
 * constructor-adopted store (below) instead of mutating the adapter's live
 * internals through a public accessor. The shape is exactly what `load`
 * consumes: the caller's meta (possibly with `frameworkVersion` absent, for
 * the ADR-0017 missing-field case) and the writer-stamped `createdAt` (used
 * for the lazy FR-027 TTL evaluation). `createdAt` is split out so the
 * checkpointer owns the timestamp the same way the Redis variant does
 * (stamped at write time in `setMeta`, evaluated against `TTL_SECONDS` on
 * load) — a separate field rather than smuggled onto `RunMeta`, so the
 * public type stays clean.
 */
export interface InMemoryStoredMeta {
  readonly meta: RunMeta;
  readonly createdAt: Date;
}

export class InMemoryCheckpointer implements Checkpointer {
  private readonly metas: Map<string, InMemoryStoredMeta>;
  private readonly nodes = new Map<string, Record<string, NodeState>>();
  private readonly now: () => number;

  constructor(opts?: { readonly now?: () => number; readonly testStore?: Map<string, InMemoryStoredMeta> }) {
    this.now = opts?.now ?? Date.now;
    // Test-store adoption: when a caller (the shared `checkpointerSuite` and
    // the hostile-totality tests) supplies its own map, the adapter reads and
    // writes through THAT map — the test owns the store from construction, so
    // seeding hostile or version-less records is the test's own business, and
    // no method on this class exposes the adapter's internals. Production
    // construction (no `testStore`) is unchanged: a private map, no accessor.
    this.metas = opts?.testStore ?? new Map();
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

  /**
   * The injected clock is an untrusted seam (hostile tests/proxies): a
   * throwing clock must become a typed error, never a raw rejection, and a
   * non-representable clock output must fail closed too — a NaN TTL
   * comparison is always `false`, which would silently void the FR-027
   * expiry (a finite timestamp outside the ±100,000-year Time Value range
   * yields an Invalid `Date`; the file backend's twin rejects the identical
   * inputs; pinned in `redis-checkpointer.test.ts`). ONE encoding for
   * `load` and `setMeta` (the file backend's twin is the same guard).
   */
  private readClock(
    operation: "setMeta" | "load",
    runId: RunId,
  ): Result<number, FrameworkError> {
    // ONE encoding with the Redis and file adapters (round-23 cs-2): the
    // guard structure, representability gate, and "permanent" classification
    // live in the checkpoint core; the twin adapters' pins keep their
    // byte-identical messages through this adapter's renderers below.
    return guardedCheckpointClockRead({
      operation,
      runId,
      now: () => this.now(),
      render: safeDiagnosticRender,
      cacheError: (op, message) => frameworkError.cacheError(`checkpoint:${op}`, message, "permanent"),
      throwMessage: safeErrorMessage,
    });
  }

  async load(
    runId: RunId,
    opts?: CheckpointerLoadOpts,
  ): Promise<Result<RunState | null, FrameworkError>> {
    const stored = this.metas.get(runId);
    if (!stored) return ok(null);
    const { meta, createdAt } = stored;

    // The caller-owned `opts` bag is a hostile seam (parity with the file
    // backend's `parseLoadOpts` snapshot-once discipline): read
    // `expectedDagFingerprint` EXACTLY ONCE under a guard — a throwing
    // accessor getter must become a typed `cache-error`, never a raw
    // rejection, and a stateful getter (different value per read) must not
    // be able to make the gate and the comparison disagree.
    let expectedDagFingerprint: string | undefined;
    try {
      expectedDagFingerprint = opts?.expectedDagFingerprint;
    } catch (error) {
      return err(
        frameworkError.cacheError("checkpoint:load", `load could not inspect options: ${safeErrorMessage(error)}`),
      );
    }

    // ADR-0017/FR-026/FR-027 gate decision — delegated to the ONE shared
    // encoding (`evaluateCheckpointLoadGates`): gate ORDER and verdict
    // construction cannot drift from the Redis and file adapters (round-22
    // atl-1). The clock thunk is this adapter's own guarded readClock, so a
    // hostile clock settles exactly as before — AFTER the version gates.
    const gates = evaluateCheckpointLoadGates(
      {
        runId,
        frameworkVersion: meta.frameworkVersion,
        dagFingerprint: meta.dagFingerprint,
        expectedDagFingerprint,
        createdAt,
      },
      () => this.readClock("load", runId),
    );
    if (!gates.ok) return gates;

    try {
      return ok({
        meta: this.detachStored(meta, "checkpoint meta"),
        nodes: this.detachStored(this.nodes.get(runId) ?? {}, `checkpoint nodes for ${runId}`),
        // In-memory state cannot carry undecodable entries — nothing is ever
        // dropped, so the contract field is present and empty (round-23 tda-3).
        corruptNodeIds: [],
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
            runId: CHECKPOINT_INVALID_RUN_ID,
            message: `stored checkpoint state could not be detached for run ${safeDiagnosticRender(runId)}: ${safeErrorMessage(error)}`,
          });
    }
  }

  async saveNode(
    runId: RunId,
    nodeId: NodeId,
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
      // Construction goes through the public `checkpointWriteFailed` factory
      // — the ONE truthful-branding construction path shared with the file
      // backend (the documented exception to that module's brand-throwing
      // default).
      return err(
        frameworkError.checkpointWriteFailed(
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
    } catch (error) {
      return err(frameworkError.cacheError("checkpoint:setMeta", safeErrorMessage(error)));
    }
    // Timestamp gate: the shared hostile-seam clock guard (throwing or
    // non-representable output settles as a typed `cache-error`; a NaN
    // timestamp would be stored silently and void every `load` TTL
    // comparison — see `readClock`).
    const createdAtClock = this.readClock("setMeta", runId);
    if (!createdAtClock.ok) return createdAtClock;
    createdAt = new Date(createdAtClock.value);
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
}
