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
import type { Witness, WitnessKind, WriteEntry } from "../types/freshness.js";
import {
  FRESHNESS_TTL_SECONDS,
  __brandWitness,
  compareFreshnessMemberKeys,
  freshnessMemberKey,
  isWitnessKind,
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
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
}

export interface StoredFreshnessEntry extends PreparedFreshnessWrite {
  readonly writtenAtMs: number;
}

export type ConditionedOnSnapshot = Readonly<{
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
export const serializeRedisFreshnessMember = (entry: PreparedFreshnessWrite): string =>
  freshnessMemberKey(
    entry.runId,
    entry.nodeId,
    entry.newWitness.kind,
    entry.newWitness.value,
  );

export const serializeStoredFreshnessEntry = (entry: StoredFreshnessEntry): string =>
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

export const selectLatestWrite = (
  current: StoredFreshnessEntry | null,
  incoming: PreparedFreshnessWrite,
  writtenAtMs: number,
): StoredFreshnessEntry => {
  const currentIsExpired = current === null || isExpired(current.writtenAtMs, writtenAtMs);
  if (currentIsExpired) return { writtenAtMs, ...incoming };

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
    newWitness: winner.newWitness,
    succeededAtMs: winner.succeededAtMs,
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
    newWitness: entry.newWitness,
    succeededAtMs: entry.succeededAtMs,
  };
};
