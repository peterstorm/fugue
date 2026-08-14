// `Checkpointer` backend over the filesystem (FR-020..FR-029, AD-1/AD-2/AD-6).
//
// On-disk layout, per run, under the caller-supplied `directory`:
//
//   <directory>/<runId>/meta.json                     per-run metadata projection
//   <directory>/<runId>/nodes/<sha256hex(nodeKey)>.json   one file per stored node entry
//
// Both projections commit through `atomicWriteFile` (tmp + rename), so a
// reader observes the prior-complete or the new-complete snapshot, never a
// partial write (FR-029). Crash litter is named `<path>.tmp.<unique-token>` and is
// invisible to the reader, which only ever considers `*.json` entries.
//
// AD-2 digest filenames: a stored nodeKey may be a composite address
// (`namespace@nodeId@index@attempt`, up to 291 bytes — see `layout.ts`), which
// would exceed NAME_MAX in a literal `<key>.json` filename. Entries are
// therefore addressed by `keyDigest(nodeKey)` and every read verifies the
// filename digest against the `nodeKey` recorded INSIDE the file: a mismatch
// means the file was moved, hand-written, or truncated, and the entry fails
// closed as corrupt rather than being served under an address it does not own.
//
// AD-1 composite addressing: this is the ONE backend that implements it
// (FR-022/FR-023). `saveNode`'s 4th argument goes through `compositeNodeKey`,
// whose canonical folding makes a save with no `index`/`attempt` byte-identical
// to a pre-extension save (stored key = the bare `nodeId`). Because `@` is
// outside `ID_PATTERN`, a composite key can never collide with a canonical one,
// and distinct addresses digest to distinct filenames — so any two distinct
// addresses resolve to distinct durable entries and `load` returns them all,
// keyed by their stored nodeKey.
//
// Load order is Redis-parity (FR-025..FR-028), and deliberately so: a caller
// swapping backends must observe the same error for the same durable state.
//
//   meta absent                                   ⇒ ok(null)         (unknown run, never an error)
//   meta unparseable / schema-violating           ⇒ checkpoint-corrupt
//   stored frameworkVersion ≠ FRAMEWORK_VERSION   ⇒ checkpoint-version-mismatch (ADR-0017)
//   expectedDagFingerprint supplied and ≠ stored  ⇒ checkpoint-version-mismatch
//   createdAt older than TTL_SECONDS (24h)        ⇒ checkpoint-expired
//   per-node entry corrupt                        ⇒ DROPPED + surfaced in corruptNodeIds
//
// Expiry is evaluated LAZILY at load through the injected `now()` (FR-027):
// there is no background sweeper and no physical GC in this pass, so an
// expired run's bytes stay on disk while its `load` fails closed.
//
// Boundary validation (FR-016/FR-029): `runId`, `nodeId`, `state.nodeId`, and
// the composite `namespace`/`index`/`attempt` are ALL re-validated here, before
// any `join`, even though the port types are branded — a bypassed brand (a JS
// caller, a widening cast, a value deserialized from an untrusted transport) is
// exactly the case this boundary exists for. Validation first, `join` second:
// a raw identifier never reaches a path string, so `..`, `/`, NUL and friends
// can never address anything outside the caller-supplied run directory.
// Backend-managed run/nodes directories and readable record files are also
// lstat/realpath-verified as non-symlinks under a canonical base anchor before
// I/O; directory identity is rechecked around writes. Portable Node path APIs
// cannot provide descriptor-relative openat traversal, so this rejects
// pre-existing substitutions and narrows check/use races without claiming
// safety against a process concurrently renaming filesystem entries.
//
// Failure surface (AD-6/FR-040): NOTHING throws across the port boundary.
// Every failure returns `Result<_, FrameworkError>` using existing kinds —
// invalid write values / serialization as `checkpoint-write-failed`, all
// filesystem or clock failures as `cache-error` (`saveNode`/`setMeta`/`load`),
// and the durable-state verdicts as
// `checkpoint-corrupt`/`checkpoint-version-mismatch`/`checkpoint-expired`.
//
// Import discipline (INV-1): `node:fs` and `node:path` only among the node
// built-ins (the digest comes from `layout.ts`, which owns the `node:crypto`
// import); no broker modules.

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { MAX_SAFE_RECORD_DEPTH } from "./event-record.js";
import { META_FILE, NODES_DIR, TTL_SECONDS, isBoundaryId, keyDigest } from "./layout.js";
import type {
  Checkpointer,
  CheckpointerLoadOpts,
  NodeState,
  RunMeta,
  RunState,
  SaveNodeOpts,
} from "../checkpoint/checkpointer.js";
import { compositeNodeKey, parseCompositeNodeKey } from "../checkpoint/composite-node-key.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import {
  deserializeValue,
  validateSerializedValueGrammar,
} from "../state-machine/serialize.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, RunId } from "../types/ids.js";
import { ID_PATTERN, __brandNodeId, __brandRunId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import { frameworkError } from "../types/error-factories.js";
import {
  probeErrorCode,
  safeDiagnosticRender,
  safeErrorMessage,
  safeErrorMessageWithCodeProbe,
} from "../types/safe-error.js";
import { fwLogger } from "../logger.js";
import {
  fileCacheError,
  fileOperationError,
  type FileOperation,
} from "./boundary-error.js";

/** Checkpointer-only operation vocabulary. The narrower extraction makes a
 * cache operation typo fail both framework typechecks without narrowing the
 * public `FrameworkError` contract used by other adapters. */
type FileCheckpointerCacheOperation = Extract<
  FileOperation,
  "load" | "saveNode" | "setMeta"
>;

const checkpointerCacheError = (
  operation: FileCheckpointerCacheOperation,
  message: string,
): FrameworkError => fileCacheError(operation, message);

// ---------------------------------------------------------------------------
// Error construction (AD-6)
// ---------------------------------------------------------------------------

/**
 * Grammar-valid diagnostic location used for metadata-scoped write failures.
 * `checkpoint-write-failed.nodeId` is a legacy required field, so metadata
 * failures need a truthful internal address even though no DAG node was being
 * written. Exported for source compatibility and for consumers that classify
 * metadata failures without parsing messages.
 */
export const META_RECORD_NODE_ID: NodeId = __brandNodeId("checkpoint_meta");

/** Grammar-valid locations used only when rejected raw values cannot inhabit
 * the required branded fields. The raw values remain available in the
 * additive `invalidRunId` / `invalidNodeId` diagnostics. */
const INVALID_RUN_ID: RunId = __brandRunId("checkpoint_invalid_run");
const INVALID_NODE_ID: NodeId = __brandNodeId("checkpoint_invalid_node");

/** Compact rendering of an identifier for error messages — a hostile 10 KB
 * "runId" must not flood the log line that rejects it. */
const stringOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
};

const render = safeDiagnosticRender;
const messageOf = safeErrorMessage;

/**
 * Construct a truthful, source-compatible `checkpoint-write-failed` value.
 * Valid raw identifiers retain their own brands. Invalid raw identifiers are
 * never branded as themselves: required legacy fields receive documented,
 * grammar-valid internal locations while additive diagnostics preserve the
 * rejected bytes. Metadata failures use `META_RECORD_NODE_ID`.
 */
const writeFailed = (
  runIdRaw: unknown,
  nodeIdRaw: unknown | undefined,
  message: string,
): FrameworkError => {
  const runIdValid = typeof runIdRaw === "string" && isBoundaryId(runIdRaw);
  const nodeIdValid = typeof nodeIdRaw === "string" && isBoundaryId(nodeIdRaw);
  return {
    kind: "checkpoint-write-failed",
    runId: runIdValid ? __brandRunId(runIdRaw) : INVALID_RUN_ID,
    nodeId:
      nodeIdRaw === undefined
        ? META_RECORD_NODE_ID
        : nodeIdValid
          ? __brandNodeId(nodeIdRaw)
          : INVALID_NODE_ID,
    ...(!runIdValid ? { invalidRunId: stringOf(runIdRaw) } : {}),
    ...(nodeIdRaw !== undefined && !nodeIdValid
      ? { invalidNodeId: stringOf(nodeIdRaw) }
      : {}),
    message,
  };
};

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
 * filename; `nodeId` names the real node inside it (AD-1). */
interface StoredNode {
  readonly nodeKey: string;
  readonly nodeId: string;
  readonly output: unknown;
  readonly completedAt: string;
}

/** Immutable top-level snapshots of caller-owned write inputs. Accessors are
 * invoked only while constructing these values; every subsequent validation,
 * key derivation, and serialization step consumes the snapshots. */
interface RawMetaSnapshot {
  readonly plainRecord: boolean;
  readonly dagId: unknown;
  readonly startedAt: unknown;
  readonly nodeCount: unknown;
  readonly subject: unknown;
  readonly dagFingerprint: unknown;
  readonly frameworkVersion: unknown;
}

interface RawNodeSnapshot {
  readonly plainRecord: boolean;
  readonly nodeId: unknown;
  readonly output: unknown;
  readonly completedAt: unknown;
}

interface RawSaveNodeOptsSnapshot {
  readonly plainObject: boolean;
  readonly ownKeys: readonly PropertyKey[];
  readonly namespace: unknown;
  readonly index: unknown;
  readonly attempt: unknown;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Runtime configuration objects must be records, not merely object-like
 * values. Class instances carry behavior/prototype state outside the supported
 * option grammar and are therefore rejected at the boundary. Null-prototype
 * records remain valid plain objects. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * `isBoundaryId` as a TYPE GUARD. `layout.ts` owns the rule and returns a
 * plain boolean (its callers are path builders, not parsers); this module
 * parses untrusted on-disk and job-side values, so the same check has to
 * NARROW — a validated id must come out of the guard as a `string`, never as
 * an `unknown` a later line re-asserts. One rule, two views; the predicate
 * delegates and never re-encodes the pattern.
 */
const isBoundaryIdString = (value: unknown): value is string => isBoundaryId(value);

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

/** Parse the exact timestamp grammar emitted on write. Date accepts many
 * non-canonical spellings (`2025-01-01`, offsets, missing milliseconds); a
 * persisted checkpoint timestamp is valid only when parsing and re-emitting
 * it produces byte-identical text. The parse/re-emit pair is guarded so corrupt
 * bytes can only become an `Err`, never a raw date exception. */
const parseCanonicalIsoDate = (
  value: string,
  field: "startedAt" | "createdAt" | "completedAt",
): Result<Date, string> => {
  try {
    const parsed = new Date(value);
    const canonical = Date.prototype.toISOString.call(parsed);
    return canonical === value
      ? ok(parsed)
      : err(`${field} must be a canonical ISO timestamp, got ${render(value)}`);
  } catch {
    return err(`${field} must be a canonical ISO timestamp, got ${render(value)}`);
  }
};

/** Snapshot every public `RunMeta` field with exactly one property read.
 * The frozen value is the sole input to metadata validation and serialization,
 * so stateful accessors cannot yield one value to validation and another to
 * the committed bytes. */
const snapshotMeta = (meta: unknown): RawMetaSnapshot => {
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
const serializeMeta = (meta: RawMetaSnapshot, createdAtMs: number): string => {
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
  if (!Number.isSafeInteger(nodeCount) || typeof nodeCount !== "number" || nodeCount < 0) {
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
  if (!isValidDate(createdAt)) {
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
const parseStoredMeta = (
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
  const { dagId, startedAt, nodeCount, createdAt, subject, dagFingerprint, frameworkVersion } = raw;
  if (typeof dagId !== "string") return err(`dagId must be a string, got ${render(dagId)}`);
  if (typeof startedAt !== "string") return err(`startedAt must be a string, got ${render(startedAt)}`);
  if (typeof createdAt !== "string") return err(`createdAt must be a string, got ${render(createdAt)}`);
  if (typeof nodeCount !== "number" || !Number.isSafeInteger(nodeCount) || nodeCount < 0) {
    return err(`nodeCount must be a non-negative safe integer, got ${render(nodeCount)}`);
  }
  if (subject !== undefined && typeof subject !== "string") {
    return err(`subject must be a string when present, got ${render(subject)}`);
  }
  if (dagFingerprint !== undefined && typeof dagFingerprint !== "string") {
    return err(`dagFingerprint must be a string when present, got ${render(dagFingerprint)}`);
  }
  if (frameworkVersion !== undefined && typeof frameworkVersion !== "string") {
    return err(`frameworkVersion must be a string when present, got ${render(frameworkVersion)}`);
  }
  const parsedStartedAt = parseCanonicalIsoDate(startedAt, "startedAt");
  if (!parsedStartedAt.ok) return err(parsedStartedAt.error);
  const parsedCreatedAt = parseCanonicalIsoDate(createdAt, "createdAt");
  if (!parsedCreatedAt.ok) return err(parsedCreatedAt.error);
  return ok({
    meta: {
      dagId,
      startedAt: parsedStartedAt.value,
      nodeCount,
      ...(subject !== undefined ? { subject } : {}),
      ...(dagFingerprint !== undefined ? { dagFingerprint } : {}),
      ...(frameworkVersion !== undefined ? { frameworkVersion } : {}),
    },
    createdAt: parsedCreatedAt.value,
  });
};

type CanonicalSerializedValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalSerializedValue[]
  | { readonly [key: string]: CanonicalSerializedValue };

const OUTPUT_RESERVED_TAG_KEYS: ReadonlySet<string> = new Set([
  "__map__",
  "__set__",
  "__date__",
  "__undefined__",
]);

const OUTPUT_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const outputPath = (parent: string, key: string | number): string =>
  typeof key === "number"
    ? `${parent}[${key}]`
    : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
      ? `${parent}.${key}`
      : `${parent}[${JSON.stringify(key)}]`;

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
const materializeCanonicalOutput = (output: unknown): CanonicalSerializedValue => {
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
        if (OUTPUT_POLLUTION_KEYS.has(key)) {
          throw new Error(`${outputPath(path, key)} is filtered as a prototype-pollution key`);
        }
        if (OUTPUT_RESERVED_TAG_KEYS.has(key)) {
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
const snapshotNodeState = (state: unknown): RawNodeSnapshot => {
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
const serializeNode = (nodeKey: string, state: RawNodeSnapshot): string => {
  const { nodeId, output, completedAt } = state;
  if (!isBoundaryIdString(nodeId)) {
    throw new Error(`state.nodeId ${render(nodeId)} does not match ${ID_PATTERN.source}`);
  }
  if (!(completedAt instanceof Date)) {
    throw new Error(`state.completedAt must be a valid Date, got ${render(completedAt)}`);
  }
  const completedAtMs = Date.prototype.getTime.call(completedAt);
  if (!Number.isFinite(completedAtMs)) {
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

/** The node-entry filename contract (AD-2): the 64-lowercase-hex digest of the
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
type NodeEntryVerdict =
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
const parseNodeFile = (fileName: string, text: string): NodeEntryVerdict => {
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

  const { nodeId, completedAt } = raw;
  if (!isBoundaryIdString(nodeId)) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `nodeId ${render(nodeId)} does not match ${ID_PATTERN.source}`,
    };
  }
  if (parsedNodeKey.nodeId !== nodeId) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `nodeKey names nodeId ${render(parsedNodeKey.nodeId)} but entry contains ${render(nodeId)}`,
    };
  }
  if (typeof completedAt !== "string") {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: `completedAt must be a string, got ${render(completedAt)}`,
    };
  }
  const parsedCompletedAt = parseCanonicalIsoDate(completedAt, "completedAt");
  if (!parsedCompletedAt.ok) {
    return {
      kind: "corrupt",
      address: nodeKey,
      message: parsedCompletedAt.error,
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
    state: { nodeId, output, completedAt: parsedCompletedAt.value },
  };
};

// ---------------------------------------------------------------------------
// Boundary validation helpers (FR-016)
// ---------------------------------------------------------------------------

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const SAVE_NODE_OPTION_FIELDS: ReadonlySet<string> = new Set([
  "namespace",
  "index",
  "attempt",
]);

/**
 * Snapshot the `saveNode` runtime input once. This phase captures the complete
 * own-key set and reads each supported own field at most once; it does NOT
 * claim that the captured shape or values satisfy the options contract.
 * `saveNodeBoundaryViolation` performs that later parse step: it validates the
 * snapshot's shape/invariants and constructs the fresh canonical `SaveNodeOpts`
 * consumed by `compositeNodeKey`. No phase rereads the caller-owned object.
 */
const snapshotSaveNodeOpts = (opts: unknown): RawSaveNodeOptsSnapshot | undefined => {
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
 * construction or persistence (FR-016/FR-029). */
const saveNodeBoundaryViolation = (
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
const parseLoadOpts = (
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

  const hasFingerprint = ownKeys.some((key) => key === "expectedDagFingerprint");
  const expectedDagFingerprint = hasFingerprint
    ? loadOpts.expectedDagFingerprint
    : undefined;
  if (expectedDagFingerprint !== undefined && typeof expectedDagFingerprint !== "string") {
    return err(
      `expectedDagFingerprint must be a string when present, got ${render(expectedDagFingerprint)}`,
    );
  }
  return ok(Object.freeze(
    expectedDagFingerprint === undefined ? {} : { expectedDagFingerprint },
  ));
};

// ---------------------------------------------------------------------------
// Backend (imperative shell)
// ---------------------------------------------------------------------------

export interface FileCheckpointerOptions {
  /**
   * Wall-clock source stamping `createdAt` on `setMeta` and evaluating the
   * lazy 24h expiry window on `load` (FR-027). Injected for deterministic
   * tests; defaults to `Date.now`.
   */
  readonly now?: () => number;
}

const FILE_CHECKPOINTER_OPTION_FIELDS: ReadonlySet<string> = new Set(["now"]);

interface VerifiedDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

const isMissingPathError = (error: unknown): boolean => {
  const probe = probeErrorCode(error);
  return probe.kind === "code" && probe.code === "ENOENT";
};

/**
 * Establish a directory as a non-symlink trust anchor. The returned canonical
 * path, device, and inode are the only addressing material used below. The
 * final supplied base entry and every backend-managed descendant are checked;
 * portable Node does not expose openat-style traversal for pinning every
 * ancestor descriptor against a malicious concurrent rename.
 */
const verifyDirectory = (
  path: string,
  expectedParent: string | null,
  create: boolean,
): VerifiedDirectory | null => {
  if (create) {
    try {
      mkdirSync(path, { recursive: expectedParent === null });
    } catch (error) {
      const probe = probeErrorCode(error);
      if (!(probe.kind === "code" && probe.code === "EEXIST")) throw error;
    }
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (!create && isMissingPathError(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link directory ${render(path)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`expected directory at ${render(path)}, found a non-directory entry`);
  }

  const canonical = realpathSync(path);
  if (expectedParent !== null && dirname(canonical) !== expectedParent) {
    throw new Error(
      `directory ${render(path)} resolves to ${render(canonical)}, outside verified parent ${render(expectedParent)}`,
    );
  }
  return Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino });
};

const assertDirectoryIdentity = (directory: VerifiedDirectory): void => {
  const stat = lstatSync(directory.path);
  if (
    stat.isSymbolicLink() || !stat.isDirectory() ||
    stat.dev !== directory.device || stat.ino !== directory.inode ||
    realpathSync(directory.path) !== directory.path
  ) {
    throw new Error(`verified directory identity changed during operation: ${render(directory.path)}`);
  }
};

const verifyExistingFile = (
  parent: VerifiedDirectory,
  fileName: string,
): string => {
  assertDirectoryIdentity(parent);
  const candidate = join(parent.path, fileName);
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link file ${render(candidate)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`expected regular file at ${render(candidate)}, found a non-file entry`);
  }
  const canonical = realpathSync(candidate);
  if (dirname(canonical) !== parent.path) {
    throw new Error(
      `file ${render(candidate)} resolves to ${render(canonical)}, outside verified parent ${render(parent.path)}`,
    );
  }
  return canonical;
};

/**
 * Parse factory configuration into one immutable clock reference. The caller's
 * property bag is inspected exactly once: one complete `ownKeys` snapshot and,
 * when present, one descriptor read for `now`. Reading through its captured
 * descriptor avoids a second Proxy `get` observation; an accessor getter is
 * invoked once to preserve ordinary property semantics.
 *
 * Every reflective operation is isolated so hostile Proxy traps are normalized
 * before the public factory maps them to typed `cache-error`. The complete own-key
 * snapshot also makes the options grammar closed over string, symbol,
 * enumerable, and non-enumerable keys: a typo can never silently select
 * `Date.now`.
 */
const parseFileCheckpointerClock = (opts: unknown): (() => number) => {
  if (opts === undefined) return Date.now;

  let source: Record<string, unknown> | undefined;
  try {
    if (isPlainObject(opts)) source = opts;
  } catch (error) {
    throw new TypeError(
      `createFileCheckpointer could not inspect options object: ${messageOf(error)}`,
    );
  }
  if (source === undefined) {
    throw new TypeError(
      `createFileCheckpointer options must be a plain object when present, got ${render(opts)}`,
    );
  }

  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Object.freeze([...Reflect.ownKeys(source)]);
  } catch (error) {
    throw new TypeError(
      `createFileCheckpointer could not inspect options own keys: ${messageOf(error)}`,
    );
  }
  const unsupportedKey = ownKeys.find(
    (key) => typeof key !== "string" || !FILE_CHECKPOINTER_OPTION_FIELDS.has(key),
  );
  if (unsupportedKey !== undefined) {
    throw new TypeError(
      `createFileCheckpointer options contain unsupported own key ${render(unsupportedKey)}; supported key is now`,
    );
  }
  if (!ownKeys.some((key) => key === "now")) return Date.now;

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, "now");
  } catch (error) {
    throw new TypeError(
      `createFileCheckpointer could not inspect options.now descriptor: ${messageOf(error)}`,
    );
  }
  if (descriptor === undefined) {
    throw new TypeError(
      "createFileCheckpointer options.now disappeared during configuration inspection",
    );
  }

  let configuredNow: unknown;
  if ("value" in descriptor) {
    configuredNow = descriptor.value;
  } else if (descriptor.get === undefined) {
    configuredNow = undefined;
  } else {
    try {
      configuredNow = Reflect.apply(descriptor.get, source, []);
    } catch (error) {
      throw new TypeError(
        `createFileCheckpointer could not read options.now: ${messageOf(error)}`,
      );
    }
  }
  if (configuredNow !== undefined && typeof configuredNow !== "function") {
    throw new TypeError(
      `createFileCheckpointer options.now must be a function when present, got ${render(configuredNow)}`,
    );
  }
  return configuredNow === undefined ? Date.now : configuredNow as () => number;
};

/**
 * Create a `Checkpointer` durably backed by `directory`, keyed by run.
 *
 * Factory configuration is parsed eagerly: malformed options, unsupported own
 * keys (including symbols and non-enumerables), or a present non-function
 * `now` throw typed `cache-error(createFileCheckpointer)` before any backend
 * object is returned or filesystem I/O occurs. This closed grammar prevents a misspelled clock option from
 * silently falling back to `Date.now`. Operational port methods retain typed
 * `Result` boundaries.
 *
 * @throws {FrameworkError} `cache-error(createFileCheckpointer)` when
 * `directory` or the complete own-property options grammar cannot be parsed.
 *
 * The directory is created on demand, so a caller may point at a path that
 * does not exist yet. The supplied base entry and backend-managed run/nodes
 * descendants must be real directories, never symbolic links; canonical
 * parent agreement is proved before I/O.
 *
 * Concurrency contract: one writer owns a checkpoint directory and sequences
 * updates through its event-loop flow, matching the plan's single-writer
 * shell. Each individual commit is atomic for readers and uses its own unique
 * temporary path, but this adapter remains a single-writer projection model.
 */
const createFileCheckpointerUnchecked = (
  directory: string,
  opts?: FileCheckpointerOptions,
): Checkpointer => {
  // Configuration has no Result-returning port boundary. Parse it eagerly so
  // malformed JavaScript callers fail at factory construction, rather than
  // reaching `join`/`readFileSync` later and escaping a port method as a raw
  // path TypeError.
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\u0000")) {
    throw new TypeError(
      `createFileCheckpointer directory must be a non-empty NUL-free string, got ${render(directory)}`,
    );
  }
  const now = parseFileCheckpointerClock(opts);

  // Validated-id-only, symlink-rejecting path construction. Callers MUST have
  // passed `isBoundaryId` before reaching here.
  const runDirectoryOf = (
    validRunId: string,
    create: boolean,
  ): VerifiedDirectory | null => {
    const base = verifyDirectory(directory, null, create);
    if (base === null) return null;
    return verifyDirectory(join(base.path, validRunId), base.path, create);
  };

  return {
    async setMeta(runId: RunId, meta: RunMeta): Promise<Result<void, FrameworkError>> {
      let rawMeta: RawMetaSnapshot;
      try {
        rawMeta = snapshotMeta(meta);
      } catch (error) {
        return err(
          writeFailed(
            runId,
            undefined,
            `setMeta rejected unreadable metadata for run ${render(runId)}: ${messageOf(error)}`,
          ),
        );
      }
      if (!isBoundaryId(runId)) {
        return err(
          writeFailed(
            runId,
            undefined,
            `setMeta rejected: runId ${render(runId)} does not match ${ID_PATTERN.source} — refusing to address a path outside ${render(directory)}`,
          ),
        );
      }
      let createdAtMs: number;
      try {
        createdAtMs = now();
      } catch (error) {
        return err(
          checkpointerCacheError(
            "setMeta",
            `setMeta clock failed for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
          ),
        );
      }
      if (!Number.isFinite(createdAtMs) || !isValidDate(new Date(createdAtMs))) {
        return err(
          checkpointerCacheError(
            "setMeta",
            `setMeta clock returned a non-representable timestamp for run ${render(runId)}: ${render(createdAtMs)}`,
          ),
        );
      }

      let json: string;
      try {
        json = serializeMeta(rawMeta, createdAtMs);
      } catch (error) {
        return err(
          writeFailed(
            runId,
            undefined,
            `setMeta rejected invalid metadata for run ${render(runId)}: ${messageOf(error)}`,
          ),
        );
      }

      try {
        const runDirectory = runDirectoryOf(runId, true);
        if (runDirectory === null) throw new Error("run directory creation returned no directory");
        assertDirectoryIdentity(runDirectory);
        atomicWriteFile(join(runDirectory.path, META_FILE), json);
        assertDirectoryIdentity(runDirectory);
        return ok(undefined);
      } catch (error) {
        return err(
          checkpointerCacheError(
            "setMeta",
            `setMeta filesystem failure for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
          ),
        );
      }
    },

    async saveNode(
      runId: RunId,
      nodeId: string,
      state: NodeState,
      saveOpts?: SaveNodeOpts,
    ): Promise<Result<void, FrameworkError>> {
      let rawState: RawNodeSnapshot;
      let rawSaveOpts: RawSaveNodeOptsSnapshot | undefined;
      try {
        // Snapshot ALL caller-owned property bags before validating any field.
        // No code below this block consults `state` or `saveOpts` again.
        rawState = snapshotNodeState(state);
        rawSaveOpts = snapshotSaveNodeOpts(saveOpts);
      } catch (error) {
        return err(
          writeFailed(
            runId,
            nodeId,
            `saveNode rejected an unreadable boundary value: ${messageOf(error)}`,
          ),
        );
      }

      const parsedBoundary = saveNodeBoundaryViolation(runId, nodeId, rawState, rawSaveOpts);
      if (!parsedBoundary.ok) {
        return err(writeFailed(runId, nodeId, `saveNode rejected: ${parsedBoundary.error}`));
      }
      const parsedSaveOpts = parsedBoundary.value;
      let nodeKey: string;
      let json: string;
      try {
        nodeKey = compositeNodeKey(__brandNodeId(nodeId), parsedSaveOpts);
        json = serializeNode(nodeKey, rawState);
      } catch (error) {
        return err(
          writeFailed(
            runId,
            nodeId,
            `saveNode rejected invalid state for run ${render(runId)}: ${messageOf(error)}`,
          ),
        );
      }

      try {
        const runDirectory = runDirectoryOf(runId, true);
        if (runDirectory === null) throw new Error("run directory creation returned no directory");
        const nodesDirectory = verifyDirectory(
          join(runDirectory.path, NODES_DIR),
          runDirectory.path,
          true,
        );
        if (nodesDirectory === null) throw new Error("nodes directory creation returned no directory");
        assertDirectoryIdentity(runDirectory);
        assertDirectoryIdentity(nodesDirectory);
        atomicWriteFile(join(nodesDirectory.path, `${keyDigest(nodeKey)}.json`), json);
        assertDirectoryIdentity(nodesDirectory);
        assertDirectoryIdentity(runDirectory);
        return ok(undefined);
      } catch (error) {
        return err(
          checkpointerCacheError(
            "saveNode",
            `saveNode filesystem failure for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
          ),
        );
      }
    },

    async load(
      runId: RunId,
      loadOpts?: CheckpointerLoadOpts,
    ): Promise<Result<RunState | null, FrameworkError>> {
      // A boundary-invalid runId on the READ side is an infrastructure-level
      // rejection, not a durable-state verdict: there is no checkpoint to call
      // corrupt, expired, or version-mismatched, so `cache-error` is the
      // honest kind (and it carries the raw operation + message without
      // needing a brand the value would fail).
      if (!isBoundaryId(runId)) {
        return err(
          checkpointerCacheError(
            "load",
            `load rejected: runId ${render(runId)} does not match ${ID_PATTERN.source} — refusing to address a path outside ${render(directory)}`,
          ),
        );
      }
      let parsedLoadOpts: Result<CheckpointerLoadOpts | undefined, string>;
      try {
        parsedLoadOpts = parseLoadOpts(loadOpts);
      } catch (error) {
        return err(
          checkpointerCacheError("load", `load could not inspect options: ${messageOf(error)}`),
        );
      }
      if (!parsedLoadOpts.ok) {
        return err(checkpointerCacheError("load", `load rejected: ${parsedLoadOpts.error}`));
      }
      const expectedDagFingerprint = parsedLoadOpts.value?.expectedDagFingerprint;

      const run = __brandRunId(runId);
      let runDirectory: VerifiedDirectory;
      let rawMeta: string;
      try {
        const verifiedRun = runDirectoryOf(runId, false);
        if (verifiedRun === null) return ok(null);
        runDirectory = verifiedRun;
        rawMeta = readFileSync(verifyExistingFile(runDirectory, META_FILE), "utf-8");
        assertDirectoryIdentity(runDirectory);
      } catch (error) {
        // Unknown run ⇒ clean `null`, never an error (US2). Anything else is a
        // real fs failure and must not masquerade as "no checkpoint". Errno
        // inspection is itself untrusted; a trapped getter becomes part of the
        // typed diagnostic instead of being erased or escaping raw.
        const codeProbe = probeErrorCode(error);
        if (codeProbe.kind === "code" && codeProbe.code === "ENOENT") return ok(null);
        return err(
          checkpointerCacheError(
            "load",
            `load failed to read ${META_FILE} for run ${render(runId)} under ${render(directory)}: ${safeErrorMessageWithCodeProbe(error, codeProbe)}`,
          ),
        );
      }

      const parsedMeta = parseStoredMeta(rawMeta);
      if (!parsedMeta.ok) {
        return err(
          frameworkError.checkpointCorrupt(run, `meta deserialize failed: ${parsedMeta.error}`),
        );
      }
      const { meta, createdAt } = parsedMeta.value;

      // ADR-0017 (FR-025): a checkpoint produced by a different framework
      // release may encode validation/retry/coercion semantics this release no
      // longer honours — replaying it would silently skip invariants.
      if (meta.frameworkVersion !== FRAMEWORK_VERSION) {
        return err(
          frameworkError.checkpointVersionMismatch(run, FRAMEWORK_VERSION, meta.frameworkVersion),
        );
      }

      // FR-026: opt-in structural gate. A re-shaped DAG would replay cached
      // outputs into a graph whose nodes no longer validate them, so an ABSENT
      // stored fingerprint is a mismatch too — not a pass.
      if (
        expectedDagFingerprint !== undefined &&
        meta.dagFingerprint !== expectedDagFingerprint
      ) {
        return err(
          frameworkError.checkpointVersionMismatch(
            run,
            expectedDagFingerprint,
            meta.dagFingerprint,
          ),
        );
      }

      // FR-027: lazy expiry — evaluated here, at read time, against the
      // injected clock. No sweeper, no physical GC in this pass.
      let nowMs: number;
      try {
        nowMs = now();
      } catch (error) {
        return err(
          checkpointerCacheError(
            "load",
            `load clock failed for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
          ),
        );
      }
      if (!Number.isFinite(nowMs) || !isValidDate(new Date(nowMs))) {
        return err(
          checkpointerCacheError(
            "load",
            `load clock returned a non-representable timestamp for run ${render(runId)}: ${render(nowMs)}`,
          ),
        );
      }
      if (nowMs - createdAt.getTime() > TTL_SECONDS * 1000) {
        return err(frameworkError.checkpointExpired(run, createdAt));
      }

      let nodesDirectory: VerifiedDirectory | null = null;
      let fileNames: readonly string[];
      try {
        nodesDirectory = verifyDirectory(
          join(runDirectory.path, NODES_DIR),
          runDirectory.path,
          false,
        );
        fileNames = nodesDirectory === null ? [] : readdirSync(nodesDirectory.path);
      } catch (error) {
        // No `nodes/` yet = a run with meta and no completed node. That is the
        // normal state right after `setMeta`, not a failure.
        const codeProbe = probeErrorCode(error);
        if (codeProbe.kind === "code" && codeProbe.code === "ENOENT") {
          fileNames = [];
        } else {
          return err(
            checkpointerCacheError(
              "load",
              `load failed to list ${NODES_DIR}/ for run ${render(runId)} under ${render(directory)}: ${safeErrorMessageWithCodeProbe(error, codeProbe)}`,
            ),
          );
        }
      }

      const nodes: Record<string, NodeState> = {};
      const corruptNodeIds: string[] = [];
      // Sorted so the corrupt-address ordering is deterministic across
      // platforms (readdir order is not specified).
      for (const fileName of [...fileNames].sort()) {
        // `.tmp.<unique-token>` crash litter (and anything else not claiming to be a
        // record) is invisible to the reader — that IS the tmp+rename
        // atomicity guarantee (FR-029), not a dropped entry.
        if (!fileName.endsWith(".json")) continue;

        let nodeText: string;
        try {
          if (nodesDirectory === null) {
            throw new Error("nodes directory disappeared after listing");
          }
          nodeText = readFileSync(verifyExistingFile(nodesDirectory, fileName), "utf-8");
          assertDirectoryIdentity(nodesDirectory);
          assertDirectoryIdentity(runDirectory);
        } catch (error) {
          // An unreadable path is an environment/I/O failure, not evidence
          // that persisted bytes are malformed. Never warn/drop it as a
          // corrupt node: the caller must see the failed load operation.
          return err(
            checkpointerCacheError(
              "load",
              `load failed to read node entry ${render(fileName)} for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
            ),
          );
        }

        let verdict: NodeEntryVerdict;
        try {
          verdict = parseNodeFile(fileName, nodeText);
        } catch (error) {
          // The pure parser returns a verdict for every expected malformed
          // byte shape. A throw is therefore an implementation defect and is
          // surfaced as a typed load failure, never mislabeled as corruption.
          return err(
            checkpointerCacheError(
              "load",
              `load hit an unexpected node parser failure for ${render(fileName)} in run ${render(runId)}: ${messageOf(error)}`,
            ),
          );
        }

        if (verdict.kind === "corrupt") {
          const warning =
            `[FileCheckpointer] Dropping corrupt checkpoint entry runId=${runId} nodeKey=${verdict.address}: ${verdict.message}`;
          try {
            fwLogger().warn(warning);
          } catch (error) {
            return err(
              checkpointerCacheError(
                "load",
                `load failed to emit the required corrupt-node warning for run ${render(runId)} nodeKey=${render(verdict.address)}: ${messageOf(error)}`,
              ),
            );
          }
          corruptNodeIds.push(verdict.address);
          continue;
        }
        // `defineProperty`, not `nodes[key] = …`: `__proto__` is an
        // ID_PATTERN-valid nodeId (`_` is in the charset), and plain assignment
        // would hit `Object.prototype`'s `__proto__` SETTER — re-parenting the
        // returned map instead of adding an entry, silently losing a stored
        // node with no `corruptNodeIds` trace. A data descriptor always creates
        // an OWN, enumerable property, so every stored address round-trips
        // (US2) and the in-memory backend's computed-key semantics are matched
        // exactly. The map keeps its ordinary prototype so callers comparing it
        // against a plain object literal are unaffected.
        Object.defineProperty(nodes, verdict.nodeKey, {
          value: verdict.state,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      return ok({
        meta,
        nodes,
        ...(corruptNodeIds.length > 0 ? { corruptNodeIds } : {}),
      });
    },
  };
};

/** Typed factory shell: configuration/runtime inspection never leaks raw. */
export const createFileCheckpointer = (
  directory: string,
  opts?: FileCheckpointerOptions,
): Checkpointer => {
  try {
    return createFileCheckpointerUnchecked(directory, opts);
  } catch (error) {
    throw fileOperationError(
      "createFileCheckpointer",
      "factory configuration",
      error,
    );
  }
};
