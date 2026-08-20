// createFileJob — the kernel's durable `JobLike` adapter over a FileJournal
// (FR-001/FR-003).
//
// `createFileJob({ directory, initial, now? })` exposes the full kernel surface —
// `data`, `updateData`, `updateProgress`, `appendEvent` — with the same
// semantics as the in-memory/Redis adapters, but durable: a journal under
// the caller-supplied directory that is fully recoverable in a fresh process
// from that directory alone (FR-003, US1).
//
// SINGLE-WRITER CONTRACT (ADR-0078) — documented on this public surface:
//
//   - ONE `JobLike` writer per run directory. Appends are serialized by the
//     per-directory lock across processes too, but the checkpoint/progress
//     projection writes are deliberately LOCK-FREE — two concurrent WRITERS
//     would race the projection, which is out of contract (the resume proof
//     backstops any violation, but the contract is one writer).
//   - ANY number of concurrent READERS — event files are immutable and read
//     without locks (`readFileEvents` / `readFileEventRecords`).
//   - Run-directory lifecycle (creation, deletion, retention, reaping) is
//     the consumer's concern — the backend performs no background or
//     out-of-band directory management (FR-044).
//
// `data` is the in-memory snapshot seeded with `initial` — pass the genesis
// `{ state, context }` on a fresh run, or the resumed state on a re-run
// (`resumeFileJob` reconstructs it; this adapter is deliberately
// resumption-free so the kernel contract stays byte-identical with the
// in-memory/Redis adapters). SNAPSHOT CONTRACT: each `data` read returns a
// DEEPLY IMMUTABLE CLONE (structuredClone + recursive freeze/read-only proxies), so caller
// mutation of a returned snapshot can never diverge the in-memory working
// copy from the durable journal — a later `updateData` always commits what
// the kernel actually produced, not what a caller scribbled on a stale copy.
// The kernel-compatible `data` type stays substitutable for `JobLike`; callers
// that need recursive static immutability use `readFileJobSnapshot(job)`.
//
// FAILURE SURFACE (ADR-0080): `JobLike` has no Result channel, so every rejected
// operation throws through its existing shell. That throwing channel is
// CLOSED: factory validation, snapshot cloning, caller-value parsing,
// serialization, clocks, locks, and filesystem failures all throw typed
// `FrameworkError` (`cache-error`, exact operation + path), never plain
// runtime exceptions. A failed append is NEVER swallowed — it
// must abort the transition so the retry re-derives it (append-before-
// checkpoint durability, FR-004/FR-005).
//
// Import discipline (INV-1): `node:path` is the only Node built-in used here.

import { join } from "node:path";
import type { JobLike } from "../state-machine/types.js";
import { createFileJournal } from "./journal.js";
import type { FileJournalOptions } from "./journal.js";
import { checkpointDataOf, serializeFileCheckpoint } from "./checkpoint-record.js";
import { deepFreeze } from "./deep-freeze.js";
import type { DeepReadonly } from "./deep-freeze.js";
import { CHECKPOINT_FILE, PROGRESS_FILE } from "./layout.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { fileOperationError } from "./boundary-error.js";
import { isFrameworkError } from "../types/errors.js";

export interface CreateFileJobArgs<S, C> extends FileJournalOptions {
  /** Run directory — the journal lives under it (see single-writer contract
   * in the module header). */
  readonly directory: string;
  /** Seed for the in-memory snapshot: genesis state on a fresh run, or the
   * resumed state on a re-run. */
  readonly initial: { state: S; context: C };
}

const fileJobBrand: unique symbol = Symbol("@fuguejs/framework/file-job");

/** File-backed adapter remains substitutable anywhere the kernel accepts `JobLike`. */
export interface FileJob<S, E = unknown, C = unknown> extends JobLike<S, E, C> {
  /** Nominal proof consumed by `readFileJobSnapshot`; not part of `JobLike`. */
  readonly [fileJobBrand]: true;
}

/** Recursively immutable view backed by the file job's deep-frozen data getter. */
export type FileJobSnapshot<S, C> = DeepReadonly<{
  readonly state: S;
  readonly context: C;
}>;

/**
 * Read a file job snapshot with its stronger recursive static contract.
 *
 * `FileJob.data` keeps the kernel's exact type for adapter substitutability;
 * this helper exposes the stronger runtime invariant without changing the port.
 */
export const readFileJobSnapshot = <S, E, C>(
  job: FileJob<S, E, C>,
): FileJobSnapshot<S, C> => job.data as FileJobSnapshot<S, C>;

// ---------------------------------------------------------------------------
// Snapshot immutability (see the snapshot contract in the module header)
// ---------------------------------------------------------------------------

// The recursive freeze primitive lives in `deep-freeze.ts` — ONE implementation
// shared with the strict event-log reader, so the two
// runtime-immutability promises cannot drift apart. Here it is always applied
// to a `structuredClone` output, a fresh tree a caller never shares with the
// snapshot; the shared module documents the reader-side source.

/**
 * Test-only: exposes the snapshot freeze primitive so the symbol-keyed
 * guarantee can be pinned directly. The FR-009 boundary rejects
 * symbol-keyed state at both the factory seed and `updateData`, so the
 * public `data` getter can never reach a symbol-keyed clone — the seam
 * exists only so a future snapshot source cannot silently weaken the
 * "fully immutable" contract without a test failing.
 */
export { deepFreeze as __testDeepFreeze };

/**
 * Construct the durable `JobLike<S, unknown, C>` over a file journal.
 *
 * - `get data()` — the current in-memory snapshot (seeded with `initial`),
 *   returned as a DEEP-FROZEN CLONE (see the snapshot contract in the module
 *   header): caller mutation can never diverge the snapshot, and every read
 *   is an independent object.
 * - `updateData(d)` — writes `{ schemaVersion: 1, data: d }` to
 *   `checkpoint.json` atomically (tmp+rename, FR-006), then advances the
 *   snapshot; a failed write leaves the snapshot unchanged. The payload
 *   crosses the FR-009 write boundary exactly like an event
 *   (`assertLosslessEvent` pre-scan + round-trip verification — see
 *   `serializeFileCheckpoint`), so a function-valued/BigInt/cyclic/non-finite
 *   state or context throws typed `cache-error(updateData)` naming the
 *   checkpoint path instead of being silently dropped or leaking an engine
 *   exception.
 * - `updateProgress(pct)` — writes `{ percent }` to `progress.json`
 *   atomically (FR-007).
 * - `appendEvent(event, dedupKey?)` — durable append under the per-directory
 *   lock; keyed re-derivations land as no-ops (FR-004, SC-003).
 *
 * This unchecked body throws raw diagnostics where the typed boundary is the
 * public `createFileJob` shell: factory-validation rejections are raw strings
 * and every other runtime/infrastructure rejection crosses to the shell, which
 * is the ADR-0080 boundary converting each to typed `FrameworkError`
 * (`cache-error`, operation + path in the message).
 */
const createFileJobUnchecked = <S, C>(args: CreateFileJobArgs<S, C>): FileJob<S, unknown, C> => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new TypeError("createFileJob arguments must be an object");
  }
  const directory = args.directory;
  const initial = args.initial;
  const configuredNow = args.now;
  if (typeof initial !== "object" || initial === null || Array.isArray(initial)) {
    throw new TypeError("createFileJob initial must be an object with state and context");
  }
  // Parse the seed through the same lossless codec used by updateData. The
  // returned snapshot is reconstructed from the exact canonical bytes and is
  // therefore detached from caller-owned state/context before the factory
  // returns.
  const initialCommit = serializeFileCheckpoint({
    state: initial.state,
    context: initial.context,
  });
  const initialSnapshot = checkpointDataOf(initialCommit);
  const journal = createFileJournal(
    directory,
    configuredNow !== undefined ? { now: configuredNow } : {},
  );

  // In-memory snapshot — genesis (or resumed) state, advanced only after the
  // projection is durably committed. The `data` getter exposes a deep-frozen
  // CLONE (see the snapshot contract in the module header), so this working
  // copy stays mutable for `updateData` while callers can never mutate it
  // through the returned value.
  let snapshot: { state: S; context: C } = initialSnapshot;

  return {
    [fileJobBrand]: true,

    /**
     * Deeply immutable CLONE of the snapshot per read: caller mutation can
     * never diverge the snapshot. Plain objects/arrays are frozen; Map/Set/Date
     * use read-only proxies because Object.freeze cannot protect their internal
     * slots. The
     * `readFileJobSnapshot` makes the recursive immutability invariant visible
     * at the file-specific type surface; the kernel-facing getter retains the
     * exact `JobLike` shape for substitutability.
     */
    get data(): { readonly state: S; readonly context: C } {
      try {
        return deepFreeze(structuredClone(snapshot)) as {
          readonly state: S;
          readonly context: C;
        };
      } catch (error) {
        // structuredClone cannot clone functions/symbols — state that is
        // non-durable by FR-009 anyway; name the contract instead of leaking
        // a raw DataCloneError.
        throw fileOperationError(
          "data",
          `run directory ${directory}`,
          `snapshot cannot be cloned — ${safeErrorMessage(error)} (FR-009: state/context must be losslessly serializable)`,
        );
      }
    },

    /**
     * Durable checkpoint: commit `{ schemaVersion: 1, data: { state, context } }`
     * to `checkpoint.json` FIRST, then advance the in-memory snapshot. A crash
     * between `appendEvent` and here is the benign append-before-checkpoint
     * window (FR-004/FR-005) — the event log is authoritative and the retry
     * re-derives the same dedupKey as a no-op.
     *
     * The checkpoint payload crosses the FR-009 write boundary exactly like
     * an event (`serializeFileCheckpoint`): `assertLosslessEvent` pre-scan +
     * round-trip verification. Every rejection is typed
     * `cache-error(updateData)` with checkpoint-path context.
     */
    async updateData(d: { state: S; context: C }): Promise<void> {
      try {
        if (typeof d !== "object" || d === null || Array.isArray(d)) {
          throw new TypeError("checkpoint data must be an object with state and context");
        }
        const captured = {
          state: d.state,
          context: d.context,
        };
        // Mint both the opaque bytes and detached snapshot synchronously,
        // before the first await. Later caller mutation cannot affect either
        // the in-flight commit or the snapshot installed after it succeeds.
        const commit = serializeFileCheckpoint(captured);
        await journal.writeCheckpoint(commit);
        snapshot = checkpointDataOf(commit);
      } catch (error) {
        throw fileOperationError("updateData", join(directory, CHECKPOINT_FILE), error);
      }
    },

    async updateProgress(pct: number): Promise<void> {
      try {
        await journal.writeProgress(pct);
      } catch (error) {
        throw fileOperationError("updateProgress", join(directory, PROGRESS_FILE), error);
      }
    },

    async appendEvent(event: unknown, dedupKey?: string): Promise<void> {
      try {
        await journal.appendEvent(event, dedupKey);
      } catch (error) {
        // Every journal `appendEvent` throw is already a typed
        // cache-error(appendEvent) with this SAME operation and location
        // (fsFailure in journal.ts) and its failureClass already inferred
        // from the inner typed value — re-wrapping here only double-nests
        // the diagnostic ("appendEvent failed at run directory D: cache
        // appendEvent failed at run directory D: …"). This includes the
        // FR-015 "|"-key rejection: its message already carries the
        // computeDedupKey fix hint and the permanent class, so a dedicated
        // rewrap would only double-nest it. Let the typed error ride
        // through unchanged; wrap only an unexpected raw throw so the
        // JobLike port's never-raw contract (ADR-0080) stays total.
        if (isFrameworkError(error)) throw error;
        throw fileOperationError("appendEvent", `run directory ${directory}`, error);
      }
    },
  };
};

/**
 * Typed factory shell: converts the unchecked body's raw factory-validation
 * and runtime rejections into typed `FrameworkError` values
 * (`cache-error`, operation + path in the message, ADR-0080) before any rejection
 * leaks — constructing a file JobLike never permits a raw throw.
 */
export const createFileJob = <S, C>(args: CreateFileJobArgs<S, C>): FileJob<S, unknown, C> => {
  try {
    return createFileJobUnchecked(args);
  } catch (error) {
    throw fileOperationError("createFileJob", "factory configuration", error);
  }
};
