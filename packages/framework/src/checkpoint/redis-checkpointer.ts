import Redis from "ioredis";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId, NodeId } from "../types/ids.js";
import { __brandDagIdUnchecked, __brandNodeIdUnchecked } from "../types/ids.js";
import { ok, err } from "../types/result.js";
import type { Checkpointer, CheckpointerLoadOpts, RunMeta, NodeState, RunState } from "./checkpointer.js";
import { TTL_SECONDS, evaluateCheckpointLoadGates } from "./checkpointer.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import { frameworkError } from "../types/error-factories.js";
import { isRepresentableTimestampMs } from "../types/clock.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";
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

const serializeMeta = (meta: RunMeta, createdAtMs: number): string =>
  JSON.stringify({
    dagId: meta.dagId,
    startedAt: meta.startedAt.toISOString(),
    nodeCount: meta.nodeCount,
    createdAt: new Date(createdAtMs).toISOString(),
    ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
    ...(meta.dagFingerprint !== undefined ? { dagFingerprint: meta.dagFingerprint } : {}),
    // ADR-0017: always stamp the writing framework's version so load() can
    // reject resumes that cross framework releases. Explicit caller value
    // wins (lets tests construct stale-version payloads).
    frameworkVersion: meta.frameworkVersion ?? FRAMEWORK_VERSION,
  } satisfies StoredMeta);

const deserializeMeta = (raw: string): { meta: RunMeta; createdAt: Date } => {
  const stored: StoredMeta = JSON.parse(raw);
  // Read-side sanity gates, mirroring the file codec's parseStoredMeta. The
  // brand pass-through below is an honest re-typing of the ID domain only —
  // it is never a license for corrupt bytes (a negative/Infinity/string
  // nodeCount, a non-string dagId, non-string optional fields) to reach
  // consumers as a "valid" checkpoint: the file twin rejects the identical
  // bytes as `checkpoint-corrupt`, so this leg must fail the same way.
  if (typeof stored.dagId !== "string") {
    throw new Error(`Invalid dagId in checkpoint meta: ${safeDiagnosticRender(stored.dagId)}`);
  }
  if (typeof stored.startedAt !== "string") {
    throw new Error(`Invalid startedAt in checkpoint meta: ${safeDiagnosticRender(stored.startedAt)}`);
  }
  if (typeof stored.createdAt !== "string") {
    throw new Error(`Invalid createdAt in checkpoint meta: ${safeDiagnosticRender(stored.createdAt)}`);
  }
  if (
    typeof stored.nodeCount !== "number" ||
    !Number.isSafeInteger(stored.nodeCount) ||
    stored.nodeCount < 0
  ) {
    throw new Error(`Invalid nodeCount in checkpoint meta: ${safeDiagnosticRender(stored.nodeCount)}`);
  }
  if (stored.subject !== undefined && typeof stored.subject !== "string") {
    throw new Error(`Invalid subject in checkpoint meta: ${safeDiagnosticRender(stored.subject)}`);
  }
  if (stored.dagFingerprint !== undefined && typeof stored.dagFingerprint !== "string") {
    throw new Error(`Invalid dagFingerprint in checkpoint meta: ${safeDiagnosticRender(stored.dagFingerprint)}`);
  }
  if (stored.frameworkVersion !== undefined && typeof stored.frameworkVersion !== "string") {
    throw new Error(`Invalid frameworkVersion in checkpoint meta: ${safeDiagnosticRender(stored.frameworkVersion)}`);
  }
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
  // Read-side sanity gate (parity with the meta twin and the file codec's
  // parseStoredNode): a non-string nodeId from corrupt/drifted bytes must
  // fail as corrupt HERE — per-entry, dropping the row into `corruptNodeIds`
  // — never flow a number/object into the node map and node dispatch.
  if (typeof stored.nodeId !== "string") {
    throw new Error(`Invalid nodeId in checkpoint node: ${safeDiagnosticRender(stored.nodeId)}`);
  }
  if (typeof stored.completedAt !== "string") {
    throw new Error(`Invalid completedAt in checkpoint node: ${safeDiagnosticRender(stored.completedAt)}`);
  }
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

  /**
   * The injected clock is an untrusted seam (hostile tests/proxies): a
   * throwing clock must become a typed error, never a raw rejection, and a
   * non-representable clock output must fail closed too — a NaN TTL
   * comparison is always `false`, which would silently void the FR-027
   * expiry (a finite timestamp outside the ±100,000-year Time Value range
   * yields an Invalid `Date`; the in-memory and file twins reject the
   * identical inputs; pinned in `clock-parity.test.ts`). ONE encoding for
   * `load` and `setMeta` (the in-memory adapter's twin is the same guard).
   */
  private readClock(
    operation: "setMeta" | "load",
    runId: RunId,
  ): Result<number, FrameworkError> {
    try {
      const ms = this.now();
      if (!isRepresentableTimestampMs(ms)) {
        return err(
          frameworkError.cacheError(
            `checkpoint:${operation}`,
            `${operation} clock returned a non-representable timestamp for run ${safeDiagnosticRender(runId)}: ${safeDiagnosticRender(ms)}`,
            "permanent",
          ),
        );
      }
      return ok(ms);
    } catch (error) {
      // A throwing clock is deterministic — retrying cannot clear it — so it
      // settles permanent like the non-representable arm above (retriabilityOf
      // fast-fails instead of burning the retry budget).
      return err(
        frameworkError.cacheError(
          `checkpoint:${operation}`,
          safeErrorMessage(error),
          "permanent",
        ),
      );
    }
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

    // The caller-owned `opts` bag is a hostile seam (parity with the
    // in-memory adapter and the file backend's `parseLoadOpts` snapshot-once
    // discipline): read `expectedDagFingerprint` EXACTLY ONCE under a guard —
    // a throwing accessor getter becomes a typed `cache-error`, never a raw
    // rejection, and a stateful getter (different value per read) cannot make
    // the gate and the comparison disagree.
    let expectedDagFingerprint: string | undefined;
    try {
      expectedDagFingerprint = opts?.expectedDagFingerprint;
    } catch (error) {
      return err(
        frameworkError.cacheError("checkpoint:load", `load could not inspect options: ${safeErrorMessage(error)}`),
      );
    }

    // ADR-0017/FR-026/FR-027 gate decision — the ONE shared encoding
    // (evaluateCheckpointLoadGates): gate order + verdict construction are
    // identical to the in-memory and file adapters (round-22 atl-1). The
    // clock thunk is this adapter's own guarded readClock, so the version
    // gates still evaluate BEFORE any clock read (failure-precedence
    // parity).
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
        // an own entry (the file backend's defineProperty choice, parity-
        // pinned across all legs in the shared `checkpointerSuite`).
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
    // Timestamp gate: the shared hostile-seam clock guard (throwing or
    // non-representable output settles as a typed `cache-error`; a NaN
    // timestamp would be stored silently and void every `load` TTL
    // comparison — see `readClock`). `createdAt` is stamped from the
    // injected clock like the in-memory adapter, so a fixed-clock test
    // suite drives the write side deterministically.
    const createdAtClock = this.readClock("setMeta", runId);
    if (!createdAtClock.ok) return createdAtClock;
    try {
      await this.redis.set(metaKey(runId), serializeMeta(meta, createdAtClock.value), "EX", TTL_SECONDS);
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
