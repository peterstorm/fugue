// Durable filesystem FreshnessIndex (FR-030..FR-032, AD-5/AD-6).
//
// AD-5 stores exactly one bounded latest-write singleton per resource:
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

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, withFileLock } from "./atomic.js";
import { TTL_SECONDS, isBoundaryId, keyDigest } from "./layout.js";
import { fwLogger } from "../logger.js";
import type { WriteAttemptedEvent } from "../types/events.js";
import type {
  FreshnessIndex,
  Witness,
  WitnessKind,
  WriteEntry,
} from "../types/freshness.js";
import { __brandWitness } from "../types/freshness.js";
import type { FrameworkError } from "../types/errors.js";
import { __brandNodeId, __brandRunId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import {
  probeErrorCode,
  safeDiagnosticRender,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
  type ErrorCodeProbe,
} from "../types/safe-error.js";
import {
  fileCacheError,
  fileOperationError,
  type FileOperation,
} from "./boundary-error.js";

const TTL_MS = TTL_SECONDS * 1000;

const WITNESS_KIND_ALLOW_LIST = {
  version: true,
  etag: true,
  timestamp: true,
  lsn: true,
  "idempotency-key": true,
  custom: true,
} as const satisfies Readonly<Record<WitnessKind, true>>;

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

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBoundaryIdString = (value: unknown): value is string =>
  isBoundaryId(value);

const isWitnessKind = (value: unknown): value is WitnessKind =>
  typeof value === "string" && Object.hasOwn(WITNESS_KIND_ALLOW_LIST, value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

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
  if (!isWitnessKind(rawWitness.kind)) {
    return err("newWitness.kind is not a WitnessKind");
  }
  if (!isNonEmptyString(rawWitness.resource)) {
    return err("newWitness.resource must be non-empty");
  }
  if (!isNonEmptyString(rawWitness.value)) {
    return err("newWitness.value must be non-empty");
  }
  if (!isFiniteNumber(rawEvent.succeededAtMs)) {
    return err("succeededAtMs must be finite");
  }

  return ok({
    resource: rawWitness.resource,
    runId: __brandRunId(rawEvent.runId),
    nodeId: __brandNodeId(rawEvent.nodeId),
    newWitness: __brandWitness({
      kind: rawWitness.kind,
      resource: rawWitness.resource,
      value: rawWitness.value,
    }),
    succeededAtMs: rawEvent.succeededAtMs,
  });
};

/** Boundary/snapshotting parser: untrusted getters and proxy traps run while snapshotting; post-snapshot validation and construction are deterministic. */
const parseConditionedOn = (value: unknown): Result<ConditionedOnSnapshot, string> => {
  if (!isPlainRecord(value)) return err("conditionedOn must be an object");
  const rawWitness = snapshotWitness(value);
  if (!isWitnessKind(rawWitness.kind)) {
    return err("conditionedOn.kind is not a WitnessKind");
  }
  if (!isNonEmptyString(rawWitness.resource)) {
    return err("conditionedOn.resource must be non-empty");
  }
  if (!isNonEmptyString(rawWitness.value)) {
    return err("conditionedOn.value must be non-empty");
  }
  return ok({
    kind: rawWitness.kind,
    resource: rawWitness.resource,
    value: rawWitness.value,
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

/** Strict pure parser for the one AD-5 persisted singleton shape. */
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
    return err("entry must contain exactly the AD-5 singleton fields");
  }

  const rawEntry = {
    writtenAtMs: raw.writtenAtMs,
    runId: raw.runId,
    nodeId: raw.nodeId,
    newWitness: raw.newWitness,
    succeededAtMs: raw.succeededAtMs,
  } as const;
  if (!isFiniteNumber(rawEntry.writtenAtMs)) return err("writtenAtMs must be finite");
  if (!isBoundaryIdString(rawEntry.runId)) return err("runId does not match the framework ID boundary");
  if (!isBoundaryIdString(rawEntry.nodeId)) return err("nodeId does not match the framework ID boundary");
  if (!isPlainRecord(rawEntry.newWitness)) return err("newWitness must be an object");
  if (!hasExactKeys(rawEntry.newWitness, ["kind", "resource", "value"])) {
    return err("newWitness must contain exactly kind, resource, and value");
  }

  const rawWitness = {
    kind: rawEntry.newWitness.kind,
    resource: rawEntry.newWitness.resource,
    value: rawEntry.newWitness.value,
  } as const;
  if (!isWitnessKind(rawWitness.kind)) return err("newWitness.kind is not a WitnessKind");
  if (!isNonEmptyString(rawWitness.resource)) return err("newWitness.resource must be non-empty");
  if (rawWitness.resource !== expectedResource) {
    return err("digest/content resource disagreement");
  }
  if (!isNonEmptyString(rawWitness.value)) return err("newWitness.value must be non-empty");
  if (!isFiniteNumber(rawEntry.succeededAtMs)) return err("succeededAtMs must be finite");

  return ok({
    writtenAtMs: rawEntry.writtenAtMs,
    resource: rawWitness.resource,
    runId: __brandRunId(rawEntry.runId),
    nodeId: __brandNodeId(rawEntry.nodeId),
    newWitness: __brandWitness({
      kind: rawWitness.kind,
      resource: rawWitness.resource,
      value: rawWitness.value,
    }),
    succeededAtMs: rawEntry.succeededAtMs,
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
}

const createFileFreshnessIndexUnchecked = (
  directory: string,
  opts: FileFreshnessIndexOptions = {},
): FreshnessIndex => {
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\u0000")) {
    throw `directory must be a non-empty NUL-free string, got ${safeDiagnosticRender(directory)}`;
  }
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
    throw `options must be a plain object, got ${safeDiagnosticRender(opts)}`;
  }
  const prototype = Object.getPrototypeOf(opts);
  if (prototype !== Object.prototype && prototype !== null) {
    throw "options must be a plain object";
  }
  const keys = Reflect.ownKeys(opts);
  const unsupported = keys.find((key) => key !== "now");
  if (unsupported !== undefined) {
    throw `unsupported option ${safeDiagnosticRender(unsupported)}; supported option is now`;
  }
  const configuredNow = keys.includes("now")
    ? (opts as Record<string, unknown>).now
    : undefined;
  if (configuredNow !== undefined && typeof configuredNow !== "function") {
    throw `options.now must be a function, got ${safeDiagnosticRender(configuredNow)}`;
  }
  const now = configuredNow === undefined ? Date.now : configuredNow as () => number;

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
          const nowMs = now();
          if (!isFiniteNumber(nowMs)) {
            return err(
              cacheFailure(
                "freshness:recordWrite",
                resourceDigest,
                "clock must return a finite timestamp",
              ),
            );
          }

          let current: StoredFreshnessEntry | null = null;
          try {
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
          atomicWriteFile(recordPath, serializeStoredFreshnessEntry(next));
          return ok(undefined);
        });
      } catch (error) {
        return err(cacheFailure("freshness:recordWrite", digest, error));
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
          return err(cacheFailure("freshness:findConflict", null, parsedWitness.error));
        }
        if (!isFiniteNumber(sinceMs)) {
          return err(cacheFailure("freshness:findConflict", null, "sinceMs must be finite"));
        }

        digest = keyDigest(parsedWitness.value.resource);
        const recordPath = join(directory, `${digest}.json`);
        let text: string;
        try {
          text = readFileSync(recordPath, "utf-8");
        } catch (error) {
          const codeProbe = probeErrorCode(error);
          if (codeProbe.kind === "code" && codeProbe.code === "ENOENT") return ok(null);
          return err(cacheFailure("freshness:findConflict", digest, error, codeProbe));
        }

        const parsed = parseStoredFreshnessEntry(text, parsedWitness.value.resource);
        if (!parsed.ok) {
          const warned = warnCorrupt(directory, recordPath, digest, parsed.error);
          if (!warned.ok) return err(warned.error);
          return ok(null);
        }

        const nowMs = now();
        if (!isFiniteNumber(nowMs)) {
          return err(
            cacheFailure(
              "freshness:findConflict",
              digest,
              "clock must return a finite timestamp",
            ),
          );
        }
        return ok(
          decideConflict(
            parsed.value,
            parsedWitness.value.value,
            sinceMs,
            nowMs,
          ),
        );
      } catch (error) {
        return err(cacheFailure("freshness:findConflict", digest, error));
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
