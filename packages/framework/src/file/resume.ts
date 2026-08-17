// resumeFileJob — strict filesystem acquisition + delegation to the pure ADR-0077
// agreement proof (`@fuguejs/framework/file`).
//
// The event log is the single authoritative record of a run's history; the
// checkpoint is a projection that a crash may legitimately leave behind. The
// agreement proof itself — full pure replay, checkpoint envelope decode, and
// the full-agreement / strict-prefix-lag / disagreement verdicts — is a
// coherent PURE algorithm (no I/O, no executor, no side effects,
// FR-011/NFR-002) and lives in `resume-proof.ts` (`proveResumeAgreement`):
// it takes the acquired log + raw checkpoint JSON + machine + genesis + the
// caller's strict decoder and returns a `Result`. THIS module is the thin
// filesystem shell: it acquires the two durable representations, applies the
// FR-014 recoverable-state gate, and delegates. See `resume-proof.ts` for
// the proof's algorithm (ADR-0077) and totality discipline; this header keeps
// the shell's own contract.
//
// The shell's job, exactly:
//
//   0. Re-validate the caller's `runId` boundary (ID_PATTERN — the backend's
//      re-validate-bypassed-brands discipline, `load` gates the same way):
//      an out-of-domain id ⇒ typed `cache-error`, never a branded field that
//      would fail the pattern, never a path addressed outside `directory`.
//   1. Read the AUTHORITATIVE representation — the event log — through the
//      shared strict reader (`readFileEvents`, FR-009). A missing events
//      directory reads as an EMPTY log (`ok([])`); any corrupt record,
//      sequence break, or filename mismatch fails closed here with the file
//      named in the message (ADR-0077 step 1). Every reader failure is
//      re-tagged `checkpoint-corrupt` per ADR-0080 (below): the log cannot be
//      proven ⇒ fail closed.
//   2. Read the checkpoint PROJECTION (raw JSON — decoding is the proof's
//      job; a missing file is `null`). `readCheckpoint` THROWS a typed
//      `FrameworkError` (`cache-error`) on genuine fs failure (the `JobLike`
//      port contract, ADR-0080); that typed value is propagated unchanged — an
//      unreadable checkpoint file is an environment failure, not a content
//      verdict. The catch narrows before relabeling (FR-040): ONLY a value
//      the runtime guard recognizes as a typed `FrameworkError` rides
//      through unchanged; any other throw (a hostile or version-drifted
//      journal implementation is NOT assumed to keep the typed contract) is
//      re-tagged `checkpoint-corrupt` — never smuggled across the boundary
//      as typed.
//   3. No recoverable state (FR-014): no event files AND no checkpoint.json
//      — a missing or empty run directory. `checkpoint-missing`, never a
//      silent fresh start. (A checkpoint alone, or events alone, IS
//      recoverable state — the proof proceeds.)
//   4. Delegate the agreement proof to `proveResumeAgreement`
//      (`resume-proof.ts`): full replay through the pure machine; raw-JSON +
//      complete canonical serializer-grammar + closed-field-set +
//      schemaVersion envelope decode; the caller's strict `parseCheckpoint`;
//      state-key agreement ⇒ resume from the replay; otherwise a single-pass
//      strict-prefix scan ⇒ benign lag ⇒ resume from the replay; otherwise
//      `checkpoint-corrupt` naming `checkpoint <key> vs replay <key>`.
//
// The returned state is ALWAYS the pure replay of the authoritative event
// log (`replayed`) whenever the run is resumable: the checkpoint is a
// projection that may lag or be absent, and even when it agrees, the log is
// the source of the resumed state (FR-010). Terminal-failed states are
// never checkpointed (kernel FR-005 discipline, preserved unchanged: a
// failed transition appends nothing and checkpoints nothing), so the
// fingerprint of the failed state appears in no prefix replay — the proof
// rejects a manufactured failed-state checkpoint against the log, and a real
// crash can never leave one behind (FR-012).
//
// Failure surface (ADR-0080): `resumeFileJob` returns `checkpoint-missing` (no
// recoverable state) and `checkpoint-corrupt` (strict-read failure, broken
// sequence, checkpoint decode failure, machine/decoder throw, disagreement —
// message names the file + reason), or propagates the journal's typed
// `cache-error` unchanged when `checkpoint.json` itself is unreadable. Two
// honest notes on the ADR-0080 mapping:
//
//   - The strict reader (`readFileEventRecords`/`readFileEvents`) reports its
//     failures through one `Result` channel tagged `cache-error` — both
//     record corruption AND genuine fs read failures (EACCES/ENOTDIR...).
//     ADR-0080's surface for resume has no `cache-error` row, and a log that
//     cannot be strictly read cannot prove anything: every reader failure is
//     re-tagged `checkpoint-corrupt` with the reader's failure preserved as
//     the `message` field inside the JSON-serialized `cache-error` value
//     (kind/operation/message — so the file and reason survive, plus the
//     operation context; the bare message string is not what rides through).
//   - The pure machine is NOT trusted to be throw-free on hostile-but-
//     codec-valid input — that guard is the proof module's job (every
//     machine/decoder callback seam, FR-040); this shell additionally maps
//     any residue through `fileOperationError` — `resumeFileJob` never
//     rejects with a raw untyped error (FR-040: nothing throws across the
//     port boundary).
//
// This module performs no I/O beyond the two reads above and never writes:
// resume is side-effect-free (a fresh-process resume cannot perturb the
// journal it is proving).
//
// Import discipline (INV-1): no node built-ins — every path join lives in
// `resume-proof.ts` (which documents its own `node:path` dependency).

import { readFileEvents } from "./event-log.js";
import { createFileJournal } from "./journal.js";
import { proveResumeAgreement } from "./resume-proof.js";
import { isBoundaryId } from "./layout.js";
import type { Machine } from "../state-machine/types.js";
import type { RunId } from "../types/ids.js";
import { ID_PATTERN } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError, messageOf } from "../types/errors.js";
import { frameworkError } from "../types/error-factories.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";
import { fileCacheError, fileOperationError } from "./boundary-error.js";

export interface ResumeFileJobArgs<S, E, C> {
  /** Run identity, carried on every typed error (`checkpoint-missing` /
   * `checkpoint-corrupt` include it as a field; the disagreement message
   * names it too). */
  readonly runId: RunId;
  /** Run directory — the journal (`events/`, `checkpoint.json`) lives under
   * it (see the ADR-0078 single-writer contract on `createFileJob`). */
  readonly directory: string;
  /** The pure state machine the log is folded through — replay must
   * reconstruct the identical state the original run reached (FR-011). The
   * executor is NEVER consulted. */
  readonly machine: Machine<S, E, C>;
  /** The run's genesis data — the empty-prefix state of the proof (ADR-0077
   * step 7 includes the empty prefix = genesis as benign lag). */
  readonly genesis: { state: S; context: C };
  /**
   * The caller's strict decoder for the checkpoint's `data` payload
   * (`{ state, context }` — the envelope's schemaVersion gate is this
   * module's job; the payload shape is the caller's domain). Returns
   * `Err<string>` with a message that surfaces inside the typed
   * `checkpoint-corrupt` (naming `checkpoint.json`), so a decoder that
   * started rejecting a shape it used to accept fails resume loudly instead
   * of silently resuming from a mistyped state.
   *
   * The decoder is ALSO not trusted to be throw-free (FR-040): validation
   * must precede any destructuring/dereferencing, but a production decoder
   * that forgets that discipline throws a raw `TypeError` on
   * hostile-but-envelope-valid payloads (e.g. `data` deserialized from
   * `{"__undefined__":true}` is a REAL `undefined`; `data: 42`; `[1,2,3]`;
   * `null`). A THROW is caught in the proof too — re-tagged
   * `checkpoint-corrupt` naming `checkpoint.json` and the decoder's error —
   * never a raw untyped promise rejection.
   */
  readonly parseCheckpoint: (data: unknown) => Result<{ state: S; context: C }, string>;
}

/**
 * Reconstruct the state a run must resume from, proving the durable
 * representations agree (ADR-0077) — see `resume-proof.ts` for the proof
 * algorithm and this module's header for the acquisition contract.
 *
 * The returned state is ALWAYS the pure replay of the authoritative event
 * log (`replayed`) whenever the run is resumable: the checkpoint is a
 * projection that may lag or be absent, and even when it agrees, the log is
 * the source of the resumed state (FR-010). `Err` values are typed
 * `FrameworkError`: `checkpoint-missing` (no recoverable state — never a
 * silent fresh start, FR-014) or `checkpoint-corrupt` (strict read failure /
 * broken sequence / checkpoint decode failure / machine OR CALLER-DECODER
 * throw during replay, state-key comparison, or payload decode /
 * disagreement — the message names the file and reason, FR-009/FR-010). An
 * unreadable `checkpoint.json` (fs failure) is propagated unchanged as the
 * journal's typed `cache-error` (ADR-0080).
 *
 * Never re-invokes the executor and performs no side effects (FR-011).
 */
const resumeFileJobUnchecked = async <S, E, C>(
  args: ResumeFileJobArgs<S, E, C>,
): Promise<Result<{ state: S; context: C }, FrameworkError>> => {
  const { runId, directory, machine, genesis, parseCheckpoint } = args;

  // 0. Boundary re-validation of the caller's `runId` — bypassed brands are
  //    re-checked (the backend's documented discipline; `Checkpointer.load`
  //    gates the same way): an id outside `ID_PATTERN` would address a path
  //    outside `directory`, and there is no run to call missing or corrupt,
  //    so `cache-error` is the honest kind — the typed error must never
  //    brand a value that would fail the pattern (truthful branding). The
  //    value is constructed through `fileCacheError` so the operation name
  //    stays inside the closed FileOperation vocabulary (SC-006).
  if (!isBoundaryId(runId)) {
    return err(
      fileCacheError(
        "resumeFileJob",
        `resumeFileJob rejected: runId ${safeDiagnosticRender(runId)} does not match ${ID_PATTERN.source} — refusing to address a path outside ${safeDiagnosticRender(directory)}`,
      ),
    );
  }

  // 1. Read the AUTHORITATIVE representation — the event log — through the
  //    shared strict reader (FR-009). A missing events directory reads as an
  //    EMPTY log (`ok([])`); any corrupt record, sequence break, or filename
  //    mismatch fails closed here with the file named in the message (ADR-0077
  //    step 1). Every reader failure is re-tagged `checkpoint-corrupt` per
  //    ADR-0080 (see the module header): the log cannot be proven ⇒ fail closed.
  const events = readFileEvents(directory);
  if (!events.ok) {
    // `messageOf` narrows: some `FrameworkError` variants (e.g.
    // `checkpoint-missing`) carry no `message` field. The reader's message —
    // which names the offending file and reason — must ride inside
    // `checkpoint-corrupt`.
    return err(frameworkError.checkpointCorrupt(runId, messageOf(events.error)));
  }

  // 2. Read the checkpoint PROJECTION (raw JSON — decoding is the proof's
  //    job; a missing file is `null`). `readCheckpoint` throws a typed
  //    `FrameworkError` (`cache-error`) on genuine fs failure — that typed
  //    value is propagated unchanged: an unreadable checkpoint file is an
  //    environment failure, not a corruption verdict. The catch narrows
  //    before relabeling (FR-040): ONLY a value the runtime guard
  //    recognizes as a typed `FrameworkError` rides through unchanged; any
  //    other throw (a hostile or version-drifted journal implementation is
  //    NOT assumed to keep the typed contract) is re-tagged
  //    `checkpoint-corrupt` — never smuggled across the boundary as typed.
  let checkpointJson: string | null;
  try {
    checkpointJson = createFileJournal(directory).readCheckpoint();
  } catch (error) {
    if (isFrameworkError(error)) return err(error);
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `readCheckpoint threw a non-FrameworkError: ${safeErrorMessage(error)}`,
      ),
    );
  }

  // 3. No recoverable state (FR-014): no event files AND no checkpoint.json
  //    — a missing or empty run directory. `checkpoint-missing`, never a
  //    silent fresh start. (A checkpoint alone, or events alone, IS
  //    recoverable state — the proof proceeds.)
  if (events.value.length === 0 && checkpointJson === null) {
    return err(frameworkError.checkpointMissing(runId));
  }

  // 4. Delegate the pure ADR-0077 agreement proof (`resume-proof.ts`): what
  //    remains is decideable from the acquired representations alone — full
  //    replay through the pure machine, checkpoint envelope decode, the
  //    caller's strict `parseCheckpoint`, full-agreement / strict-prefix
  //    benign-lag / disagreement verdicts. Every machine/decoder callback
  //    seam inside is totally guarded (FR-040).
  return proveResumeAgreement({
    runId,
    directory,
    events: events.value,
    checkpointJson,
    machine,
    genesis,
    parseCheckpoint,
  });
};

/** Result-bearing public shell: no hostile argument or runtime throw rejects. */
export const resumeFileJob = async <S, E, C>(
  args: ResumeFileJobArgs<S, E, C>,
): Promise<Result<{ state: S; context: C }, FrameworkError>> => {
  try {
    return await resumeFileJobUnchecked(args);
  } catch (error) {
    return err(fileOperationError("resumeFileJob", "resume boundary", error));
  }
};
