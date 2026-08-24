# ADR-0077: Resume agreement proof — log authoritative, checkpoint may lag

## Status
Accepted

## Date

2026-08-14

## Context
A durable state-machine run writes two representations of progress: an append-only event log and an atomic `checkpoint.json` projection of the latest post-transition `{ state, context }`. The kernel deliberately commits each event before updating the checkpoint. A process crash between those writes therefore leaves a valid log ahead of a missing or stale checkpoint. Resume must recover that expected window without treating it as corruption (FR-010), while still refusing a checkpoint that describes a state the journal cannot prove the run reached.

Resume must also preserve the execution model. State reconstruction must use the machine's pure transition fold and must never call the executor or repeat external effects (FR-011). Failed terminal transitions are deliberately neither appended nor checkpointed, so recovery cannot return a state the machine rejected (FR-012). Finally, a missing or empty run directory is not evidence of a fresh run and must not silently restart from genesis; it must produce `checkpoint-missing` (FR-014).

These forces require a proof of agreement rather than a preference for whichever persisted representation is easiest to load. The log records committed transitions and is authoritative. The checkpoint is only an optimization/projection and may be absent or may lag, but it cannot introduce history.

## Options Considered

1. **Replay the authoritative log and accept only an agreeing or strict-prefix checkpoint**
   - Pros: Recovers the append-before-checkpoint crash window; reconstructs state deterministically without executor invocation; rejects states not proven by journal history; always returns the replayed state rather than trusting projection data; supports replay-only recovery when no checkpoint exists.
   - Cons: Resume is `O(n)` in journal length and, on a full-replay mismatch, performs an additional linear strict-prefix fold; correctness depends on deterministic, side-effect-free `machine.transition` behavior and meaningful, stable `machine.stateKey` values.

2. **Trust the checkpoint and replay only events believed to follow it**
   - Pros: Can avoid replaying the complete journal and make normal resume cheaper for long runs.
   - Cons: A corrupt, stale-from-another-run, or otherwise unprovable checkpoint can silently discard committed transitions and produce bogus state, violating FR-010 and the fail-closed durability requirement. It also makes the projection, rather than the journal, authoritative.

3. **Treat every checkpoint/full-log mismatch as corruption**
   - Pros: Simple equality rule; rejects all divergent durable representations.
   - Cons: Rejects the kernel's expected append-before-checkpoint crash state, making a correctly ordered durable write sequence non-resumable after an ordinary process crash.

4. **Return the checkpoint when it agrees with replay**
   - Pros: Avoids discarding an already decoded projection and may appear to preserve its context directly.
   - Cons: Creates two possible sources for resumed state. The checkpoint adds no evidence beyond the log, and returning it would let projection-only data influence recovery even though replay is the authoritative reconstruction.

## Decision
**Reconstruct every resumable run from the authoritative event log, using the checkpoint only as an agreement witness that may equal the full replay or any strict prefix.**

The shipped implementation is `resumeFileJob` in `packages/framework/src/file/resume.ts`, exported through `packages/framework/src/file.ts`. Its agreement proof is:

1. Read `checkpoint.json` as an optional projection — BEFORE the event log (Amended 2026-08-18: the acquisition order is part of the contract — see the Amendment below). If both the validated event sequence and checkpoint are absent, return typed `checkpoint-missing` for the supplied `runId` (FR-014). Resume performs no writes, so an absent directory remains absent.
2. Read events through `readFileEvents` in `packages/framework/src/file/event-log.ts`. Every `events/*.json` record is strictly decoded and checked for schema, sequence, timestamp, dedup-key, contiguous ordering, filename sequence, and filename digest agreement. Any unreadable or invalid journal entry is re-tagged as `checkpoint-corrupt` with the offending path and reason; no mid-log entry is skipped.
3. Fold all recorded events from the caller-supplied genesis value via `replayEvents` and its shared `foldStep` in `packages/framework/src/state-machine/replay.ts`. These functions call only `machine.transition`; no executor is accepted or invoked, and no external effect is replayed (FR-011).
4. If `checkpoint.json` is absent, return the full replay. This covers a crash after the first event append but before the first checkpoint.
5. Parse `checkpoint.json` to a raw JSON value, then validate that complete raw value with the shared iterative serializer-grammar validator, `validateSerializedValueGrammar`, before any call to `deserializeValue` or the caller's `parseCheckpoint`. Its explicit stack avoids JavaScript recursion at the hostile-data boundary. The exact canonical grammar rejects reserved-tag objects with siblings or multiple tags, malformed Map/Set/Date/undefined payloads, pollution-filtered keys at any depth, excessive nesting, malformed Map tuples, and duplicate primitive Map keys or Set values that deserialization would collapse. The same gate admits canonical nested Map/Set/Date/undefined tags, preserving their round-trip. No weaker checkpoint-specific pollution scan runs in parallel. Invalid JSON, canonical-grammar failure, an invalid envelope, unsupported schema, decoder rejection, or an untyped decoder/machine throw fails closed as typed `checkpoint-corrupt` naming `checkpoint.json` or the relevant replay step.
6. Compare `machine.stateKey(checkpoint.state)` with `machine.stateKey(replayed.state)`. On equality, return the replayed `{ state, context }`; checkpoint context is never authoritative.
7. On mismatch, compare the checkpoint key with genesis (the empty prefix), then fold all strict prefixes using the same `foldStep` implementation as full replay. A match proves benign checkpoint lag, including lag by more than one event, and returns the full replay. This is one additional linear scan, preserving `O(n)` complexity rather than repeatedly replaying prefixes in `O(n²)`.
8. If no full or strict-prefix state key matches, return `checkpoint-corrupt`. The diagnostic names `checkpoint <key> vs replay <key>`, the run, and the directory (FR-010).

The invariants are:

- A successful resume always returns the full log replay, never checkpoint data.
- The checkpoint can attest only to a state key the journal proves the run occupied: full replay, genesis, or an intermediate strict prefix.
- `machine.stateKey` is the machine's state-identity contract for agreement; context is reconstructed from replay and is not compared or returned from the checkpoint.
- `resumeFileJob` is read-only and never invokes an executor. `machine.transition` and `machine.stateKey` must be deterministic; boundary guards convert their throws to typed corruption errors.
- `runStateMachine` in `packages/framework/src/state-machine/runner.ts` appends and checkpoints only when the resulting state is not failed. A terminal-failed transition therefore contributes neither an event nor a checkpoint. Recovery returns the last accepted replay state, and a manufactured failed-state checkpoint is rejected unless its key is genuinely present in the proven prefix space (FR-012).

The agreement and failure cases are exercised in `packages/framework/src/__tests__/file-resume.test.ts`: real append/update crash recovery and manufactured disagreement (SC-002), replay-only recovery, empty and absent directories, full and strict-prefix agreement including genesis and multi-event lag, corrupt-record variants, completed-run round-trip, failed-terminal behavior, deterministic replay properties, and guarded hostile machine/checkpoint inputs.

## Consequences

**Positive:**
- Ordinary crashes in the append-before-checkpoint window recover from committed history instead of failing spuriously.
- Corrupt or foreign checkpoints cannot override committed transitions; unprovable disagreement fails closed with actionable typed diagnostics.
- Resume cannot repeat executor-controlled side effects because reconstruction has no executor path and returns only the pure replay result.
- Missing checkpoints do not prevent recovery when the journal contains events, while directories with no recoverable evidence cannot silently become fresh runs.
- Terminal-failed states remain outside durable history and cannot be resurrected by normal resume.
- Prefix checking remains linear in journal length and shares `foldStep` with full replay, preventing replay/verification semantics from drifting.

**Negative:**
- Resume always replays the complete journal, so latency grows linearly with event count; a mismatching checkpoint can require a second linear fold.
- The proof assumes deterministic, side-effect-free machine transitions. A transition with hidden I/O or nondeterminism would make replay unsafe or unstable and is outside this contract.
- Agreement is based on `stateKey`, not deep state/context equality. A coarse or colliding key weakens diagnostics, and a parse-valid checkpoint context disagreement is ignored; the safety backstop is that checkpoint data is never returned.
- Strict fail-closed validation favors safety over availability: a single corrupt event, a non-canonical or undecodable checkpoint, or a throwing machine/decoder blocks resume until the durable data or compatibility issue is corrected.

## Amendment (2026-08-18)

The original Decision enumerated reading the event log first and `checkpoint.json` second. That order was an implementation artifact, not a contract: a reader acquiring the log first could, against a LIVE writer, list `events/` before the Nth record rename and read `checkpoint.json` after it — observing a checkpoint STRICTLY AHEAD of its own log snapshot. The kernel commits each append as two separate atomic renames, log record first and checkpoint projection second (FR-005 / ADR-0078), so the lag window that exists is always checkpoint-lags-log. The proof's strict-prefix scan accepts exactly that direction (full agreement, or a lagging checkpoint matching a strict prefix) and verdicts every other mismatch `checkpoint-corrupt` — so a log-first acquisition turned a healthy run's ordinary concurrent-read interleaving into a spurious corruption (the pinned cross-process test in `file-resume.test.ts` failed intermittently on exactly this observation).

The amendment makes the acquisition order part of the contract: `resumeFileJob` reads `checkpoint.json` before the event log. For every append-first writer the pair is then monotone — checkpoint(t₁) ≤ log(t₁) ≤ log(t₂) — so a concurrent reader can only ever observe an agreeing or lagging checkpoint: the space the proof already accepts. The proof algorithm (steps 3–8), the returned state (always the full log replay), and the failure kinds are unchanged. One observable difference: when BOTH seams fail at once (an unreadable `checkpoint.json` AND a corrupt log), the checkpoint's typed `cache-error` now surfaces ahead of the log's `checkpoint-corrupt`; the two-failure precedence is pinned in `file-resume.test.ts`.

## Related

- [ADR-0076 — On-disk layout: ProgramJournal parity with the digest-filename adaptation](./0076-on-disk-layout-programjournal-parity-with-the-digest-filename-adaptation.md)
- [ADR-0078 — Journal single-writer contract and append serialization](./0078-journal-single-writer-contract-and-append-serialization.md)
- [ADR-0080 — Failure surface: Result everywhere the port allows; typed throwing inside the JobLike shell](./0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md)
- [F6 file-backed durable runtime specification](../../.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md)
- [`resumeFileJob` implementation](../../packages/framework/src/file/resume.ts)
- [`resumeFileJob` regression tests](../../packages/framework/src/__tests__/file-resume.test.ts)
