// The PURE decision core of the durable filesystem FreshnessIndex — the
// ADR-0079 rules that decide what a write means, with no filesystem, no lock
// and no clock of its own.
//
// `freshness-index.ts` is the imperative shell around this: it resolves the
// digest path, takes the per-digest lock, reads and atomically replaces bytes,
// and maps failures onto the public port surface. The split mirrors the
// `checkpointer.ts` → `checkpointer-codec.ts` template already used by this
// subsystem, and gives the highest-risk parity logic in the file backend
// (score monotonicity, the Redis reverse-binary equal-score tie order, the lazy
// 24h TTL, and the strict singleton codec) a test surface that needs no temp
// directory.
//
// Imports no Node built-ins (FR-041).

import { isBoundaryIdString, isPlainRecord } from "./layout.js";
import type {
  FreshnessWriteIdentity,
  Witness,
  WitnessKind,
  WriteEntry,
} from "../types/freshness.js";
import {
  FRESHNESS_TTL_SECONDS,
  __brandWitness,
  compareFreshnessMemberKeys,
  freshnessMemberKey,
  freshnessWriteKey,
  isWitnessKind,
  parseFreshnessMemberKey,
  __brandFreshnessExecutionEpoch,
} from "../types/freshness.js";
import { __brandNodeId, __brandRunId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import { safeErrorMessage } from "../types/safe-error.js";

export const TTL_MS = FRESHNESS_TTL_SECONDS * 1000;

/**
 * THE expiry rule for freshness entries — "stale when age exceeds the
 * 24-hour TTL" (FR-032) — in ONE place (round-23 cs-5). Both
 * `selectLatestWrite` (lazy supersede on record) and `decideConflict`
 * (lazy supersede on conflict check) previously re-encoded
 * `age > TTL_MS`; any future change to the rule now has a single home.
 */
export const isExpired = (writtenAtMs: number, nowMs: number): boolean =>
  nowMs - writtenAtMs > TTL_MS;

export interface PreparedFreshnessWrite {
  readonly resource: string;
  readonly runId: WriteEntry["runId"];
  readonly nodeId: WriteEntry["nodeId"];
  readonly executionEpoch: WriteEntry["executionEpoch"];
  readonly newWitness: Witness;
  readonly writeKey: string;
  readonly succeededAtMs: number;
}

export interface StoredFreshnessEntry extends PreparedFreshnessWrite {
  readonly writtenAtMs: number;
  readonly acknowledgedWriteKeys: readonly string[];
}

export type ConditionedOnSnapshot = Readonly<{
  kind: WitnessKind;
  resource: string;
  value: string;
}>;

type RawWriteIdentitySnapshot = Readonly<{
  runId: unknown;
  nodeId: unknown;
  executionEpoch: unknown;
  newWitness: unknown;
}>;

type RawWriteSnapshot = RawWriteIdentitySnapshot & Readonly<{
  type: unknown;
  succeededAtMs: unknown;
}>;

type RawWitnessSnapshot = Readonly<{
  kind: unknown;
  resource: unknown;
  value: unknown;
}>;

export const isFiniteNumber = (value: unknown): value is number =>
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
export const parseWitnessFields = (
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

/** Snapshot each accessor-backed logical-identity field once. */
const snapshotWriteIdentity = (
  identity: Record<string, unknown>,
): RawWriteIdentitySnapshot => ({
  runId: identity.runId,
  nodeId: identity.nodeId,
  executionEpoch: identity.executionEpoch,
  newWitness: identity.newWitness,
});

/** Snapshot each accessor-backed event field once before validating any value. */
const snapshotWriteEvent = (event: Record<string, unknown>): RawWriteSnapshot => ({
  type: event.type,
  ...snapshotWriteIdentity(event),
  succeededAtMs: event.succeededAtMs,
});

/** Snapshot each accessor-backed witness field once before validation. */
const snapshotWitness = (value: Record<string, unknown>): RawWitnessSnapshot => ({
  kind: value.kind,
  resource: value.resource,
  value: value.value,
});

/** Boundary/snapshotting parser: untrusted getters and proxy traps run while snapshotting; post-snapshot validation and construction are deterministic. */
export const prepareFreshnessWrite = (
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
  if (!Number.isSafeInteger(rawEvent.executionEpoch) || (rawEvent.executionEpoch as number) < 0) {
    return err("executionEpoch must be a non-negative safe integer");
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

  const identity: FreshnessWriteIdentity = {
    runId: __brandRunId(rawEvent.runId),
    nodeId: __brandNodeId(rawEvent.nodeId),
    executionEpoch: __brandFreshnessExecutionEpoch(rawEvent.executionEpoch as number),
    newWitness: __brandWitness({
      kind: parsedWitness.value.kind,
      resource: parsedWitness.value.resource,
      value: parsedWitness.value.value,
    }),
  };
  return ok({
    resource: parsedWitness.value.resource,
    ...identity,
    writeKey: freshnessWriteKey(identity),
    succeededAtMs: rawEvent.succeededAtMs,
  });
};

/** Parse the exact logical-write identity used by the acknowledgement query. */
export const prepareFreshnessWriteIdentity = (
  identity: unknown,
): Result<FreshnessWriteIdentity & { readonly writeKey: string }, string> => {
  if (!isPlainRecord(identity)) return err("write identity must be an object");
  const raw = snapshotWriteIdentity(identity);
  if (!isBoundaryIdString(raw.runId)) return err("runId does not match the framework ID boundary");
  if (!isBoundaryIdString(raw.nodeId)) return err("nodeId does not match the framework ID boundary");
  if (!Number.isSafeInteger(raw.executionEpoch) || (raw.executionEpoch as number) < 0) {
    return err("executionEpoch must be a non-negative safe integer");
  }
  if (!isPlainRecord(raw.newWitness)) return err("newWitness must be an object");
  const parsedWitness = parseWitnessFields(snapshotWitness(raw.newWitness), "newWitness");
  if (!parsedWitness.ok) return parsedWitness;
  const parsed: FreshnessWriteIdentity = {
    runId: __brandRunId(raw.runId),
    nodeId: __brandNodeId(raw.nodeId),
    executionEpoch: __brandFreshnessExecutionEpoch(raw.executionEpoch as number),
    newWitness: __brandWitness(parsedWitness.value),
  };
  return ok({ ...parsed, writeKey: freshnessWriteKey(parsed) });
};

/** Boundary/snapshotting parser: untrusted getters and proxy traps run while snapshotting; post-snapshot validation and construction are deterministic. */
export const parseConditionedOn = (value: unknown): Result<ConditionedOnSnapshot, string> => {
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

/** Exact Redis member bytes used solely for equal-score winner parity —
 * delegated to the port-owned grammar (`freshnessMemberKey`) so the file
 * backend can never drift from the Redis adapter's member tuple (ADR-0079). */
export const serializeRedisFreshnessMember = (entry: FreshnessWriteIdentity): string =>
  freshnessMemberKey(
    entry.runId,
    entry.nodeId,
    entry.executionEpoch,
    entry.newWitness.kind,
    entry.newWitness.value,
  );

export const serializeStoredFreshnessEntry = (entry: StoredFreshnessEntry): string =>
  JSON.stringify({
    writtenAtMs: entry.writtenAtMs,
    runId: entry.runId,
    nodeId: entry.nodeId,
    executionEpoch: entry.executionEpoch,
    newWitness: {
      kind: entry.newWitness.kind,
      resource: entry.newWitness.resource,
      value: entry.newWitness.value,
    },
    succeededAtMs: entry.succeededAtMs,
    acknowledgedWriteKeys: entry.acknowledgedWriteKeys,
  });

/** Strict pure parser for the one ADR-0079 persisted singleton shape. */
export const parseStoredFreshnessEntry = (
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
  if (!hasExactKeys(raw, ["writtenAtMs", "runId", "nodeId", "executionEpoch", "newWitness", "succeededAtMs", "acknowledgedWriteKeys"])) {
    return err("entry must contain exactly the ADR-0079 singleton fields");
  }

  // `raw` is `JSON.parse` output — no getters, traps, or stateful accessors
  // (unlike the caller-owned objects the `snapshot*` helpers guard) — so the
  // exact-key gate above is the single shape fact; read the fields directly
  // instead of mirroring them into a shadow record.
  const { writtenAtMs, runId, nodeId, executionEpoch, newWitness, succeededAtMs, acknowledgedWriteKeys } = raw;
  if (!isFiniteNumber(writtenAtMs)) return err("writtenAtMs must be finite");
  if (!isBoundaryIdString(runId)) return err("runId does not match the framework ID boundary");
  if (!isBoundaryIdString(nodeId)) return err("nodeId does not match the framework ID boundary");
  if (!Number.isSafeInteger(executionEpoch) || (executionEpoch as number) < 0) {
    return err("executionEpoch must be a non-negative safe integer");
  }
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
  if (
    !Array.isArray(acknowledgedWriteKeys) ||
    acknowledgedWriteKeys.length === 0 ||
    acknowledgedWriteKeys.some(
      (key) => typeof key !== "string" || parseFreshnessMemberKey(key) === null,
    ) ||
    new Set(acknowledgedWriteKeys).size !== acknowledgedWriteKeys.length
  ) {
    return err("acknowledgedWriteKeys must be a non-empty unique array of freshness member keys");
  }

  const identity: FreshnessWriteIdentity = {
    runId: __brandRunId(runId),
    nodeId: __brandNodeId(nodeId),
    executionEpoch: __brandFreshnessExecutionEpoch(executionEpoch as number),
    newWitness: __brandWitness({
      kind: parsedWitness.value.kind,
      resource: parsedWitness.value.resource,
      value: parsedWitness.value.value,
    }),
  };
  const writeKey = freshnessWriteKey(identity);
  if (!acknowledgedWriteKeys.includes(writeKey)) {
    return err("acknowledgedWriteKeys must contain the latest write identity");
  }

  return ok({
    writtenAtMs: writtenAtMs,
    resource: parsedWitness.value.resource,
    ...identity,
    writeKey,
    succeededAtMs: succeededAtMs,
    acknowledgedWriteKeys,
  });
};

export const selectLatestWrite = (
  current: StoredFreshnessEntry | null,
  incoming: PreparedFreshnessWrite,
  writtenAtMs: number,
): StoredFreshnessEntry => {
  const currentIsExpired = current === null || isExpired(current.writtenAtMs, writtenAtMs);
  if (currentIsExpired) {
    return {
      writtenAtMs,
      ...incoming,
      acknowledgedWriteKeys: [incoming.writeKey],
    };
  }

  const incomingWins =
    incoming.succeededAtMs > current.succeededAtMs ||
    (incoming.succeededAtMs === current.succeededAtMs &&
      compareFreshnessMemberKeys(
        serializeRedisFreshnessMember(incoming),
        serializeRedisFreshnessMember(current),
      ) > 0);
  const winner = incomingWins ? incoming : current;
  return {
    writtenAtMs,
    resource: winner.resource,
    runId: winner.runId,
    nodeId: winner.nodeId,
    executionEpoch: winner.executionEpoch,
    newWitness: winner.newWitness,
    writeKey: winner.writeKey,
    succeededAtMs: winner.succeededAtMs,
    acknowledgedWriteKeys: current.acknowledgedWriteKeys.includes(incoming.writeKey)
      ? current.acknowledgedWriteKeys
      : [...current.acknowledgedWriteKeys, incoming.writeKey],
  };
};

export const decideConflict = (
  entry: StoredFreshnessEntry,
  conditionedOnValue: string,
  sinceMs: number,
  nowMs: number,
): WriteEntry | null => {
  if (isExpired(entry.writtenAtMs, nowMs)) return null;
  if (
    entry.succeededAtMs < sinceMs ||
    entry.newWitness.value === conditionedOnValue
  ) {
    return null;
  }
  return {
    runId: entry.runId,
    nodeId: entry.nodeId,
    executionEpoch: entry.executionEpoch,
    newWitness: entry.newWitness,
    succeededAtMs: entry.succeededAtMs,
  };
};
