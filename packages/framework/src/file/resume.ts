// resumeFileJob — log-authoritative state reconstruction + the AD-3
// agreement proof (`@fuguejs/framework/file`).
//
// The event log is the single authoritative record of a run's history; the
// checkpoint is a projection that a crash may legitimately leave behind. This
// module reconstructs the state a run must resume from by folding the log
// through the PURE machine (`replayEvents` — the executor is never re-invoked
// and no side effect ever runs, FR-011/NFR-002), then PROVES the stored
// checkpoint agrees with the log before returning. The proof (AD-3):
//
//   1. No recoverable state — no event files AND no checkpoint.json (missing
//      or empty run directory) ⇒ `checkpoint-missing` (FR-014): never a
//      silent fresh start.
//   2. Every event record is strictly validated by the shared reader
//      (`readFileEvents`, FR-009): schemaVersion, non-negative integer
//      sequence, finite recordedAtMs, FR-015 dedupKey charset, filename
//      prefix ↔ content sequence, strictly contiguous sequences, filename
//      digest ↔ content recompute. ANY violation fails closed with
//      `checkpoint-corrupt`, the reader's message naming the offending file.
//      The event log is authoritative, so a corrupt entry is never silently
//      dropped mid-log.
//   3. Full replay through the pure machine ⇒ `replayed`. No checkpoint.json
//      ⇒ resume from `replayed` (the benign crash-before-first-checkpoint
//      case — the log alone proves state).
//   4. Decode the checkpoint envelope (raw-JSON parse + the shared complete
//      canonical serializer-grammar gate, parity with the strict record
//      codec's `tryParseEventRecordJson` seam, + object-shape gate + closed
//      top-level-field-set gate + JOURNAL_SCHEMA_VERSION gate + the
//      caller's strict `parseCheckpoint` on the data payload — changes at
//      the checkpointer call site fail closed loudly) and compare state
//      keys: `machine.stateKey(checkpoint.state) ===
//      machine.stateKey(replayed.state)` ⇒ agreement, resume from
//      `replayed` (the log, not the projection, is the resumed state —
//      FR-010).
//   5. Otherwise, one additional O(n) pass folds the log while comparing each
//      intermediate state key to the checkpoint key. If the checkpoint
//      equals the replay of ANY strict prefix of the log (including the
//      empty prefix = genesis) ⇒ benign lag — the kernel's
//      append-before-checkpoint window (runner FR-005) — ⇒ resume from
//      `replayed`. The single-pass formulation is semantically identical to
//      Loom's proven `resumeProgram` (which re-replays prefixes — O(n²) on
//      the disagree path, i.e. on every crash-window resume) but runs the
//      lag test once per transition, O(n). A checkpoint matching any strict
//      prefix is by definition a state the run genuinely occupied —
//      accepting it never masks corruption, because the log alone determines
//      the resumed state.
//   6. Otherwise the checkpoint disagrees with every state the log provably
//      passed through ⇒ corruption ⇒ fail closed: `checkpoint-corrupt` with
//      a message naming `checkpoint <key> vs replay <key>` (plus runId) —
//      precise enough to diagnose the disagreement (FR-010).
//
// Terminal-failed states are never checkpointed (kernel FR-005 discipline,
// preserved unchanged: a failed transition appends nothing and checkpoints
// nothing), so the fingerprint of the failed state appears in no prefix
// replay — the proof above rejects a manufactured failed-state checkpoint
// against the log, and a real crash can never leave one behind (FR-012).
//
// Failure surface (AD-6): `resumeFileJob` returns `checkpoint-missing` (no
// recoverable state) and `checkpoint-corrupt` (strict-read failure, broken
// sequence, checkpoint decode failure, disagreement — message names the file
// + reason). Two honest notes on the AD-6 mapping:
//
//   - The strict reader (`readFileEventRecords`/`readFileEvents`) reports its
//     failures through one `Result` channel tagged `cache-error` — both
//     record corruption AND genuine fs read failures (EACCES/ENOTDIR...).
//     AD-6's surface for resume has no `cache-error` row, and a log that
//     cannot be strictly read cannot prove anything: every reader failure is
//     re-tagged `checkpoint-corrupt` with the reader's message preserved
//     verbatim (it already names the file and the reason, and distinguishes
//     corruption from I/O by its text).
//   - `journal.readCheckpoint()` THROWS a typed `FrameworkError` on fs
//     failure (the `JobLike` port contract, AD-6); that typed value is
//     propagated unchanged — an unreadable checkpoint file is an environment
//     failure, not a content verdict.
//   - The pure machine is NOT trusted to be throw-free on hostile-but-
//     codec-valid input: the strict reader validates only the record
//     ENVELOPE (schemaVersion, sequence, recordedAtMs, dedupKey charset,
//     filename digest), never the event payloads' shape or the checkpoint
//     STATE's shape — so a hostile or version-drifted payload/state can
//     still make `machine.transition` or `machine.stateKey` throw (a
//     matched ts-pattern arm derefs a missing field; `.exhaustive()` raises
//     `NonExhaustiveError` on an unknown variant). The caller's strict
//     `parseCheckpoint` is in the same untrusted class: the envelope gates
//     validate only `data`'s BAGINESS (the key exists — `"data" in record`
//     passes when the payload deserializes to `undefined`, `42`, `[1,2,3]`
//     or `null`), never its shape, so a decoder that destructures/derefs
//     BEFORE validating throws a raw `TypeError` ("Cannot destructure
//     property 'state' of 'undefined'") on hostile-but-envelope-valid
//     payloads. EVERY such throw — machine, decoder, or an unexpected decoder
//     implementation failure after canonical grammar validation — is re-tagged
//     `checkpoint-corrupt` naming the replay/scan step or `checkpoint.json` —
//     `resumeFileJob` never rejects
//     with a raw untyped error (FR-040: nothing throws across the port
//     boundary).
//
// This module performs no I/O beyond the two reads above and never writes:
// resume is side-effect-free (a fresh-process resume cannot perturb the
// journal it is proving).
//
// Import discipline (INV-1): `node:path` only among node built-ins.

import { join } from "node:path";
import { CHECKPOINT_FILE, EVENTS_DIR, JOURNAL_SCHEMA_VERSION } from "./layout.js";
import { readFileEvents } from "./event-log.js";
import { createFileJournal } from "./journal.js";
import { MAX_SAFE_RECORD_DEPTH } from "./event-record.js";
import { replayEvents, foldStep } from "../state-machine/replay.js";
import {
  deserializeValue,
  validateSerializedValueGrammar,
} from "../state-machine/serialize.js";
import type { Machine } from "../state-machine/types.js";
import type { RunId } from "../types/ids.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError, messageOf } from "../types/errors.js";
import { frameworkError } from "../types/error-factories.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";
import { fileOperationError } from "./boundary-error.js";

/** Extract a diagnostic message from any `FrameworkError` — some variants
 * (e.g. `checkpoint-missing`) carry no `message` field, so the access is
 * narrowed rather than assumed. Used where a reader error's message (which
 * names the offending file and reason) must ride inside `checkpoint-corrupt`. */
const errorMessageOf = (error: FrameworkError): string => messageOf(error);

/**
 * Total mapper for every untrusted resume callback/decode seam. Unlike the
 * generic exception wrappers, this never uses `instanceof`, `String(thrown)`,
 * or an unguarded `.message` read: arbitrary JavaScript thrown values are rendered
 * only by `safeErrorMessage` and retain the seam's checkpoint/replay context.
 */
const guardCheckpointCorrupt = <T>(
  runId: RunId,
  source: string,
  callback: () => T,
): Result<T, FrameworkError> => {
  try {
    return ok(callback());
  } catch (thrown) {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${source}: ${safeErrorMessage(thrown)} (FR-040)`,
      ),
    );
  }
};

/** Parse the machine's runtime return into the promised string key. Callback
 * invocation, machine-property access, state access, and hostile return-value
 * rendering all stay inside total guards. */
const guardedStateKey = (
  runId: RunId,
  source: string,
  callback: () => unknown,
): Result<string, FrameworkError> => {
  const attempted = guardCheckpointCorrupt(
    runId,
    `${source}: machine.stateKey threw`,
    callback,
  );
  if (!attempted.ok) return attempted;
  if (typeof attempted.value !== "string") {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${source}: machine.stateKey returned a non-string state key ${safeDiagnosticRender(attempted.value)} (FR-040)`,
      ),
    );
  }
  return ok(attempted.value);
};

/** State keys are runtime callback output. Preserve valid string keys verbatim
 * for actionable agreement diagnostics; render off-contract values totally. */
const renderStateKey = (key: unknown): string =>
  typeof key === "string" ? key : safeDiagnosticRender(key);

export interface ResumeFileJobArgs<S, E, C> {
  /** Run identity, carried on every typed error (`checkpoint-missing` /
   * `checkpoint-corrupt` include it as a field; the disagreement message
   * names it too). */
  readonly runId: RunId;
  /** Run directory — the journal (`events/`, `checkpoint.json`) lives under
   * it (see the AD-4 single-writer contract on `createFileJob`). */
  readonly directory: string;
  /** The pure state machine the log is folded through — replay must
   * reconstruct the identical state the original run reached (FR-011). The
   * executor is NEVER consulted. */
  readonly machine: Machine<S, E, C>;
  /** The run's genesis data — the empty-prefix state of the proof (AD-3
   * step 5 includes the empty prefix = genesis as benign lag). */
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
   * `null`). A THROW is caught here too — re-tagged `checkpoint-corrupt`
   * naming `checkpoint.json` and the decoder's error — never a raw untyped
   * promise rejection.
   */
  readonly parseCheckpoint: (data: unknown) => Result<{ state: S; context: C }, string>;
}

/**
 * Reconstruct the state a run must resume from, proving the durable
 * representations agree (AD-3) — see the module header for the algorithm and
 * the failure surface.
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
 * journal's typed `cache-error` (AD-6).
 *
 * Never re-invokes the executor and performs no side effects (FR-011).
 */
const resumeFileJobUnchecked = async <S, E, C>(
  args: ResumeFileJobArgs<S, E, C>,
): Promise<Result<{ state: S; context: C }, FrameworkError>> => {
  const { runId, directory, machine, genesis, parseCheckpoint } = args;

  // 1. Read the AUTHORITATIVE representation — the event log — through the
  //    shared strict reader (FR-009). A missing events directory reads as an
  //    EMPTY log (`ok([])`); any corrupt record, sequence break, or filename
  //    mismatch fails closed here with the file named in the message (AD-3
  //    step 2). Every reader failure is re-tagged `checkpoint-corrupt` per
  //    AD-6 (see the module header): the log cannot be proven ⇒ fail closed.
  const events = readFileEvents(directory);
  if (!events.ok) {
    return err(frameworkError.checkpointCorrupt(runId, errorMessageOf(events.error)));
  }

  // 2. Read the checkpoint PROJECTION (raw JSON — decoding is step 4's job;
  //    a missing file is `null`). `readCheckpoint` throws a typed
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

  // 4. Full replay through the PURE machine (FR-011): one fold of the log,
  //    never the executor. This is the state every resumable outcome returns.
  //
  //    GUARDED (FR-040): the strict reader validated only the record
  //    ENVELOPE — a codec-valid but hostile or version-drifted event
  //    payload can make `machine.transition` throw inside the fold (e.g.
  //    `TypeError: undefined is not iterable` iterating a missing field
  //    inside a matched ts-pattern arm; `P._` catch-alls absorb only unknown
  //    event TYPES, not malformed payloads). A raw throw would reject
  //    `resumeFileJob` with an untyped error; ANY throw is re-tagged
  //    `checkpoint-corrupt` naming the replay step and the events directory.
  const replayResult = guardCheckpointCorrupt(
    runId,
    `${join(directory, EVENTS_DIR)}: machine.transition threw while replaying the event log (shared fold)`,
    () => replayEvents(events.value, machine, genesis),
  );
  if (!replayResult.ok) return replayResult;
  const replayed = replayResult.value;

  // 5. No checkpoint ⇒ resume from the replay: the benign
  //    crash-before-first-checkpoint window — the log alone proves state.
  if (checkpointJson === null) return ok(replayed);

  // 6. Decode the checkpoint envelope. The framework-owned parts are this
  //    module's gate (raw-JSON parse, complete canonical serializer-grammar
  //    validation, object shape, closed top-level field set, schemaVersion —
  //    fail-closed parity with the strict record codec); the domain payload
  //    `data` is the caller's strict `parseCheckpoint`. ANY failure is
  //    `checkpoint-corrupt` naming `checkpoint.json` (AD-6: "checkpoint
  //    decode failure").
  //
  //    GUARDED (FR-040): the caller's decoder is NOT trusted to be
  //    throw-free — the envelope gates validated only `data`'s BAGINESS
  //    (`"data" in record` passes when the payload is a deserialized
  //    `undefined` / `42` / `[1,2,3]` / `null`), never its shape, and a
  //    decoder that destructures/derefs before validating throws a raw
  //    `TypeError` on such payloads. The call runs inside the shared total
  //    guard — a throw becomes `checkpoint-corrupt` naming
  //    `checkpoint.json` and the decoder's own error, never a raw untyped
  //    rejection. The shared grammar
  //    gate runs before `deserializeValue`, so expected malformed-tag,
  //    pollution-key, duplicate Map/Set, and excessive-depth failures never
  //    rely on the permissive decoder throwing.
  const checkpointPath = join(directory, CHECKPOINT_FILE);

  // Raw-JSON seam, identical to the strict record codec's ordering:
  // `JSON.parse` → validate the COMPLETE raw checkpoint with the shared exact
  // serializer grammar → `deserializeValue`. A weaker pollution-only scan is
  // deliberately not duplicated here. The shared iterative validator sees
  // every nested raw object before the decoder can reinterpret a reserved tag
  // or erase a sibling/pollution field, and enforces the same bounded canonical
  // Map/Set/Date/undefined grammar used by event records and node outputs.
  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(checkpointJson);
  } catch (error) {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${checkpointPath}: not valid JSON: ${safeErrorMessage(error)}`,
      ),
    );
  }
  const grammar = validateSerializedValueGrammar(rawEnvelope, {
    rootPath: "checkpoint",
    maxDepth: MAX_SAFE_RECORD_DEPTH,
  });
  if (!grammar.ok) {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${checkpointPath}: serialized checkpoint is not canonical: ${grammar.error}; the checkpoint is corrupt or hostile and resume fails closed (FR-009)`,
      ),
    );
  }
  const envelopeResult = guardCheckpointCorrupt(
    runId,
    `${checkpointPath}: deserializeValue threw while decoding a serializer-tagged value inside the checkpoint payload`,
    () => deserializeValue(rawEnvelope),
  );
  if (!envelopeResult.ok) return envelopeResult;
  const envelope = envelopeResult.value;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${checkpointPath}: checkpoint must be a JSON object with the shape { schemaVersion, data: { state, context } }`,
      ),
    );
  }
  const record = envelope as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schemaVersion" && key !== "data") {
      return err(
        frameworkError.checkpointCorrupt(
          runId,
          `${checkpointPath}: unknown top-level field ${JSON.stringify(key)} — the checkpoint envelope is exactly { schemaVersion, data: { state, context } }`,
        ),
      );
    }
  }
  if (record.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${checkpointPath}: unsupported schemaVersion ${safeDiagnosticRender(record.schemaVersion)} — expected ${JOURNAL_SCHEMA_VERSION}`,
      ),
    );
  }
  if (!("data" in record)) {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${checkpointPath}: missing data payload — the checkpoint envelope is { schemaVersion, data: { state, context } }`,
      ),
    );
  }
  const decodedAttempt = guardCheckpointCorrupt(
    runId,
    `${checkpointPath}: parseCheckpoint threw while decoding the checkpoint payload`,
    () => {
      const decoded = parseCheckpoint(record.data);
      return decoded.ok
        ? ({ kind: "decoded", value: decoded.value } as const)
        : ({ kind: "rejected", message: safeErrorMessage(decoded.error) } as const);
    },
  );
  if (!decodedAttempt.ok) return decodedAttempt;
  if (decodedAttempt.value.kind === "rejected") {
    return err(
      frameworkError.checkpointCorrupt(
        runId,
        `${checkpointPath}: ${decodedAttempt.value.message}`,
      ),
    );
  }
  const checkpointData = decodedAttempt.value.value;

  // 7. Agreement (AD-3 step 4): the checkpoint equals the FULL replay ⇒
  //    resume from `replayed`. Context is deliberately not compared — the
  //    log alone determines the resumed state (FR-010).
  //
  //    GUARDED (FR-040): each `stateKey` call runs inside its own guarded
  //    region so diagnostics identify replayed vs checkpoint state. The
  //    decoded checkpoint STATE is hostile/version-drifted
  //    input — the envelope gates above validated its JSON shape, never its
  //    machine semantics — and `machine.stateKey` can throw on it (an
  //    `.exhaustive()` match raises `NonExhaustiveError` on an unknown
  //    variant; a matched `failed` arm derefs `p.error.kind` on a missing
  //    field). ANY throw becomes `checkpoint-corrupt` naming
  //    `checkpoint.json` — never a raw untyped rejection.
  const replayedKeyResult = guardedStateKey(
    runId,
    `${checkpointPath}: full-agreement replayed-state comparison`,
    () => machine.stateKey(replayed.state),
  );
  if (!replayedKeyResult.ok) return replayedKeyResult;
  const checkpointKeyResult = guardedStateKey(
    runId,
    `${checkpointPath}: full-agreement decoded-checkpoint-state comparison`,
    () => machine.stateKey(checkpointData.state),
  );
  if (!checkpointKeyResult.ok) return checkpointKeyResult;
  const replayedKey = replayedKeyResult.value;
  const checkpointKey = checkpointKeyResult.value;
  if (checkpointKey === replayedKey) return ok(replayed);

  // 8. Single-pass strict-prefix scan (AD-3 step 5): fold the log while
  //    comparing each intermediate state key to the checkpoint key. The
  //    empty prefix (genesis) is the state before any event; the FULL replay
  //    (the last transition's result) was already decided by step 7, so the
  //    scan covers exactly the strict prefixes. One O(n) pass, tested once
  //    per transition — never Loom's O(n²) re-replay. The first match wins:
  //    the resumed state is ALWAYS `replayed`, which step 4 already computed.
  //    A checkpoint matching any strict prefix is a state the run genuinely
  //    occupied — the kernel's append-before-checkpoint window (FR-005) —
  //    so accepting it recovers the lagging projection without ever masking
  //    corruption.
  //
  //    GUARDED (FR-040): every call in the scan (the genesis `stateKey`
  //    compare and each per-step `transition` + `stateKey`) runs inside its
  //    own guarded region. Any throw is re-tagged `checkpoint-corrupt`
  //    naming the scan step + event index + runId and the machine's own
  //    error — the full-replay guard in step 4 would catch the same throw
  //    for a deterministic machine, but the scan deserves its own guard so
  //    the message can name the exact step. The transition+unwrap is the
  //    SHARED fold step (`foldStep`, state-machine/replay.ts) — the exact
  //    step `replayEvents` uses, so the scan's fold and the full replay's
  //    fold are one implementation and cannot drift (and the `as E` cast
  //    lives in that one file, never here).
  const genesisKey = guardedStateKey(
    runId,
    `${checkpointPath}: empty-prefix benign-lag check on the genesis state`,
    () => machine.stateKey(genesis.state),
  );
  if (!genesisKey.ok) return genesisKey;
  if (genesisKey.value === checkpointKey) return ok(replayed);
  let current: { state: S; context: C } = {
    state: genesis.state,
    context: genesis.context,
  };
  for (let i = 0; i < events.value.length - 1; i++) {
    const stepped = guardCheckpointCorrupt(
      runId,
      `${join(directory, EVENTS_DIR)}: machine.transition/fold threw at prefix-scan step ${i} (event index ${i}) of run ${runId} while comparing checkpoint ${renderStateKey(checkpointKey)} against the replay`,
      () => foldStep(current, events.value[i], machine),
    );
    if (!stepped.ok) return stepped;
    current = stepped.value;
    const prefixKey = guardedStateKey(
      runId,
      `${checkpointPath}: prefix-scan step ${i} intermediate replay-state comparison for run ${runId}`,
      () => machine.stateKey(current.state),
    );
    if (!prefixKey.ok) return prefixKey;
    if (prefixKey.value === checkpointKey) return ok(replayed);
  }

  // 9. The checkpoint disagrees with EVERY state the log provably passed
  //    through ⇒ corruption (FR-010). The message names both keys — precise
  //    enough to diagnose the disagreement — plus the runId (which also
  //    rides on the error's fields).
  return err(
    frameworkError.checkpointCorrupt(
      runId,
      `checkpoint ${renderStateKey(checkpointKey)} vs replay ${renderStateKey(replayedKey)} (run ${runId}, ${directory}): the checkpoint matches no strict prefix of the event log — the one benign divergence is a lagging checkpoint equal to the replay of a strict prefix (kernel append-before-checkpoint window); any other mismatch is corruption (FR-010)`,
    ),
  );
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
