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
// safety against a process concurrently renaming filesystem entries. That
// containment policy lives in `verified-directory.ts`; the pure stored-schema
// codecs (meta/node serialization, options parsing, output canonicalization)
// live in `checkpointer-codec.ts`. This module is the thin filesystem shell:
// directory resolution, atomic writes, and typed error mapping only (A8).
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

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { META_FILE, NODES_DIR, TTL_SECONDS, isBoundaryId, keyDigest } from "./layout.js";
import {
  isPlainObject,
  isValidDate,
  parseLoadOpts,
  parseNodeFile,
  parseStoredMeta,
  saveNodeBoundaryViolation,
  serializeMeta,
  serializeNode,
  snapshotMeta,
  snapshotNodeState,
  snapshotSaveNodeOpts,
  writeFailed,
  type NodeEntryVerdict,
  type RawMetaSnapshot,
  type RawNodeSnapshot,
  type RawSaveNodeOptsSnapshot,
} from "./checkpointer-codec.js";
import {
  assertDirectoryIdentity,
  verifyDirectory,
  verifyExistingFile,
  type VerifiedDirectory,
} from "./verified-directory.js";
import type {
  Checkpointer,
  CheckpointerLoadOpts,
  NodeState,
  RunMeta,
  RunState,
  SaveNodeOpts,
} from "../checkpoint/checkpointer.js";
import { compositeNodeKey } from "../checkpoint/composite-node-key.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId } from "../types/ids.js";
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

/** Source-compatibility re-export: the metadata diagnostic constant lives
 * with the codec that constructs the write-failed values (A8). The barrel
 * (`src/file.ts`) and existing classification consumers import it from this
 * module. */
export { META_RECORD_NODE_ID } from "./checkpointer-codec.js";

/** Compact, total rendering for shell-side diagnostics (FR-040). The codec
 * module owns the aliases used inside strict parsers; the shell needs its own
 * copies for directory/clock/filesystem messages. */
const render = safeDiagnosticRender;
const messageOf = safeErrorMessage;

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
  failureClass?: "transient" | "permanent",
): FrameworkError => fileCacheError(operation, message, failureClass);

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
        // Deterministic: a throwing injected clock fails identically on every
        // retry — pin "permanent" like the other code-constructed rejections.
        return err(
          checkpointerCacheError(
            "setMeta",
            `setMeta clock failed for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
            "permanent",
          ),
        );
      }
      if (!Number.isFinite(createdAtMs) || !isValidDate(new Date(createdAtMs))) {
        return err(
          checkpointerCacheError(
            "setMeta",
            `setMeta clock returned a non-representable timestamp for run ${render(runId)}: ${render(createdAtMs)}`,
            "permanent",
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
        // Deterministic: a throwing injected clock fails identically on every
        // retry — pin "permanent" like the other code-constructed rejections.
        return err(
          checkpointerCacheError(
            "load",
            `load clock failed for run ${render(runId)} under ${render(directory)}: ${messageOf(error)}`,
            "permanent",
          ),
        );
      }
      if (!Number.isFinite(nowMs) || !isValidDate(new Date(nowMs))) {
        return err(
          checkpointerCacheError(
            "load",
            `load clock returned a non-representable timestamp for run ${render(runId)}: ${render(nowMs)}`,
            "permanent",
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
