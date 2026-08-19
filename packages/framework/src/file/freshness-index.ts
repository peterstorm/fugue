// Durable filesystem FreshnessIndex (FR-030..FR-032, ADR-0079/ADR-0080).
//
// ADR-0079 stores exactly one bounded latest-write singleton per resource:
//
//   <directory>/<sha256hex(resource)>.json
//   { writtenAtMs, runId, nodeId, newWitness, succeededAtMs }
//
// History belongs to the event log; this index deliberately persists neither
// an append log nor a Redis member set. Writes for one digest are serialized,
// compared, and atomically replaced. A lower succeededAtMs cannot overwrite a
// newer singleton. Equal scores use Redis's reverse unsigned-binary member
// ordering, making the winner deterministic regardless of arrival order.
// Every successful recordWrite refreshes writtenAtMs (Redis EXPIRE parity),
// including a stale write that loses the comparison. Readers therefore see
// either the complete previous singleton or the complete replacement, never a
// partial record. Expiry is evaluated lazily; there is no sweep or physical GC.
//
// The resource is intentionally unbounded by the port and is never a path
// component: only its sha256 digest reaches the filename. Persisted bytes pass
// through a strict singleton codec and a digest/content resource check.
// Malformed records are warned and treated as absent by findConflict; logger,
// filesystem, clock, and hostile runtime-accessor failures become typed
// freshness cache-errors. No raw exception crosses either port method.
//
// Symlink policy — a DELIBERATE divergence from the file checkpointer: the
// digest-addressed singletons are read with plain `readFileSync`, which
// FOLLOWS symlinks, while the checkpointer's `verifyExistingFile`/
// `verifyDirectory` lstat-verify every path component as a non-symlink under a
// canonical base anchor. The asymmetry is sound because the filename here is
// not caller-controlled path material — only the sha256 digest is — so the
// caller's `directory` is the sole trust boundary and a symlink inside that
// operator-owned directory is operator-controlled material. The checkpointer,
// by contrast, addresses files with arbitrary caller-supplied composite node
// keys, where a symlink is an in-band attack vector. The write side matches
// the read side: `atomicWriteFile`'s rename REPLACES a symlink at the digest
// path rather than writing through it (pinned in the symlink tests).

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, withFileLock } from "./atomic.js";
import { isBoundaryIdString, isPlainRecord, keyDigest } from "./layout.js";
import { fwLogger } from "../logger.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import type {
  FreshnessIndex,
  Witness,
  WitnessKind,
  WriteEntry,
} from "../types/freshness.js";
import { parseFileFactoryClock } from "./options.js";
import { FRESHNESS_TTL_SECONDS, __brandWitness, isWitnessKind } from "../types/freshness.js";
import { isFrameworkError, type FrameworkError } from "../types/errors.js";
import { __brandNodeId, __brandRunId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import {
  isMissingPathError,
  probeErrorCode,
  safeDiagnosticRender,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
  type ErrorCodeProbe,
} from "../types/safe-error.js";
import {
  fileCacheError,
  fileOperationError,
  fileThrownValueMessage,
  isFileBackendPathString,
  LOCK_PROTOCOL_OPERATIONS,
  type FileOperation,
} from "./boundary-error.js";

const TTL_MS = FRESHNESS_TTL_SECONDS * 1000;

interface PreparedFreshnessWrite {
  readonly resource: string;
  readonly runId: WriteEntry["runId"];
  readonly nodeId: WriteEntry["nodeId"];
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
}

interface StoredFreshnessEntry extends PreparedFreshnessWrite {
  readonly writtenAtMs: number;
}

type ConditionedOnSnapshot = Readonly<{
  kind: WitnessKind;
  resource: string;
  value: string;
}>;

type RawWriteSnapshot = Readonly<{
  type: unknown;
  runId: unknown;
  nodeId: unknown;
  newWitness: unknown;
  succeededAtMs: unknown;
}>;

type RawWitnessSnapshot = Readonly<{
  kind: unknown;
  resource: unknown;
  value: unknown;
}>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * ONE encoding of the witness-field acceptance domain (kind ∈ closed
 * WitnessKind union, non-empty resource, non-empty value) shared by the
 * three boundary parsers. `afterResource` lets the strict stored-entry
 * reader interpose its digest/content resource agreement between the
 * resource and value gates, preserving its pre-helper gate order exactly.
 */
const parseWitnessFields = (
  raw: Readonly<{ kind: unknown; resource: unknown; value: unknown }>,
  label: string,
  afterResource?: (resource: string) => string | null,
): Result<{ kind: WitnessKind; resource: string; value: string }, string> => {
  if (!isWitnessKind(raw.kind)) {
    return err(`${label}.kind is not a WitnessKind`);
  }
  if (!isNonEmptyString(raw.resource)) {
    return err(`${label}.resource must be non-empty`);
  }
  if (afterResource !== undefined) {
    const disagreement = afterResource(raw.resource);
    if (disagreement !== null) return err(disagreement);
  }
  if (!isNonEmptyString(raw.value)) {
    return err(`${label}.value must be non-empty`);
  }
  return ok({ kind: raw.kind, resource: raw.resource, value: raw.value });
};

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index]);
};

type FreshnessOperation = Extract<
  FileOperation,
  "freshness:recordWrite" | "freshness:findConflict"
>;

const cacheFailure = (
  operation: FreshnessOperation,
  digest: string | null,
  error: unknown,
  codeProbe?: ErrorCodeProbe,
  failureClass?: "transient" | "permanent",
): FrameworkError =>
  fileCacheError(
    operation,
    `${digest === null ? "resource digest unavailable" : `resource digest ${digest}`}: ${
      codeProbe === undefined
        ? safeErrorMessage(error)
        : safeErrorMessageWithCodeProbe(error, codeProbe)
    }`,
    failureClass,
  );

/**
 * The public freshness surface for a thrown/returned failure (ADR-0080,
 * mirroring the journal's `appendEvent` re-tag at its public boundary):
 *
 * - a typed failure whose operation is in the CLOSED lock-protocol set
 *   (`acquireFileLock` / `withFileLock` / `releaseFileLock` /
 *   `stealStaleFileLock` — atomic.ts internals) is RE-TAGGED to this
 *   operation: the lock's internal mechanics must not name the caller's
 *   port call. The re-tag preserves the inner `failureClass` (inferred from
 *   the wrapped cache-error) and the full diagnostic chain — the
 *   `withFileLock` diagnostic names the lock path and carries the primary
 *   body failure (e.g. the `atomicWriteFile` commit error) nested inside;
 * - any OTHER typed failure already carries its own operation (this port's
 *   operation, or a body-internal one such as `keyDigest`) and rides through
 *   unchanged — re-wrapping it would double-nest the diagnostic and drop
 *   the class;
 * - anything not yet typed is wrapped as this operation's failure.
 */
const surfaceFailure = (
  operation: FreshnessOperation,
  digest: string | null,
  error: unknown,
): FrameworkError => {
  if (
    isFrameworkError(error) &&
    error.kind === "cache-error" &&
    // The public `cache-error.operation` is deliberately `string`-typed for
    // adapter compatibility; narrowing to the closed `FileOperation`
    // vocabulary at this file-backend boundary (boundary-error.ts contract)
    // makes the set-membership test unrepresentable-misspelling safe.
    LOCK_PROTOCOL_OPERATIONS.has(error.operation as FileOperation)
  ) {
    return fileOperationError(
      operation,
      digest === null ? "resource digest unavailable" : `resource digest ${digest}`,
      error,
    );
  }
  if (isFrameworkError(error)) return error;
  return cacheFailure(operation, digest, error);
};

/** Snapshot each accessor-backed event field once before validating any value. */
const snapshotWriteEvent = (event: Record<string, unknown>): RawWriteSnapshot => ({
  type: event.type,
  runId: event.runId,
  nodeId: event.nodeId,
  newWitness: event.newWitness,
  succeededAtMs: event.succeededAtMs,
});

/** Snapshot each accessor-backed witness field once before validation. */
const snapshotWitness = (value: Record<string, unknown>): RawWitnessSnapshot => ({
  kind: value.kind,
  resource: value.resource,
  value: value.value,
});

/** Boundary/snapshotting parser: untrusted getters and proxy traps run while snapshotting; post-snapshot validation and construction are deterministic. */
const prepareFreshnessWrite = (
  event: unknown,
): Result<PreparedFreshnessWrite, string> => {
  if (!isPlainRecord(event)) return err("write event must be an object");
  const rawEvent = snapshotWriteEvent(event);

  if (rawEvent.type !== "write-attempted") {
    return err('write event type must be exactly "write-attempted"');
  }
  if (!isBoundaryIdString(rawEvent.runId)) {
    return err("runId does not match the framework ID boundary");
  }
  if (!isBoundaryIdString(rawEvent.nodeId)) {
    return err("nodeId does not match the framework ID boundary");
  }
  if (!isPlainRecord(rawEvent.newWitness)) {
    return err("newWitness must be an object");
  }

  const rawWitness = snapshotWitness(rawEvent.newWitness);
  const parsedWitness = parseWitnessFields(rawWitness, "newWitness");
  if (!parsedWitness.ok) return parsedWitness;
  if (!isFiniteNumber(rawEvent.succeededAtMs)) {
    return err("succeededAtMs must be finite");
  }

  return ok({
    resource: parsedWitness.value.resource,
    runId: __brandRunId(rawEvent.runId),
    nodeId: __brandNodeId(rawEvent.nodeId),
    newWitness: __brandWitness({
      kind: parsedWitness.value.kind,
      resource: parsedWitness.value.resource,
      value: parsedWitness.value.value,
    }),
    succeededAtMs: rawEvent.succeededAtMs,
  });
};

/** Boundary/snapshotting parser: untrusted getters and proxy traps run while snapshotting; post-snapshot validation and construction are deterministic. */
const parseConditionedOn = (value: unknown): Result<ConditionedOnSnapshot, string> => {
  if (!isPlainRecord(value)) return err("conditionedOn must be an object");
  const rawWitness = snapshotWitness(value);
  const parsedWitness = parseWitnessFields(rawWitness, "conditionedOn");
  if (!parsedWitness.ok) return parsedWitness;
  return ok({
    kind: parsedWitness.value.kind,
    resource: parsedWitness.value.resource,
    value: parsedWitness.value.value,
  });
};

/** Exact Redis member bytes used solely for equal-score winner parity. */
const serializeRedisFreshnessMember = (entry: PreparedFreshnessWrite): string =>
  JSON.stringify([
    entry.runId,
    entry.nodeId,
    entry.newWitness.kind,
    entry.newWitness.value,
  ]);

/** Redis compares equal-score members as unsigned byte strings. */
const compareRedisMemberSerialization = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const serializeStoredFreshnessEntry = (entry: StoredFreshnessEntry): string =>
  JSON.stringify({
    writtenAtMs: entry.writtenAtMs,
    runId: entry.runId,
    nodeId: entry.nodeId,
    newWitness: {
      kind: entry.newWitness.kind,
      resource: entry.newWitness.resource,
      value: entry.newWitness.value,
    },
    succeededAtMs: entry.succeededAtMs,
  });

/** Strict pure parser for the one ADR-0079 persisted singleton shape. */
const parseStoredFreshnessEntry = (
  text: string,
  expectedResource: string,
): Result<StoredFreshnessEntry, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err(`not valid JSON: ${safeErrorMessage(error)}`);
  }
  if (!isPlainRecord(raw)) return err("entry must be a JSON object");
  if (!hasExactKeys(raw, ["writtenAtMs", "runId", "nodeId", "newWitness", "succeededAtMs"])) {
    return err("entry must contain exactly the ADR-0079 singleton fields");
  }

  // `raw` is `JSON.parse` output — no getters, traps, or stateful accessors
  // (unlike the caller-owned objects the `snapshot*` helpers guard) — so the
  // exact-key gate above is the single shape fact; read the fields directly
  // instead of mirroring them into a shadow record.
  const { writtenAtMs, runId, nodeId, newWitness, succeededAtMs } = raw;
  if (!isFiniteNumber(writtenAtMs)) return err("writtenAtMs must be finite");
  if (!isBoundaryIdString(runId)) return err("runId does not match the framework ID boundary");
  if (!isBoundaryIdString(nodeId)) return err("nodeId does not match the framework ID boundary");
  if (!isPlainRecord(newWitness)) return err("newWitness must be an object");
  if (!hasExactKeys(newWitness, ["kind", "resource", "value"])) {
    return err("newWitness must contain exactly kind, resource, and value");
  }

  const { kind, resource, value } = newWitness;
  const parsedWitness = parseWitnessFields(
    { kind, resource, value },
    "newWitness",
    (parsedResource) =>
      parsedResource === expectedResource
        ? null
        : "digest/content resource disagreement",
  );
  if (!parsedWitness.ok) return parsedWitness;
  if (!isFiniteNumber(succeededAtMs)) return err("succeededAtMs must be finite");

  return ok({
    writtenAtMs: writtenAtMs,
    resource: parsedWitness.value.resource,
    runId: __brandRunId(runId),
    nodeId: __brandNodeId(nodeId),
    newWitness: __brandWitness({
      kind: parsedWitness.value.kind,
      resource: parsedWitness.value.resource,
      value: parsedWitness.value.value,
    }),
    succeededAtMs: succeededAtMs,
  });
};

const selectLatestWrite = (
  current: StoredFreshnessEntry | null,
  incoming: PreparedFreshnessWrite,
  writtenAtMs: number,
): StoredFreshnessEntry => {
  const currentIsExpired =
    current === null || writtenAtMs - current.writtenAtMs > TTL_MS;
  if (currentIsExpired) return { writtenAtMs, ...incoming };

  const incomingWins =
    incoming.succeededAtMs > current.succeededAtMs ||
    (incoming.succeededAtMs === current.succeededAtMs &&
      compareRedisMemberSerialization(
        serializeRedisFreshnessMember(incoming),
        serializeRedisFreshnessMember(current),
      ) > 0);
  const winner = incomingWins ? incoming : current;
  return {
    writtenAtMs,
    resource: winner.resource,
    runId: winner.runId,
    nodeId: winner.nodeId,
    newWitness: winner.newWitness,
    succeededAtMs: winner.succeededAtMs,
  };
};

const decideConflict = (
  entry: StoredFreshnessEntry,
  conditionedOnValue: string,
  sinceMs: number,
  nowMs: number,
): WriteEntry | null => {
  if (nowMs - entry.writtenAtMs > TTL_MS) return null;
  if (
    entry.succeededAtMs < sinceMs ||
    entry.newWitness.value === conditionedOnValue
  ) {
    return null;
  }
  return {
    runId: entry.runId,
    nodeId: entry.nodeId,
    newWitness: entry.newWitness,
    succeededAtMs: entry.succeededAtMs,
  };
};

const corruptRecordContext = (
  directory: string,
  recordPath: string,
  digest: string,
  reason: string,
): string =>
  `directory=${JSON.stringify(resolve(directory))} recordPath=${JSON.stringify(resolve(recordPath))} digest=${digest} reason=${reason}`;

const warnCorrupt = (
  directory: string,
  recordPath: string,
  digest: string,
  reason: string,
): Result<void, FrameworkError> => {
  const context = corruptRecordContext(directory, recordPath, digest, reason);
  try {
    fwLogger().warn(
      `[FileFreshnessIndex] Dropping corrupt freshness entry ${context}`,
    );
    return ok(undefined);
  } catch (error) {
    return err(
      cacheFailure(
        "freshness:findConflict",
        digest,
        new Error(
          `failed to warn about corrupt freshness entry ${context}: ${safeErrorMessage(error)}`,
        ),
      ),
    );
  }
};

/**
 * Freshness-index factory options (the port itself lives in
 * `types/freshness.ts`).
 *
 * Corrupt-singleton semantics (ADR-0079, caller observability): a stored
 * freshness entry that fails the strict codec is warned
 * (`[FileFreshnessIndex] Dropping corrupt freshness entry …`) and observed
 * as ABSENT by `findConflict` — Redis drop-with-warning parity, since the
 * event log, not this cache, is authoritative. `recordWrite` fails closed
 * on the same corruption class. Callers enforcing write-once/integrity
 * decisions off `findConflict` must treat an `ok(null)` as provisional
 * while corruption warnings are emitted; the corrupted file is never
 * silently replaced by a stale write.
 */
export interface FileFreshnessIndexOptions {
  /** Clock stamping writes and evaluating the lazy 24h TTL. */
  readonly now?: () => number;
  /** TEST-ONLY seam: threads deterministic hooks (e.g. a squatted temp
   * path) into `recordWrite`'s commit (`atomicWriteFile`) so a body-internal
   * commit failure is reproducible without FS races. Production callers
   * omit it (atomic.ts mints a unique temp path). */
  readonly atomicWriteFileHooks?: import("./atomic.js").AtomicWriteFileTestHooks;
}

const createFileFreshnessIndexUnchecked = (
  directory: string,
  opts: FileFreshnessIndexOptions = {},
): FreshnessIndex => {
  if (!isFileBackendPathString(directory)) {
    throw new TypeError(`directory must be a non-empty NUL-free string, got ${safeDiagnosticRender(directory)}`);
  }
  // This factory's options grammar = the shared closed clock shape (options.ts
  // — the journal twin's exact encoding) PLUS the test-only
  // `atomicWriteFileHooks` seam (recordWrite's commit), declared to the shared
  // parser below. The seam is test-only, typed at the interface, and consumed
  // by atomicWriteFile's own typed catch boundary.
  const now = parseFileFactoryClock(opts, ["atomicWriteFileHooks"]);

  /**
   * Clock read + representability gate, shared by `recordWrite` (write
   * stamp) and `findConflict` (lazy TTL evaluation). Both rejections are
   * code-constructed and deterministic — a throwing or non-finite injected
   * clock fails identically on every retry — so both are pinned
   * "permanent". The two checkpointer backends consolidated the same pair the
   * same way (file/checkpointer.ts `readClock`, checkpoint/checkpointer.ts
   * `readClock`); this is the third of the five file-backend clock sites.
   */
  const readClock = (
    operation: "freshness:recordWrite" | "freshness:findConflict",
    digest: string,
    clockFailedContext: "stamping the write" | "evaluating the freshness TTL",
  ): Result<number, FrameworkError> => {
    try {
      const nowMs = now();
      if (!isFiniteNumber(nowMs)) {
        // Deterministic: a non-finite injected clock fails identically on
        // every retry — pin "permanent" like the other code-constructed
        // invariant rejections.
        return err(
          cacheFailure(
            operation,
            digest,
            "clock must return a finite timestamp",
            undefined,
            "permanent",
          ),
        );
      }
      return ok(nowMs);
    } catch (error) {
      // Deterministic: a throwing injected clock fails identically on
      // every retry — pin "permanent" like the sibling clock sites
      // (journal appendEvent, checkpointer setMeta/load).
      return err(
        cacheFailure(
          operation,
          digest,
          `clock failed while ${clockFailedContext}: ${fileThrownValueMessage(error)}`,
          undefined,
          "permanent",
        ),
      );
    }
  };

  return {
    async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
      let digest: string | null = null;
      try {
        const prepared = prepareFreshnessWrite(event);
        if (!prepared.ok) {
          // Deterministic: the same invalid event fails identically on retry.
          return err(cacheFailure("freshness:recordWrite", null, prepared.error, undefined, "permanent"));
        }

        const resourceDigest = keyDigest(prepared.value.resource);
        digest = resourceDigest;
        mkdirSync(directory, { recursive: true });
        const recordPath = join(directory, `${resourceDigest}.json`);
        const lockPath = join(directory, `${resourceDigest}.lock`);

        return await withFileLock(lockPath, () => {
          const clocked = readClock("freshness:recordWrite", resourceDigest, "stamping the write");
          if (!clocked.ok) return clocked;
          const nowMs = clocked.value;

          let current: StoredFreshnessEntry | null = null;
          try {
            // Follows symlinks deliberately — module header, "Symlink policy".
            const text = readFileSync(recordPath, "utf-8");
            const parsed = parseStoredFreshnessEntry(text, prepared.value.resource);
            if (!parsed.ok) {
              // Deterministic fail-closed (ADR-0079): the corrupted bytes
              // reproduce the same rejection on every retry — retrying can
              // neither clear them nor make the write safe.
              return err(
                cacheFailure(
                  "freshness:recordWrite",
                  resourceDigest,
                  `stored freshness record is corrupt ${corruptRecordContext(directory, recordPath, resourceDigest, parsed.error)}`,
                  undefined,
                  "permanent",
                ),
              );
            }
            current = parsed.value;
          } catch (error) {
            const codeProbe = probeErrorCode(error);
            if (codeProbe.kind !== "code" || codeProbe.code !== "ENOENT") {
              return err(cacheFailure("freshness:recordWrite", resourceDigest, error, codeProbe));
            }
          }

          const next = selectLatestWrite(current, prepared.value, nowMs);
          atomicWriteFile(recordPath, serializeStoredFreshnessEntry(next), opts.atomicWriteFileHooks);
          return ok(undefined);
        });
      } catch (error) {
        // Public-surface ride-through + lock-protocol re-tag (ADR-0080 —
        // `surfaceFailure`, mirroring the journal's `appendEvent` re-tag):
        // lock-protocol operations name THIS port call, other typed
        // failures keep their own operation, untyped throws are wrapped.
        return err(surfaceFailure("freshness:recordWrite", digest, error));
      }
    },

    async findConflict(
      conditionedOn: Witness,
      sinceMs: number,
    ): Promise<Result<WriteEntry | null, FrameworkError>> {
      let digest: string | null = null;
      try {
        const parsedWitness = parseConditionedOn(conditionedOn);
        if (!parsedWitness.ok) {
          // Deterministic: the same conditioned-on value reproduces the
          // identical rejection on every retry — pin "permanent" like the
          // recordWrite twin's code-constructed rejections.
          return err(cacheFailure("freshness:findConflict", null, parsedWitness.error, undefined, "permanent"));
        }
        if (!isFiniteNumber(sinceMs)) {
          // Deterministic: a non-finite sinceMs fails identically on every
          // retry — pin "permanent" like the recordWrite twin.
          return err(cacheFailure("freshness:findConflict", null, "sinceMs must be finite", undefined, "permanent"));
        }

        digest = keyDigest(parsedWitness.value.resource);
        const recordPath = join(directory, `${digest}.json`);
        let text: string;
        try {
          // Follows symlinks deliberately — module header, "Symlink policy".
          text = readFileSync(recordPath, "utf-8");
        } catch (error) {
          // Absence is ENOENT ONLY — a missing singleton means "no recent
          // write", every other read failure fails closed (parity with
          // recordWrite's non-ENOENT handling).
          if (isMissingPathError(error)) return ok(null);
          const codeProbe = probeErrorCode(error);
          return err(cacheFailure("freshness:findConflict", digest, error, codeProbe));
        }

        const parsed = parseStoredFreshnessEntry(text, parsedWitness.value.resource);
        if (!parsed.ok) {
          const warned = warnCorrupt(directory, recordPath, digest, parsed.error);
          if (!warned.ok) return err(warned.error);
          return ok(null);
        }

        const clocked = readClock("freshness:findConflict", digest, "evaluating the freshness TTL");
        if (!clocked.ok) return clocked;
        const nowMs = clocked.value;
        return ok(
          decideConflict(
            parsed.value,
            parsedWitness.value.value,
            sinceMs,
            nowMs,
          ),
        );
      } catch (error) {
        // Public-surface ride-through + lock-protocol re-tag — the
        // recordWrite twin (ADR-0080, `surfaceFailure`).
        return err(surfaceFailure("freshness:findConflict", digest, error));
      }
    },
  };
};

/** Typed factory shell: invalid configuration cannot leak a runtime throw. */
export const createFileFreshnessIndex = (
  directory: string,
  opts: FileFreshnessIndexOptions = {},
): FreshnessIndex => {
  try {
    return createFileFreshnessIndexUnchecked(directory, opts);
  } catch (error) {
    throw fileOperationError(
      "createFileFreshnessIndex",
      "factory configuration",
      error,
    );
  }
};

// Exported only for equal-score parity tests; omitted from the file barrel.
export {
  serializeRedisFreshnessMember as __testSerializeRedisFreshnessMember,
  compareRedisMemberSerialization as __testCompareRedisMemberSerialization,
};
