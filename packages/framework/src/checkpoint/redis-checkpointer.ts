import Redis from "ioredis";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId, NodeId } from "../types/ids.js";
import { ok, err } from "../types/result.js";
import type {
  Checkpointer,
  CheckpointerLoadOpts,
  CorruptCheckpointAddress,
  RunMeta,
  NodeState,
  RunState,
} from "./checkpointer.js";
import {
  TTL_SECONDS,
  evaluateCheckpointLoadGates,
  standardCheckpointClockRead,
  parseNodeStateRecord,
  parseRunMetaRecord,
  reportCorruptCheckpointEntry,
  snapshotExpectedDagFingerprint,
} from "./checkpointer.js";
import { FRAMEWORK_VERSION } from "./fingerprint.js";
import { frameworkError } from "../types/error-factories.js";
import { safeErrorMessage } from "../types/safe-error.js";
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
  // ONE encoding with the file codec (round-23 atl-1): the record grammar
  // gates (type gates, canonical ISO dates, safe-integer nodeCount, ID
  // domains) live in the checkpoint core's `parseRunMetaRecord`. The brand
  // pass-through inside is an honest re-typing of the ID domain only — it is
  // never a license for corrupt bytes (a negative/Infinity/string nodeCount,
  // a non-string dagId, non-string optional fields) to reach consumers as a
  // "valid" checkpoint: the file twin rejects the identical bytes as
  // `checkpoint-corrupt`, so this leg must fail the same way.
  const parsed = parseRunMetaRecord(stored);
  if (!parsed.ok) throw new Error(parsed.error);
  return { meta: parsed.value.meta, createdAt: parsed.value.createdAt };
};

const serializeNode = (
  state: NodeState,
): { readonly nodeId: NodeId; readonly payload: string } => {
  const nodeId = state.nodeId;
  const output = state.output;
  const completedAt = state.completedAt;
  return {
    nodeId,
    payload: JSON.stringify({
      nodeId,
      output,
      completedAt: completedAt.toISOString(),
    } satisfies StoredNodeState),
  };
};

const deserializeNode = (raw: string): NodeState => {
  const stored: StoredNodeState = JSON.parse(raw);
  // ONE encoding with the file codec (round-23 atl-1): the record grammar
  // gates live in the checkpoint core's `parseNodeStateRecord` — a non-string
  // or `ID_PATTERN`-violating nodeId, or a non-canonical completedAt, from
  // corrupt/drifted bytes must fail as corrupt HERE — per-entry, dropping the
  // row into `corruptNodeAddresses` — never flow a number/object into the node map
  // and node dispatch. (The `output` field stays adapter-side pass-through.)
  const parsedNode = parseNodeStateRecord(stored);
  if (!parsedNode.ok) {
    throw new Error(parsedNode.error);
  }
  return {
    nodeId: parsedNode.value.nodeId,
    output: stored.output,
    completedAt: parsedNode.value.completedAt,
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
    return standardCheckpointClockRead(operation, runId, () => this.now());
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
        message: safeErrorMessage(e),
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
        message: `meta deserialize failed: ${safeErrorMessage(e)}`,
      });
    }

    const expectedFingerprint = snapshotExpectedDagFingerprint(opts);
    if (!expectedFingerprint.ok) return expectedFingerprint;
    const expectedDagFingerprint = expectedFingerprint.value;

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
        message: safeErrorMessage(e),
      });
    }

    // Per-entry deserialize: a single corrupt row must not poison the rest.
    // Missing nodes will be re-executed (DAG nodes are idempotency-safe by design).
    // Surface dropped node-key addresses so callers can distinguish "node
    // never ran" from "node ran but checkpoint is unreadable".
    const nodes: Record<string, NodeState> = {};
    const corruptNodeAddresses: CorruptCheckpointAddress[] = [];
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
      } catch (error) {
        const report = reportCorruptCheckpointEntry({
          warning: `[RedisCheckpointer] Dropping corrupt checkpoint entry runId=${runId} nodeId=${nodeId}: ${safeErrorMessage(error)}`,
          warn: (warning) => fwLogger().warn(warning),
          loggerFailure: (message) => frameworkError.cacheError("checkpoint:load", message),
        });
        if (!report.ok) return report;
        corruptNodeAddresses.push({ kind: "node-key", nodeKey: nodeId });
      }
    }

    return ok({
      meta,
      nodes,
      // Always present — empty when no entry was dropped — so the
      // drop-and-surface contract is visible to exhaustive consumers
      // (round-23 tda-3).
      corruptNodeAddresses,
    });
  }

  async saveNode(runId: RunId, state: NodeState): Promise<Result<void, FrameworkError>> {
    try {
      const { nodeId, payload } = serializeNode(state);
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
        message: safeErrorMessage(e),
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
        message: safeErrorMessage(e),
      });
    }
  }
}
