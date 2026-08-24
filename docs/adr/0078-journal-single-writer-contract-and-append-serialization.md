# ADR-0078: Journal single-writer contract and append serialization

## Status
Accepted

## Date
2026-08-14

## Context
The file-backed `JobLike` assigns each event a sequence from the journal's current durable contents. Without serialization, interleaved appends can both observe the same event-file count, choose the same sequence, and either overwrite one another or leave a log that cannot be replayed. Sequence must therefore be contiguous and replayable in the total order in which append contenders acquire the lock. Non-overlapping calls preserve happens-before; the relative order of genuinely concurrent calls is scheduler-dependent and is not promised to match invocation order (FR-013).

A supplied `dedupKey` must also make append idempotency durable rather than process-local. Repeating a committed key must preserve the first event's content and sequence, while retrying an append that crashed before commit must still create the event. This must hold without an in-memory dedup index that disappears on restart or can diverge from the event files (FR-004).

The kernel assumes one runner loop per run and performs `appendEvent` before the lock-free `updateData` and `updateProgress` projections. The public contract must distinguish append serialization from support for multiple complete writers: concurrent readers are safe because committed event files are immutable, but concurrent `JobLike` writers could race the checkpoint and progress projections. Directory creation, deletion, retention, and reaping must remain consumer-owned, with no backend daemon or out-of-band management (FR-044). The caller-supplied job-journal directory and its filesystem are assumed non-adversarial; descriptor-anchored journal traversal remains a separate host-shell concern. The file Checkpointer now independently rejects pre-existing symlink substitutions in its managed base/run/nodes tree, as recorded in ADR-0076; that does not change this journal-lock decision.

## Options Considered

1. **Rename-born per-journal append lock plus a one-`JobLike`-writer contract**
   - Pros: Serializes the complete append transaction across asynchronous calls and processes; provides a clear linearization order for sequence assignment; recovers from a process that dies while holding the lock; makes keyed dedup durable from the event-file listing itself; permits lock-free concurrent readers; preserves the kernel's existing single-runner model.
   - Cons: Every append lists the event directory while holding a filesystem lock; lock acquisition can wait or fail; the permanent fence directory and transient intents add filesystem metadata; PID-based stale detection has platform and PID-reuse limitations; the lock does not make concurrent checkpoint/progress writers safe, so consumers must still honor the single-writer contract.

2. **In-process mutex only**
   - Pros: Simple and inexpensive; sufficient for `Promise.all` interleaving within one process.
   - Cons: Cannot coordinate a previous process with a replacement or retrying process, so two processes can claim the same sequence or make conflicting dedup decisions.

3. **Lock-free append using unique temporary files and retry**
   - Pros: Avoids lock contention and stale-lock handling.
   - Cons: Two different appends can observe the same listing and select the same sequence; unique temporary names do not prevent collision at the final sequence-addressed commit path, so ordering, contiguity, or event preservation can be lost.

4. **Descriptor-anchored journal paths with `O_NOFOLLOW` discipline, equivalent to Loom's production `RunDirHandle`**
   - Pros: Defends journal operations against symlink substitution and path re-targeting within an adversarial run-directory tree.
   - Cons: Adds host-specific descriptor-anchoring complexity beyond the portable parity primitive required here; does not remove the need for append serialization or the one-writer projection contract. This remains out of scope for the job journal. ADR-0076 separately records the portable `lstat`/`realpath` containment now applied to Checkpointer-managed descendants.

## Decision
**Serialize every journal append with a rename-born `events/append.lock` directory while requiring exactly one `JobLike` writer, allowing any number of concurrent readers, per run directory.**

`packages/framework/src/file/atomic.ts` implements the cross-process lock with a permanent sibling fence directory, `events/append.lock.fence/`. A prospective owner publishes a unique birth intent before checking for a reaper. A stale reaper publishes a unique reap intent, waits for every already-published birth intent to finish, and only then performs the decisive stale probe and victim rename. Births published after the reap intent observe it and stand down. The canonical owner path is therefore stable from the fenced stale probe through rename: an earlier, unfenced stale observation can never authorize moving or deleting a newly born live lock. Crash-left tombs are reconciled while births remain fenced; an unrestorable live tomb blocks acquisition rather than allowing a second holder. Unique intent paths are never reused, so stale intent cleanup cannot delete a later contender.

The owner directory itself is still born atomically by staging `pid` and a plain ownership token in a private `append.lock.birth-*` directory and renaming it to `events/append.lock`. `process.kill(pid, 0)` classifies `ESRCH` as dead/stale and `EPERM` as live. Unexpected PID metadata-read failures and unexpected process-probe failures are also classified as live, failing closed rather than authorizing stale-owner recovery; each emits a total, non-throwing warning so diagnostic formatting or logging cannot change the classification or mask the lock operation's result. Release requires both the current pid and ownership token to match before removing the canonical owner. An absent lock and a proven pid/token mismatch remain safe no-ops, so a former holder never deletes another owner's lock. By contrast, an inconclusive ownership read or a failure to remove a lock proven to be owned throws the existing typed `cache-error`: `withFileLock` rejects if its body otherwise succeeded, and `FileJournal.appendEvent` re-tags that failure as `appendEvent` rather than reporting success while a live lock remains. If the critical section already failed, that primary typed failure remains authoritative and the secondary release failure is emitted through total, non-throwing diagnostics; even a hostile logger cannot replace the primary. The token is an internal ownership check, not a public branded lease. A branded lease API remains a possible future type-safety improvement and is not in this ADR's current scope.

`packages/framework/src/file/journal.ts` holds that lock around the whole append transaction:

1. List committed `events/*.json` entries and validate each filename against the six-digit/digest naming contract and each entry type as a regular file.
2. For a non-empty `dedupKey`, compute `keyDigest(dedupKey)` and return without writing if a validated filename already has that digest suffix.
3. Assign `sequence = existing.length`.
4. Serialize the event record and commit `events/<six-digit-sequence>-<digest>.json` through same-directory temporary-file plus atomic rename.

Append deliberately does not parse existing record contents. Full schema, sequence-prefix/content agreement, digest/content agreement, and strict contiguity validation belong to the read side in `packages/framework/src/file/event-log.ts`, which fails closed before replay. This split keeps append's locked transaction bounded to committed filenames and entry types while preserving strict corruption detection at the authoritative consumption boundary.

The lock gives concurrent append critical sections one total lock-acquisition order. Assigned sequences are contiguous and replayable in that order; genuinely concurrent contenders may appear in any scheduler-selected order. The atomic rename is the append commit point for process-crash recovery and namespace atomicity only. The implementation performs neither a file `fsync` before rename nor an `fsync` of the containing directory after rename, so it does not claim that an acknowledged append survives sudden host power loss or storage failure. For a keyed append, a process crash before commit leaves no matching event and the retry writes it; a process crash after commit leaves the digest-bearing file and the retry is a no-op. Because the durable listing is the dedup index, the first committed record's content and position are preserved across fresh journal instances (FR-004), with no secondary index to recover.

This append lock is not a multi-writer capability. `checkpoint.json` and `progress.json` remain atomic but lock-free projections, so the supported invariant is one `JobLike` writer per run directory. `packages/framework/src/file/job.ts` documents that contract. `packages/framework/src/file/event-log.ts` supports any number of concurrent readers without taking the append lock: committed event files are immutable, temporary files and `append.lock/` are not `*.json`, and atomic rename prevents readers from observing a partial committed record.

The backend creates directories only as required by explicit writes. It does not delete, retain, reap, or otherwise manage run directories in the background; consumers own the entire run-directory lifecycle (FR-044). For this job-journal surface, identifier validation and digest addressing prevent caller values from becoming path escapes, but concurrent filesystem-object substitution is outside the guarantee: the implementation does not use descriptor-anchored traversal and assumes the caller protects the journal directory. File Checkpointer containment is a distinct, stronger managed-descendant rule documented in ADR-0076.

## Consequences

**Positive:**
- Concurrent and cross-process append attempts produce a contiguous replayable sequence in lock-acquisition order; ordering among concurrent contenders is scheduler-dependent, as exercised by the in-process and three-process serialization tests in `packages/framework/src/__tests__/file-journal.test.ts`.
- Keyed retries converge to exactly one durable record without a separate index; the first record's payload and sequence survive retries and process restart (FR-004).
- A crashed lock holder can be reclaimed without exposing an unfenced owner-path gap. Permanent birth/reap fencing, crash-tomb reconciliation, and pid-plus-token release prevent a stale observer from displacing a later live holder; deterministic three-process tests exercise the stale-probe/new-birth race and mutual exclusion in `packages/framework/src/__tests__/file-atomic.test.ts`.
- Readers need no lock and cannot observe temporary append files as committed events.
- An owned-lock release failure is observable: successful critical sections and appends reject with typed context instead of falsely acknowledging cleanup, while a simultaneous body failure remains the primary failure and retains secondary cleanup diagnostics.
- The backend has no lifecycle daemon, sweeper, or hidden retention policy; ownership remains explicit at the consumer boundary (FR-044).

**Negative:**
- Atomic rename does not provide power-loss durability by itself. Because neither the event file nor its containing directory is `fsync`ed, a host or filesystem failure can lose the newest acknowledged append.
- Appends are `O(number of event files)` because sequence assignment and dedup scan the durable listing under the lock; high-volume journals will incur increasing append latency.
- Lock contention is serialized and bounded by the acquisition retry policy; a live or incorrectly perceived-live owner can cause append failure rather than indefinite waiting.
- A release failure can occur after an event rename has committed. The append rejects even though the durable keyed retry may later observe that committed record; operators must treat the typed failure as requiring retry or lock remediation, not proof that no event landed.
- Consumers must enforce one complete `JobLike` writer per run directory. The append lock may serialize two out-of-contract writers' event appends, but it cannot prevent their lock-free checkpoint or progress projections from racing.
- Consumers must create operational policy for directory retention, deletion, and reaping.
- The job journal's accepted trust model does not defend against an adversary concurrently replacing directory entries or introducing symlinks inside the supplied run directory. Hosts requiring that journal threat model must provide descriptor-anchored hardening outside this backend or revisit this decision; the Checkpointer's pre-existing-symlink rejection does not extend to journal paths.

## Related

- [ADR-0076 — On-disk layout: ProgramJournal parity with the digest-filename adaptation](./0076-on-disk-layout-programjournal-parity-with-the-digest-filename-adaptation.md)
- [ADR-0077 — Resume agreement proof: log authoritative, checkpoint may lag](./0077-resume-agreement-proof-log-authoritative-checkpoint-may-lag.md)
- [ADR-0080 — Failure surface: `Result` everywhere the port allows; typed throwing inside the `JobLike` shell](./0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md)
