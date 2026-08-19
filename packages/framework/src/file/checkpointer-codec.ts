// Pure meta/node/options codecs for the file `Checkpointer` backend
// (FR-016/FR-020..FR-029, ADR-0075/ADR-0076/ADR-0080), extracted from
// `checkpointer.ts` (pure core split from the I/O shell).
//
// This module is the PURE half of the adapter — the functional core:
//
//   - stored-schema serialization and strict parsing for the per-run
//     `meta.json` and `nodes/<digest>.json` projections (parse, don't
//     validate; unknown additive meta fields tolerated, unknown
//     node-envelope fields rejected);
//   - the canonical serializer-ready output grammar
//     (`materializeCanonicalOutput`) and the read-side verdict for one node
//     file;
//   - boundary snapshots and parsers for the `saveNode` options object
//     (snapshot-once semantics, closed own-key grammar) and the `load`
//     options object;
//   - the `checkpoint-write-failed` construction policy — delegated to the
//     canonical builder in `types/error-factories.ts` (re-exported below as
//     `writeFailed` for the shell and the tests).
//
// It performs NO I/O and NO clock reads: byte strings and frozen snapshots
// go in, `Result`s and verdicts come out, and every expected rejection is a
// typed `Result` or a documented throw the imperative shell converts at the
// port boundary (ADR-0080/FR-040). The module has NO Node built-in imports at
// all (INV-1): the digest comes from `layout.ts`, which owns the
// `node:crypto` import.
//
// The filesystem half lives in `checkpointer.ts` (`createFileCheckpointer` —
// the thin shell: run/nodes directory resolution, atomic writes, typed error
// mapping) and in `verified-directory.ts` (the lstat/realpath containment
// policy). Moving the codecs here keeps every pure invariant directly
// testable without a temp directory.

import { isBoundaryId, isBoundaryIdString, isPlainRecord, keyDigest } from "./layout.js";
import {
  parseNodeStateRecord,
  parseRunMetaRecord,
  type CheckpointerLoadOpts,
  type NodeState,
  type RunMeta,
  type SaveNodeOpts,
} from "../checkpoint/checkpointer.js";
// Re-exported for back-compat: `file-checkpointer-codec.test.ts` imports the
// canonical-ISO grammar from this codec; the definition now lives in the
// checkpoint core (round-23 atl-1 — one encoding with the Redis twin).
export { parseCanonicalIsoDate } from "../checkpoint/checkpointer.js";
import {
  isNonNegativeSafeInteger,
  parseCompositeNodeKey,
} from "../checkpoint/composite-node-key.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import {
  deserializeValue,
  validateSerializedValueGrammar,
  POLLUTION_KEYS,
  RESERVED_TAG_KEYS,
  serializedPath as outputPath,
  MAX_SAFE_RECORD_DEPTH,
} from "../state-machine/serialize.js";
import { ID_PATTERN } from "../types/ids.js";
import { isRepresentableTimestampMs } from "../types/clock.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";

// ---------------------------------------------------------------------------
// Error construction (ADR-0080)
// ---------------------------------------------------------------------------

// The `checkpoint-write-failed` construction policy (truthful brands, additive
// raw-value diagnostics, the meta-record case) has ONE encoding — the canonical
// `buildCheckpointWriteFailed` builder in `types/error-factories.ts`, shared
// with the public `frameworkError.checkpointWriteFailed` factory and the
// in-memory adapter (consolidation of the policy this module
// used to mirror locally; output for every input is byte-identical to the
// former local `writeFailed` — pinned by the per-backend hostile corpora).
// Re-exported under the historical name: the file-checkpointer shell and the
// tests import it from here. `META_RECORD_NODE_ID` is likewise re-exported
// from its canonical definition so the `file.ts` barrel and test imports keep
// their paths.
export {
  META_RECORD_NODE_ID,
  buildCheckpointWriteFailed as writeFailed,
} from "../types/error-factories.js";

const render = safeDiagnosticRender;
const messageOf = safeErrorMessage;

// ---------------------------------------------------------------------------
// Stored schemas (functional core: pure serialize / pure parse)
// ---------------------------------------------------------------------------

/** On-disk shape of `<runId>/meta.json`. It shares the Redis adapter's
 * logical metadata fields and load-order semantics; the file backend alone
 * owns this persisted-byte schema and does not claim wire-format or
 * storage-engine interchangeability with Redis. Every KNOWN field is parsed
 * strictly (including canonical ISO timestamps), while unknown additive
 * fields are intentionally ignored for forward-compatible metadata evolution.
 * This is not a closed top-level schema. */
interface StoredMeta {
  readonly dagId: string;
  readonly startedAt: string;
  readonly nodeCount: number;
  readonly createdAt: string;
  readonly subject?: string;
  readonly dagFingerprint?: string;
  readonly frameworkVersion?: string;
}

/** On-disk shape of `<runId>/nodes/<digest>.json`. `nodeKey` is the stored
 * address (canonical nodeId or composite key) and MUST digest to the
 * filename; `nodeId` names the real node inside it (ADR-0075). */
interface StoredNode {
  readonly nodeKey: string;
  readonly nodeId: string;
  readonly output: unknown;
  readonly completedAt: string;
}

/** Immutable top-level snapshots of caller-owned write inputs. Accessors are
 * invoked only while constructing these values; every subsequent validation,
 * key derivation, and serialization step consumes the snapshots. */
export interface RawMetaSnapshot {
  readonly plainRecord: boolean;
  readonly dagId: unknown;
  readonly startedAt: unknown;
  readonly nodeCount: unknown;
  readonly subject: unknown;
  readonly dagFingerprint: unknown;
  readonly frameworkVersion: unknown;
}

export interface RawNodeSnapshot {
  readonly plainRecord: boolean;
  readonly nodeId: unknown;
  readonly output: unknown;
  readonly completedAt: unknown;
}

export interface RawSaveNodeOptsSnapshot {
  readonly plainObject: boolean;
  readonly ownKeys: readonly PropertyKey[];
  readonly namespace: unknown;
  readonly index: unknown;
  readonly attempt: unknown;
}

/** Runtime configuration objects must be records, not merely object-like
 * values. Class instances carry behavior/prototype state outside the supported
 * option grammar and are therefore rejected at the boundary. Null-prototype
 * records remain valid plain objects. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

/** Snapshot every public `RunMeta` field with exactly one property read.
 * The frozen value is the sole input to metadata validation and serialization,
 * so stateful accessors cannot yield one value to validation and another to
 * the committed bytes. */
export const snapshotMeta = (meta: unknown): RawMetaSnapshot => {
  const source = meta as Record<string, unknown>;
  // Exactly one Get per public RunMeta field, before field or record-shape
  // validation. The frozen data object severs all later control flow from
  // stateful accessors on the caller's object.
  const dagId = source.dagId;
  const startedAt = source.startedAt;
  const nodeCount = source.nodeCount;
  const subject = source.subject;
  const dagFingerprint = source.dagFingerprint;
  const frameworkVersion = source.frameworkVersion;
  return Object.freeze({
    plainRecord: isPlainRecord(meta),
    dagId,
    startedAt,
    nodeCount,
    subject,
    dagFingerprint,
    frameworkVersion,
  });
};

/**
 * Serialize a snapshotted run metadata value for disk. Throws when the
 * captured schema cannot be represented (invalid `startedAt`, non-integer
 * `nodeCount`, and so on); `setMeta` converts that expected rejection to
 * `checkpoint-write-failed`.
 *
 * `createdAt` is stamped from the injected clock, not caller state, and
 * `frameworkVersion` defaults to `FRAMEWORK_VERSION` while preserving an
 * explicit captured value for stale-version compatibility tests.
 */
export const serializeMeta = (meta: RawMetaSnapshot, createdAtMs: number): string => {
  const { plainRecord, dagId, startedAt, nodeCount, subject, dagFingerprint, frameworkVersion } = meta;
  if (!plainRecord) {
    throw new Error("meta must be an object");
  }
  if (typeof dagId !== "string") {
    throw new Error(`meta.dagId must be a string, got ${render(dagId)}`);
  }
  if (!isValidDate(startedAt)) {
    throw new Error(`meta.startedAt must be a valid Date, got ${render(startedAt)}`);
  }
  if (!isNonNegativeSafeInteger(nodeCount)) {
    throw new Error(
      `meta.nodeCount must be a non-negative safe integer, got ${render(nodeCount)}`,
    );
  }
  if (subject !== undefined && typeof subject !== "string") {
    throw new Error(`meta.subject must be a string when present, got ${render(subject)}`);
  }
  if (dagFingerprint !== undefined && typeof dagFingerprint !== "string") {
    throw new Error(
      `meta.dagFingerprint must be a string when present, got ${render(dagFingerprint)}`,
    );
  }
  if (frameworkVersion !== undefined && typeof frameworkVersion !== "string") {
    throw new Error(
      `meta.frameworkVersion must be a string when present, got ${render(frameworkVersion)}`,
    );
  }
  const createdAt = new Date(createdAtMs);
  if (!isRepresentableTimestampMs(createdAtMs)) {
    throw new Error(`clock produced a non-representable timestamp: ${render(createdAtMs)}`);
  }
  const stored: StoredMeta = Object.freeze({
    dagId,
    startedAt: Date.prototype.toISOString.call(startedAt),
    nodeCount,
    createdAt: createdAt.toISOString(),
    ...(subject !== undefined ? { subject } : {}),
    ...(dagFingerprint !== undefined ? { dagFingerprint } : {}),
    frameworkVersion: frameworkVersion ?? FRAMEWORK_VERSION,
  });
  return JSON.stringify(stored);
};

/**
 * Strict parse of `meta.json` (parse, don't validate): every field is checked
 * before it becomes a `RunMeta`, so a half-readable meta can never be served
 * as a usable checkpoint. Returns `Result` because on-disk data may be corrupt
 * through no fault of the caller; the caller maps the message onto
 * `checkpoint-corrupt`.
 *
 * Known fields are exact and strict; unknown additive top-level fields are
 * deliberately permitted and ignored so newer writers may extend metadata
 * without making older readers reject otherwise usable checkpoints.
 * `frameworkVersion` is deliberately OPTIONAL here: a meta written before the
 * field existed must reach the ADR-0017 check and be reported as a VERSION
 * MISMATCH (`actual: undefined`), not as corruption.
 */
export const parseStoredMeta = (
  text: string,
): Result<{ readonly meta: RunMeta; readonly createdAt: Date }, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err(`not valid JSON: ${messageOf(error)}`);
  }
  if (!isPlainRecord(raw)) {
    return err(`meta must be a JSON object, got ${render(raw)}`);
  }
  // Field-level grammar delegated to the checkpoint core's ONE encoding
  // (round-23 atl-1): type gates, canonical ISO dates, safe-integer
  // nodeCount, optional-field gates — byte-identical messages, now shared
  // with the Redis twin so the two backends cannot drift again. Unknown
  // additive top-level fields remain ignored by the shared validator (newer
  // writers stay readable).
  const parsed = parseRunMetaRecord(raw);
  if (!parsed.ok) return err(parsed.error);
  return ok(parsed.value);
};

type CanonicalSerializedValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalSerializedValue[]
  | { readonly [key: string]: CanonicalSerializedValue };

const canonicalRecord = (
  entries: readonly (readonly [string, CanonicalSerializedValue])[],
): { readonly [key: string]: CanonicalSerializedValue } => {
  const record = Object.create(null) as Record<string, CanonicalSerializedValue>;
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(record);
};

/**
 * Materialize one immutable, serializer-ready snapshot of a node output.
 * Every plain-object/array property is read exactly once from its OWN DATA
 * descriptor; property getters are never invoked. Consequently a Proxy whose
 * descriptor and `get` traps disagree is committed according to the captured
 * descriptor value (or rejected if its descriptor view is malformed), and no
 * later validation/serialization step can re-observe caller-owned state.
 *
 * The returned tree is already the canonical raw grammar consumed by
 * `deserializeValue`: Map/Set/Date/undefined become their exact tag records,
 * containers are fresh and frozen, and `-0` is normalized to JSON's canonical
 * zero. The function rejects accessors, sparse/extended arrays, unsupported or
 * forged prototypes, symbol/non-enumerable properties, reserved/pollution
 * keys, functions/symbols/BigInt/non-finite numbers, invalid dates, cycles,
 * excessive depth, and Proxy invariant/trap failures. Thus every successful
 * value can cross JSON and the strict node parser without omission or type
 * change; expected rejection is caught by `saveNode` and returned as
 * `checkpoint-write-failed`.
 */
export const materializeCanonicalOutput = (output: unknown): CanonicalSerializedValue => {
  const active = new Map<object, string>();

  const walk = (value: unknown, path: string, depth: number): CanonicalSerializedValue => {
    if (value === null) return null;
    if (value === undefined) return canonicalRecord([["__undefined__", true]]);
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`${path} contains non-finite number ${render(value)}; JSON would coerce it to null`);
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error(`${path} is a ${typeof value}; JSON cannot represent it losslessly`);
    }
    if (typeof value !== "object") {
      throw new Error(`${path} has unsupported type ${typeof value}`);
    }
    if (depth > MAX_SAFE_RECORD_DEPTH) {
      throw new Error(
        `node output nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH} at ${path} (depth ${depth})`,
      );
    }

    const priorPath = active.get(value);
    if (priorPath !== undefined) {
      throw new Error(`node output contains a cycle at ${path}; ${priorPath} is an ancestor`);
    }
    active.set(value, path);
    try {
      const prototype = Object.getPrototypeOf(value);

      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) {
          throw new Error(`${path} has an unsupported array prototype`);
        }
        const keys = Reflect.ownKeys(value);
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          throw new Error(`${path}.length has a malformed data descriptor`);
        }
        const length = lengthDescriptor.value;
        const indexed: Array<readonly [number, unknown]> = [];
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
            throw new Error(`${path} has unsupported array property ${render(key)}`);
          }
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index >= length) {
            throw new Error(`${path} has out-of-range array index ${render(key)}`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined) {
            throw new Error(`${outputPath(path, index)} disappeared between ownKeys and descriptor materialization`);
          }
          if (!("value" in descriptor)) {
            throw new Error(`${outputPath(path, index)} is an accessor; node output getters are rejected`);
          }
          if (!descriptor.enumerable) {
            throw new Error(`${outputPath(path, index)} is non-enumerable and would be omitted by JSON`);
          }
          indexed.push([index, descriptor.value]);
        }
        if (indexed.length !== length) {
          throw new Error(`${path} is sparse; JSON would replace missing array elements with null`);
        }
        indexed.sort(([left], [right]) => left - right);
        const canonical = indexed.map(([index, entry]) =>
          walk(entry, outputPath(path, index), depth + 1));
        return Object.freeze(canonical);
      }

      const ownKeys = Reflect.ownKeys(value);
      if (prototype === Date.prototype) {
        if (ownKeys.length !== 0) {
          throw new Error(`${path} is a Date with own properties that its serialized instant would omit`);
        }
        const instant = Date.prototype.getTime.call(value);
        if (!Number.isFinite(instant)) throw new Error(`${path} is an invalid Date`);
        return canonicalRecord([["__date__", new Date(instant).toISOString()]]);
      }
      if (prototype === Map.prototype) {
        if (ownKeys.length !== 0) {
          throw new Error(`${path} is a Map with own properties that serialization would omit`);
        }
        const entries = Array.from(Map.prototype.entries.call(value) as MapIterator<[unknown, unknown]>);
        const canonicalEntries = entries.map(([key, entry], index) => Object.freeze([
          walk(key, `${path}[map entry #${index} key]`, depth + 1),
          walk(entry, `${path}[map entry #${index} value]`, depth + 1),
        ] as const));
        return canonicalRecord([["__map__", Object.freeze(canonicalEntries)]]);
      }
      if (prototype === Set.prototype) {
        if (ownKeys.length !== 0) {
          throw new Error(`${path} is a Set with own properties that serialization would omit`);
        }
        const entries = Array.from(Set.prototype.values.call(value) as SetIterator<unknown>);
        const canonicalEntries = entries.map((entry, index) =>
          walk(entry, `${path}[set item #${index}]`, depth + 1));
        return canonicalRecord([["__set__", Object.freeze(canonicalEntries)]]);
      }
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} has unsupported prototype ${render(value)}`);
      }

      const captured: Array<readonly [string, unknown]> = [];
      for (const key of ownKeys) {
        if (typeof key !== "string") {
          throw new Error(`${path} has a symbol-keyed property that JSON would omit`);
        }
        if (POLLUTION_KEYS.has(key)) {
          throw new Error(`${outputPath(path, key)} is filtered as a prototype-pollution key`);
        }
        if (RESERVED_TAG_KEYS.has(key)) {
          throw new Error(`${outputPath(path, key)} is a reserved serializer tag in a plain object`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) {
          throw new Error(`${outputPath(path, key)} disappeared between ownKeys and descriptor materialization`);
        }
        if (!("value" in descriptor)) {
          throw new Error(`${outputPath(path, key)} is an accessor; node output getters are rejected`);
        }
        if (!descriptor.enumerable) {
          throw new Error(`${outputPath(path, key)} is non-enumerable and would be omitted by JSON`);
        }
        captured.push([key, descriptor.value]);
      }
      return canonicalRecord(captured.map(([key, entry]) => [
        key,
        walk(entry, outputPath(path, key), depth + 1),
      ] as const));
    } finally {
      active.delete(value);
    }
  };

  return walk(output, "output", 1);
};

/** Snapshot each public `NodeState` field with exactly one property read.
 * The frozen top-level value is the sole state input to boundary parsing and
 * canonical output materialization; stateful accessors cannot be consulted by
 * a later phase. */
export const snapshotNodeState = (state: unknown): RawNodeSnapshot => {
  const source = state as Record<string, unknown>;
  const nodeId = source.nodeId;
  const output = source.output;
  const completedAt = source.completedAt;
  return Object.freeze({
    plainRecord: isPlainRecord(state),
    nodeId,
    output,
    completedAt,
  });
};

/**
 * Serialize one canonical node envelope exactly once, then validate those
 * exact bytes through the strict read-side parser. The returned string is the
 * same string passed to `atomicWriteFile`; validation never observes a second
 * representation and serialization never rereads caller-owned values.
 */
export const serializeNode = (nodeKey: string, state: RawNodeSnapshot): string => {
  const { nodeId, output, completedAt } = state;
  if (!isBoundaryIdString(nodeId)) {
    throw new Error(`state.nodeId ${render(nodeId)} does not match ${ID_PATTERN.source}`);
  }
  if (!(completedAt instanceof Date)) {
    throw new Error(`state.completedAt must be a valid Date, got ${render(completedAt)}`);
  }
  const completedAtMs = Date.prototype.getTime.call(completedAt);
  if (!isRepresentableTimestampMs(completedAtMs)) {
    throw new Error(`state.completedAt must be a valid Date, got ${render(completedAt)}`);
  }

  const canonicalOutput = materializeCanonicalOutput(output);
  const stored: StoredNode = Object.freeze({
    nodeKey,
    nodeId,
    output: canonicalOutput,
    completedAt: new Date(completedAtMs).toISOString(),
  });
  const json = JSON.stringify(stored);
  const fileName = `${keyDigest(nodeKey)}.json`;
  const validation = parseNodeFile(fileName, json);
  if (validation.kind === "corrupt") {
    throw new Error(`canonical node envelope failed strict validation: ${validation.message}`);
  }
  return json;
};

/** The node-entry filename contract (ADR-0076): the 64-lowercase-hex digest of the
 * stored nodeKey, `.json`. A `*.json` file in `nodes/` that does not match was
 * never written by this backend. */
const NODE_FILE_NAME_PATTERN = /^([0-9a-f]{64})\.json$/;

/**
 * Verdict for one file in `nodes/` — a usable entry, or a corrupt one that
 * `load` drops and surfaces in `corruptNodeIds`.
 *
 * `address` is the name the caller gets back: a structurally recoverable
 * stored `nodeKey`, otherwise the filename. Digest disagreement still makes
 * the entry unusable, but does not erase a valid node address that callers can
 * use to distinguish "corrupt" from "never ran" (FR-028).
 */
export type NodeEntryVerdict =
  | { readonly kind: "entry"; readonly nodeKey: string; readonly state: NodeState }
  | { readonly kind: "corrupt"; readonly address: string; readonly message: string };

/**
 * Validate the RAW JSON representation of a node output before
 * `deserializeValue` can reinterpret or erase it. This delegates to the
 * shared serializer's canonical grammar, not merely a shape that its
 * permissive decoder happens to accept:
 *
 * - pollution-filtered keys are forbidden at every depth;
 * - a reserved tag object has exactly one field;
 * - Map entries are exact two-element tuples with no duplicate primitive keys;
 * - Date strings are the exact ISO form emitted by `Date#toISOString`;
 * - Set arrays contain no duplicate primitive values under SameValueZero;
 * - Set/undefined payloads have their one canonical shape.
 *
 * The shared iterative walk is pure and bounded. It preserves valid nested
 * Map/Set/Date/undefined values while rejecting ambiguous objects that the
 * decoder would otherwise truncate (for example `{__map__: [...], extra: 1}`).
 */
const validateRawSerializedOutput = (rawOutput: unknown): Result<void, string> =>
  validateSerializedValueGrammar(rawOutput, {
    rootPath: "output",
    maxDepth: MAX_SAFE_RECORD_DEPTH,
    initialDepth: 1,
  });

const STORED_NODE_FIELDS: ReadonlySet<string> = new Set([
  "nodeKey",
  "nodeId",
  "output",
  "completedAt",
]);

/**
 * Pure strict parse of one node file's bytes. Raw bytes cross three gates in
 * order: JSON parse, exact stored-envelope validation, then canonical
 * serializer-tag validation of `output`. Only after all three pass may
 * `deserializeValue` restore Map/Set/Date/undefined. Thus no permissive
 * decoder transformation can turn corrupt persisted bytes into a valid node.
 */
export const parseNodeFile = (fileName: string, text: string): NodeEntryVerdict => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: "corrupt", address: fileName, message: `not valid JSON: ${messageOf(error)}` };
  }
  if (!isPlainRecord(raw)) {
    return {
      kind: "corrupt",
      address: fileName,
      message: `node entry must be a JSON object, got ${render(raw)}`,
    };
  }

  const nodeKey = raw.nodeKey;
  const parsedNodeKey = typeof nodeKey === "string" ? parseCompositeNodeKey(nodeKey) : null;
  if (typeof nodeKey !== "string" || parsedNodeKey === null) {
    return {
      kind: "corrupt",
      address: fileName,
      message: `nodeKey ${render(nodeKey)} is not a well-formed canonical or composite node key`,
    };
  }

  const envelopeKeys = Object.keys(raw);
  const unknownField = envelopeKeys.find((key) => !STORED_NODE_FIELDS.has(key));
  if (unknownField !== undefined) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `unknown node-envelope field ${render(unknownField)}; expected exactly { nodeKey, nodeId, output, completedAt }`,
    };
  }
  const missingField = [...STORED_NODE_FIELDS].find(
    (key) => !Object.prototype.hasOwnProperty.call(raw, key),
  );
  if (missingField !== undefined) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `missing node-envelope field ${render(missingField)}; expected exactly { nodeKey, nodeId, output, completedAt }`,
    };
  }

  // From this point the address is recoverable even when another field or the
  // digest filename is corrupt (FR-028).
  const nameMatch = NODE_FILE_NAME_PATTERN.exec(fileName);
  if (nameMatch === null) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `filename does not match the node-entry contract <sha256hex(nodeKey)>.json`,
    };
  }
  const digest = nameMatch[1];
  if (keyDigest(nodeKey) !== digest) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `nodeKey ${render(nodeKey)} digests to ${keyDigest(nodeKey)} but was read from ${fileName} — the entry does not own this address`,
    };
  }

  const parsedNodeFields = parseNodeStateRecord(raw);
  if (!parsedNodeFields.ok) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: parsedNodeFields.error,
    };
  }
  const { nodeId, completedAt } = parsedNodeFields.value;
  if (parsedNodeKey.nodeId !== nodeId) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `nodeKey names nodeId ${render(parsedNodeKey.nodeId)} but entry contains ${render(nodeId)}`,
    };
  }

  const rawOutput = raw.output;
  const outputValidation = validateRawSerializedOutput(rawOutput);
  if (!outputValidation.ok) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `serialized output is not canonical: ${outputValidation.error}`,
    };
  }
  // All expected malformed-byte cases have explicit verdicts above. A throw
  // from the decoder after those gates is therefore an implementation defect,
  // not corrupt persisted data; let the imperative shell map it to
  // `cache-error(load)` rather than silently dropping the entry.
  const output = deserializeValue(rawOutput);

  return {
    kind: "entry",
    nodeKey,
    // `ID_PATTERN` and the canonical-ISO grammar were just proven by the
    // shared record validator (round-23 atl-1).
    state: { nodeId, output, completedAt },
  };
};

// ---------------------------------------------------------------------------
// Boundary validation helpers (FR-016)
// ---------------------------------------------------------------------------

const SAVE_NODE_OPTION_FIELDS: ReadonlySet<string> = new Set([
  "namespace",
  "index",
  "attempt",
]);

/**
 * Snapshot the `saveNode` runtime input once. This phase captures the complete
 * own-key set and reads each supported own field at most once; it does NOT
 * claim that the captured shape or values satisfy the options contract.
 * `parseSaveNodeBoundary` performs that later parse step: it validates the
 * snapshot's shape/invariants and constructs the fresh canonical `SaveNodeOpts`
 * consumed by `compositeNodeKey`. No phase rereads the caller-owned object.
 */
export const snapshotSaveNodeOpts = (opts: unknown): RawSaveNodeOptsSnapshot | undefined => {
  if (opts === undefined) return undefined;
  const source = opts as Record<string, unknown>;
  const ownKeys = Object.freeze([...Reflect.ownKeys(source)]);
  const owns = (field: string): boolean => ownKeys.some((key) => key === field);
  // Read only declared own fields, and read each at most once, before shape or
  // field validation. This avoids consulting inherited state and prevents
  // accessors changing between address validation and key construction.
  const namespace = owns("namespace") ? source.namespace : undefined;
  const index = owns("index") ? source.index : undefined;
  const attempt = owns("attempt") ? source.attempt : undefined;
  return Object.freeze({
    plainObject: isPlainObject(opts),
    ownKeys,
    namespace,
    index,
    attempt,
  });
};

/** Parse the snapshotted runtime boundary into canonical options. Once this
 * succeeds, all supported fields and invariants are established before path
 * construction or persistence (FR-016/FR-029). Parse-named like its siblings
 * (`parseLoadOpts`/`parseStoredMeta`/`parseNodeFile`): the Ok side carries the
 * parsed canonical value, the Err side the boundary violation. */
export const parseSaveNodeBoundary = (
  runId: unknown,
  nodeId: unknown,
  state: RawNodeSnapshot,
  opts: RawSaveNodeOptsSnapshot | undefined,
): Result<SaveNodeOpts | undefined, string> => {
  if (!isBoundaryId(runId)) {
    return err(`runId ${render(runId)} does not match ${ID_PATTERN.source} — refusing to address a path outside the run directory`);
  }
  if (!isBoundaryId(nodeId)) {
    return err(`nodeId ${render(nodeId)} does not match ${ID_PATTERN.source} — refusing to address a path outside the run directory`);
  }
  if (!state.plainRecord) {
    return err("node state must be an object");
  }
  if (!isBoundaryId(state.nodeId)) {
    return err(`state.nodeId ${render(state.nodeId)} does not match ${ID_PATTERN.source}`);
  }
  if (state.nodeId !== nodeId) {
    return err(`state.nodeId ${render(state.nodeId)} must match addressed nodeId ${render(nodeId)}`);
  }
  if (opts === undefined) return ok(undefined);
  if (!opts.plainObject) {
    return err("saveNode options must be a plain object when present");
  }

  const unsupportedKey = opts.ownKeys.find(
    (key) => typeof key !== "string" || !SAVE_NODE_OPTION_FIELDS.has(key),
  );
  if (unsupportedKey !== undefined) {
    return err(
      `saveNode options contain unsupported field ${render(unsupportedKey)}; supported fields are namespace, index, attempt`,
    );
  }

  const { namespace, index, attempt } = opts;
  if (namespace !== undefined && !isBoundaryIdString(namespace)) {
    return err(`namespace ${render(namespace)} does not match ${ID_PATTERN.source} — refusing to address a path outside the run directory`);
  }
  if (index !== undefined && !isNonNegativeSafeInteger(index)) {
    return err(`index must be a non-negative safe integer, got ${render(index)}`);
  }
  if (attempt !== undefined && !isNonNegativeSafeInteger(attempt)) {
    return err(`attempt must be a non-negative safe integer, got ${render(attempt)}`);
  }

  return ok(Object.freeze({
    ...(namespace !== undefined ? { namespace } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
  }));
};

const LOAD_OPTION_FIELDS: ReadonlySet<string> = new Set(["expectedDagFingerprint"]);

/** Strict runtime parser for the complete load-options grammar. The returned
 * object is fresh and frozen, so fingerprint validation never rereads the
 * caller's object. */
export const parseLoadOpts = (
  loadOpts: unknown,
): Result<CheckpointerLoadOpts | undefined, string> => {
  if (loadOpts === undefined) return ok(undefined);
  if (!isPlainObject(loadOpts)) {
    return err(`load options must be a plain object when present, got ${render(loadOpts)}`);
  }

  const ownKeys = Reflect.ownKeys(loadOpts);
  const unsupportedKey = ownKeys.find(
    (key) => typeof key !== "string" || !LOAD_OPTION_FIELDS.has(key),
  );
  if (unsupportedKey !== undefined) {
    return err(
      `load options contain unsupported field ${render(unsupportedKey)}; supported field is expectedDagFingerprint`,
    );
  }

  // The exact-key gate above already proved `ownKeys` is `[]` or exactly
  // `["expectedDagFingerprint"]`, so a single direct read IS the presence
  // check: it yields `undefined` exactly when the key is absent, with one
  // property observation (pinned in file-checkpointer-codec.test.ts,
  // "returns fresh frozen option objects the caller cannot mutate or
  // re-observe" — the counting-Proxy `reads === 1` assertion).
  const expectedDagFingerprint = loadOpts.expectedDagFingerprint;
  if (expectedDagFingerprint !== undefined && typeof expectedDagFingerprint !== "string") {
    return err(
      `expectedDagFingerprint must be a string when present, got ${render(expectedDagFingerprint)}`,
    );
  }
  return ok(Object.freeze(
    expectedDagFingerprint === undefined ? {} : { expectedDagFingerprint },
  ));
};
