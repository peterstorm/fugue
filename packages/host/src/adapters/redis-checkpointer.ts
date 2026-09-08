/**
 * The host's tenant-namespaced `Checkpointer` — the READ side of the
 * checkpoint boundary (F1 PR-B).
 *
 * WHY THIS EXISTS, given the framework already ships `RedisCheckpointer`.
 * A map node declares `requires: ["checkpointer"]` unconditionally, because a
 * partial fan is only resumable if something can READ back the per-index
 * entries it wrote (FR-F1-006/007). The host's existing
 * `createNamespacedCheckpointWriter` is write-only — nothing reads those keys —
 * so before this adapter every DAG containing a map node failed at the
 * capability gate on every host.
 *
 * The framework's own Redis backend cannot fill that hole here, for three
 * reasons that are all about this host rather than about that adapter:
 *
 *   1. Its keys are `chkpt:<runId>` and `chkpt:<runId>:meta` — GLOBAL, with no
 *      tenant segment. `domain/cache-keys.ts` states the host's load-bearing
 *      invariant (AD-4 / US2 / SC-001): every key the host emits is
 *      `fugue:<tenant>:…`. A global checkpoint namespace collides across
 *      tenants on a shared Redis, which is the exact isolation the whole key
 *      scheme exists to provide.
 *   2. A per-tenant worker authenticates as a credential scoped to exactly one
 *      key pattern, `~fugue:<tenant>:*` (`supervisor/secrets/redis-acl.ts`), so
 *      a `chkpt:*` write is DENIED by the ACL at runtime, not merely untidy.
 *   3. It needs `EVAL`/`EVALSHA`/`SCRIPT`, which `RedisPort` does not expose.
 *      Reaching them means handing this factory a raw ioredis client and
 *      discarding the port seam — the boundary where `architecture.md` says a
 *      port is mandatory, and the seam every test fake in this package depends
 *      on.
 *
 * So the storage is the host's, and every DECISION is the framework's. Gate
 * order, the persisted record grammar, the timestamp grammar, the composite
 * address, the hostile-options snapshot, the clock guard and the corrupt-entry
 * policy are all imported from the checkpoint core rather than re-encoded here.
 * That is deliberate and load-bearing: the two backends that DO live side by
 * side in the framework drifted anyway (round-23 atl-1 — Redis accepted any
 * `Date`-parseable timestamp where the file codec demanded canonical ISO), and
 * a backend in another package has strictly worse odds. This file owns bytes,
 * keys and I/O; it owns no verdicts.
 *
 * @satisfies FR-013 — Checkpoint keys prefixed tenant + DAG + run
 * @satisfies FR-041 — Per-DAG checkpoint TTL applied to both keys
 * @satisfies FR-F1-006/007 — a partial fan's completed indices are readable, so
 *   a resumed run re-executes only the indices with no durable entry
 */

import type {
  Checkpointer,
  CheckpointerLoadOpts,
  CorruptCheckpointAddress,
  DagId,
  FrameworkError,
  NodeState,
  Result,
  RunId,
  RunMeta,
  RunState,
  SaveNodeOpts,
} from "@fuguejs/framework";
import {
  FRAMEWORK_VERSION,
  TTL_SECONDS,
  encodeStoredNodeKey,
  err,
  evaluateCheckpointLoadGates,
  frameworkError,
  ok,
  parseNodeStateRecord,
  parseRunMetaRecord,
  reportCorruptCheckpointEntry,
  safeErrorMessage,
  snapshotExpectedDagFingerprint,
  standardCheckpointClockRead,
} from "@fuguejs/framework";
import type { LogPort, RedisPort } from "../ports.js";
import type { HostError } from "../domain/host-error.js";
import { formatHostError } from "../domain/host-error.js";
import type { TenantId } from "../domain/cache-keys.js";
import { buildCheckpointMetaKey, buildCheckpointNodesKey } from "../domain/cache-keys.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";

/**
 * The `RedisPort` subset this adapter needs, with the two hash primitives
 * PROVEN present rather than assumed.
 *
 * `hGetAll`/`hSet` are optional on `RedisPort` so the supervisor's in-memory
 * ports stay valid without implementing them. An adapter that simply called
 * `redis.hSet!(…)` would turn a port that cannot do the job into a
 * `TypeError` at the first fan index — deep inside a run, after the capability
 * gate has already passed and told the operator everything was wired. Parsing
 * the port once, at construction, moves that verdict to boot: an incapable
 * port yields no checkpointer, no `checkpointer` capability, and the run is
 * refused BEFORE any node executes with a message naming the missing wiring.
 */
export type CheckpointerRedisPort = Pick<RedisPort, "get" | "set"> & {
  readonly hGetAll: NonNullable<RedisPort["hGetAll"]>;
  readonly hSet: NonNullable<RedisPort["hSet"]>;
};

/**
 * Parse, don't validate: narrow a `RedisPort` to one that can back a
 * checkpointer, or `null` when it cannot. The returned value is the only thing
 * `createNamespacedCheckpointer` accepts, so the presence check cannot be
 * skipped at a call site.
 */
export const asCheckpointerRedisPort = (redis: RedisPort): CheckpointerRedisPort | null =>
  redis.hGetAll === undefined || redis.hSet === undefined
    ? null
    : { get: redis.get, set: redis.set, hGetAll: redis.hGetAll, hSet: redis.hSet };

/** The persisted metadata envelope — the grammar `parseRunMetaRecord` gates. */
interface StoredMeta {
  readonly dagId: string;
  readonly startedAt: string;
  readonly nodeCount: number;
  readonly createdAt: string;
  readonly subject?: string;
  readonly dagFingerprint?: string;
  readonly frameworkVersion?: string;
}

/** The persisted node envelope — the grammar `parseNodeStateRecord` gates. */
interface StoredNodeState {
  readonly nodeId: string;
  readonly output: unknown;
  readonly completedAt: string;
}

/**
 * Decode ONE stored node entry — pure, and total over hostile bytes.
 *
 * Separate from the load loop because it is the only part of that loop with no
 * I/O and no reporting in it: the loop then reads as "decode, else drop and
 * name", one level of abstraction throughout. The record grammar itself belongs
 * to the framework (`parseNodeStateRecord`); `output` is pass-through, exactly
 * as it is in the in-package Redis backend.
 */
const decodeNodeEntry = (raw: string): Result<NodeState, string> => {
  try {
    const stored = JSON.parse(raw) as StoredNodeState;
    const parsed = parseNodeStateRecord(stored);
    if (!parsed.ok) return err(parsed.error);
    return ok({
      nodeId: parsed.value.nodeId,
      output: stored.output,
      completedAt: parsed.value.completedAt,
    });
  } catch (error) {
    return err(safeErrorMessage(error));
  }
};

export interface NamespacedCheckpointerOpts {
  /**
   * Injected clock, in epoch milliseconds. Untrusted like every other seam: a
   * throwing or non-representable clock must become a typed error, never a raw
   * rejection and never a silently voided expiry check (a `NaN` comparison is
   * always `false`). Guarded by the framework's own
   * `standardCheckpointClockRead`, so the failure precedence — version gates
   * BEFORE any clock read — matches all three in-package backends.
   */
  readonly now?: () => number;
}

/**
 * Create a `Checkpointer` scoped to one tenant + DAG + run.
 *
 * `checkpointTtlSec` is the per-DAG override (FR-041); absent, both keys fall
 * back to the port's own FR-027 contract (`TTL_SECONDS`) rather than to no
 * expiry at all — an immortal checkpoint key is a retention defect, and the
 * framework backends all stamp a TTL unconditionally.
 */
export const createNamespacedCheckpointer = (
  redis: CheckpointerRedisPort,
  tenant: TenantId,
  dagId: DagId,
  runId: RunId,
  checkpointTtlSec: number | undefined,
  logger: LogPort,
  opts: NamespacedCheckpointerOpts = {},
): Checkpointer => {
  const now = opts.now ?? Date.now;
  const ttlSec = checkpointTtlSec ?? TTL_SECONDS;
  const metaKey = buildCheckpointMetaKey(tenant, dagId, runId);
  const nodesKey = buildCheckpointNodesKey(tenant, dagId, runId);

  // The namespace is fixed at construction, exactly as it is for the sibling
  // `createNamespacedCheckpointWriter`: tenant, DAG and run are known when the
  // node context is built and cannot change under a node. The port still takes
  // `runId` per call, so the two must be proven to agree rather than assumed —
  // an adapter that ignored a mismatch would serve one run's entries to
  // another, which is the failure the tenant prefix exists to make impossible.
  // A mismatch is caller error, not corrupt data, so it settles as a typed
  // `cache-error` rather than a checkpoint verdict.
  const wrongRun = (
    operation: "load" | "saveNode" | "setMeta",
    asked: RunId,
  ): Result<never, FrameworkError> =>
    err(frameworkError.cacheError(
      `checkpoint:${operation}`,
      `checkpointer is scoped to run ${runId} and was asked for ${asked}`,
      "permanent",
    ));

  const readClock = (operation: "setMeta" | "load"): Result<number, FrameworkError> =>
    standardCheckpointClockRead(operation, runId, now);

  /**
   * Every driver call goes through here, and none may be awaited bare.
   *
   * `RedisPort` methods DECLARE `Promise<Result<…, HostError>>`, but a declared
   * return type is not a runtime guarantee: the ioredis adapter converts what
   * it knows about, and a driver that throws on invocation, rejects on a closed
   * socket, or is a hostile fake still produces a raw rejection. This port's
   * contract is `Promise<Result<_, FrameworkError>>` with no rejecting arm, so
   * an unguarded `await` would let that rejection escape a `Checkpointer` —
   * past the map node's `run`, which has the same contract. The sibling
   * `createNamespacedCache` wraps its own driver calls for exactly this reason.
   */
  const driver = async <T>(
    operation: string,
    call: () => Promise<Result<T, HostError>>,
  ): Promise<Result<T, FrameworkError>> => {
    let outcome: Result<T, HostError>;
    try {
      outcome = await call();
    } catch (e) {
      return err(frameworkError.cacheError(operation, safeErrorMessage(e)));
    }
    return outcome.ok
      ? ok(outcome.value)
      : err(frameworkError.cacheError(operation, formatHostError(outcome.error)));
  };

  return {
    load: async (
      askedRunId: RunId,
      loadOpts?: CheckpointerLoadOpts,
    ): Promise<Result<RunState | null, FrameworkError>> => {
      if (askedRunId !== runId) return wrongRun("load", askedRunId);

      const rawMeta = await driver("load:get-meta", () => redis.get(metaKey));
      if (!rawMeta.ok) return rawMeta;
      // No metadata record means no checkpoint for this run — a FRESH run, not
      // a failure. The map node reads exactly this to decide whether to seed a
      // record before writing its first index.
      if (rawMeta.value === null) return ok(null);

      let meta: RunMeta;
      let createdAt: Date;
      try {
        const parsed = parseRunMetaRecord(JSON.parse(rawMeta.value) as StoredMeta);
        if (!parsed.ok) throw new Error(parsed.error);
        ({ meta, createdAt } = parsed.value);
      } catch (e) {
        // Through the factory, like every other error site in this file. The
        // literal it replaces was type-safe, but it was a second construction
        // path for one kind — a field added to `checkpoint-corrupt` would have
        // had one call site the compiler could not point at.
        return err(
          frameworkError.checkpointCorrupt(runId, `meta deserialize failed: ${safeErrorMessage(e)}`),
        );
      }

      const expectedFingerprint = snapshotExpectedDagFingerprint(loadOpts);
      if (!expectedFingerprint.ok) return expectedFingerprint;

      // ADR-0017 / FR-026 / FR-027 — the framework's own gate decision, passed
      // this adapter's guarded clock as a thunk so the version gates still
      // evaluate before any clock read.
      const gates = evaluateCheckpointLoadGates(
        {
          runId,
          frameworkVersion: meta.frameworkVersion,
          dagFingerprint: meta.dagFingerprint,
          expectedDagFingerprint: expectedFingerprint.value,
          createdAt,
        },
        () => readClock("load"),
      );
      if (!gates.ok) return gates;

      const rawNodes = await driver("load:hgetall-nodes", () => redis.hGetAll(nodesKey));
      if (!rawNodes.ok) return rawNodes;

      // Per-entry decode: one corrupt row must not poison the rest. A node with
      // no readable entry is simply re-executed, so the honest outcome is to
      // drop the row and NAME it — a caller that cannot tell "never ran" from
      // "ran but is unreadable" cannot reason about a partial fan at all.
      const nodes: Record<string, NodeState> = {};
      const corruptNodeAddresses: CorruptCheckpointAddress[] = [];
      for (const [storedKey, raw] of Object.entries(rawNodes.value)) {
        const decoded = decodeNodeEntry(raw);
        if (!decoded.ok) {
          // The framework's required drop-and-surface policy: a dropped entry
          // counts as handled only once its warning was emitted, and a hostile
          // logger becomes a typed load error rather than a raw rejection.
          // `logWithoutThrowing` already guards this host's log port, so the
          // failure arm is unreachable in production and present for parity.
          const reported = reportCorruptCheckpointEntry({
            warning:
              `Dropping corrupt checkpoint entry runId=${runId} nodeKey=${storedKey}: ` +
              decoded.error,
            warn: (warning) =>
              logWithoutThrowing(logger, "warn", warning, { dagId, runId, nodeKey: storedKey }),
            loggerFailure: (message) => frameworkError.cacheError("checkpoint:load", message),
          });
          if (!reported.ok) return reported;
          corruptNodeAddresses.push({ kind: "node-key", nodeKey: storedKey });
          continue;
        }
        // `__proto__` matches `ID_PATTERN` (`_` is in the charset), so it is a
        // legal nodeId and therefore a legal canonical hash field. Plain
        // bracket assignment would hit `Object.prototype`'s `__proto__` SETTER
        // and re-parent this map instead of defining an own entry — the same
        // reason every in-package backend uses `defineProperty` here.
        Object.defineProperty(nodes, storedKey, {
          value: decoded.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      // Always present, empty on a clean load, so the drop-and-surface contract
      // is visible to exhaustive consumers rather than inferred from absence.
      return ok({ meta, nodes, corruptNodeAddresses });
    },

    saveNode: async (
      askedRunId: RunId,
      state: NodeState,
      saveOpts?: SaveNodeOpts,
    ): Promise<Result<void, FrameworkError>> => {
      if (askedRunId !== runId) return wrongRun("saveNode", askedRunId);

      // Serialization is guarded, not incidental: `NodeState.output` is
      // `unknown`, so a cyclic object or a BigInt is type-legal and makes
      // `JSON.stringify` throw, and an invalid `completedAt` makes
      // `toISOString()` throw. Its own try, ahead of the address encoding, so a
      // value that cannot be serialized issues NO driver call.
      let payload: string;
      try {
        payload = JSON.stringify({
          nodeId: state.nodeId,
          output: state.output,
          completedAt: state.completedAt.toISOString(),
        } satisfies StoredNodeState);
        if (payload === undefined) {
          throw new Error("JSON.stringify returned undefined for the node entry");
        }
      } catch (e) {
        return err(frameworkError.cacheError("saveNode", safeErrorMessage(e)));
      }

      // The port's explicit requirement: route the address through
      // `encodeStoredNodeKey` so a malformed composite address fails
      // `checkpoint-write-failed` WITHOUT issuing a write, rather than folding
      // silently to the canonical key and overwriting a sibling index.
      const nodeKey = encodeStoredNodeKey(runId, state.nodeId, saveOpts);
      if (!nodeKey.ok) return nodeKey;

      return driver("saveNode", () =>
        redis.hSet(nodesKey, nodeKey.value, payload, { expiresInSec: ttlSec }));
    },

    setMeta: async (askedRunId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>> => {
      if (askedRunId !== runId) return wrongRun("setMeta", askedRunId);

      // The write clock, read through the same guard as the load clock: a
      // throwing clock must not produce a record whose `createdAt` the expiry
      // gate can never evaluate.
      const createdAt = readClock("setMeta");
      if (!createdAt.ok) return createdAt;

      let payload: string;
      try {
        payload = JSON.stringify({
          dagId: meta.dagId,
          startedAt: meta.startedAt.toISOString(),
          nodeCount: meta.nodeCount,
          createdAt: new Date(createdAt.value).toISOString(),
          ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
          ...(meta.dagFingerprint !== undefined ? { dagFingerprint: meta.dagFingerprint } : {}),
          // ADR-0017: always stamp the writing framework's version so `load`
          // can reject a resume that crosses a framework release. An explicit
          // caller value wins, which is what lets a test construct a stale one.
          frameworkVersion: meta.frameworkVersion ?? FRAMEWORK_VERSION,
        } satisfies StoredMeta);
      } catch (e) {
        return err(frameworkError.cacheError("checkpoint:setMeta", safeErrorMessage(e)));
      }

      const written = await driver("checkpoint:setMeta", () =>
        redis.set(metaKey, payload, { expiresInSec: ttlSec }));
      return written.ok ? ok(undefined) : written;
    },
  };
};
