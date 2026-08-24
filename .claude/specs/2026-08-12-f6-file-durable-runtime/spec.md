# Feature: F6 — File-backed durable runtime (`@fuguejs/framework/file`)

**Spec ID:** 2026-08-12-f6-file-durable-runtime
**Created:** 2026-08-12
**Status:** Draft
**Owner:** Fugue framework (requested by the Loom retirement unblock; roadmap convergence C5)

## Summary

Fugue's durable-runtime ports (JobLike event journal, Checkpointer, FreshnessIndex) are today only satisfiable with Redis/BullMQ — every durable deployment pays for an external broker even for single-process runs. F6 ships a filesystem-backed subpath (`@fuguejs/framework/file`) implementing all three immutable port signatures with the broker backends' closed `FrameworkError` taxonomy: `Result` wherever a signature admits it and typed throwing only where an existing signature has no `Result` channel. A run can therefore be durable and resumable with zero external dependencies. This is the primitive Loom's hand-rolled `ProgramJournal` retires onto — the biggest unblock per design risk on the roadmap — and closes the market-parity gap with persistence without a broker (LangGraph SqliteSaver, Hatchet/Temporal/Inngest).

---

## User Scenarios

### US1: [P1] Durable file-backed job with crash-safe resume

**As a** Fugue framework consumer running a state-machine job without Redis (e.g. Loom's orchestration layer)
**I want to** drive a job through a file-backed durable event log whose state survives process death, and resume it in a fresh process
**So that** a crash mid-run costs nothing — the run continues from its durable state instead of restarting or losing side-effect ordering.

**Why this priority:** This is the Loom unblock — the point of F6. `createFileJob` + the event-log reader + `resumeFileJob` replace the hand-rolled ProgramJournal and make single-process durable execution a first-class framework capability. Everything else in F6 is smaller.

**Acceptance Scenarios:**
- Given a completed journal in a directory, When I open it in a fresh process and resume, Then the run replays to the identical final state (events, checkpoint, and progress all round-trip; replay proves state)
- Given a crash between appending an event and checkpointing the post-state (the one benign lag window), When I resume, Then the lagging checkpoint is recovered by replaying the authoritative event log — treated as expected, not corruption
- Given a checkpoint that disagrees with the replay of any strict prefix of the event log, When I resume, Then the run fails closed with a typed `FrameworkError` rather than proceeding
- Given an event file containing corrupt or truncated JSON, When the reader loads it, Then the whole read fails closed through `Result<_, FrameworkError>` — the entry is never silently skipped and a partial log is never returned
- Given an invalid or out-of-range dedup key, When it crosses the immutable `JobLike.appendEvent(...): Promise<void>` persistence boundary, Then the promise rejects with a typed `FrameworkError`, never a raw `Error`, and no path escapes the run directory

### US2: [P1] File-backed Checkpointer over the composite address space

**As a** framework consumer that must persist DAG node outputs per-run (currently Redis-only for durable runs)
**I want to** checkpoint and resume DAG runs through a file-backed Checkpointer that passes the exact shared `checkpointerSuite`
**So that** backend swap is transparent: same port, same error kinds, same expiry/version/fingerprint semantics — with a node address space extended to name namespaced, indexed, repeated-attribute node instances (the composite form future F1/F8/F4 features will consume).

**Why this priority:** Together with US1 this is the Loom unblock. The composite address space ships here as a backend-agnostic extension of the Checkpointer port with a canonical fallback, so existing consumers and the in-memory/Redis backends are untouched.

**Acceptance Scenarios:**
- Given a file checkpointer over a fresh directory, When I `load` an unknown run, Then I get a clean `null` (never an error)
- Given a saved node under any composite address (namespace, nodeId, index, attempt) or the canonical form (plain nodeId), When I load the run, Then every stored node comes back with its exact output, including per-node corrupt entries dropped and surfaced via `corruptNodeAddresses`
- Given a checkpoint written by a different framework version, When I load with the shared suite's checks active, Then load rejects with `checkpoint-version-mismatch` (ADR-0017 semantics)
- Given an `expectedDagFingerprint` option and a stored fingerprint that is absent or different, When I load, Then load rejects with `checkpoint-version-mismatch`
- Given a checkpoint older than 24h, When I load, Then load reports `checkpoint-expired` — expiry evaluated lazily at load, with no background sweeper
- Given a node ID that is invalid or out of range, When it crosses the persistence boundary, Then the Result-bearing write returns a typed `FrameworkError` — never path-escape, never a silently misplaced entry

### US3: [P2] Durable single-process FreshnessIndex

**As a** framework consumer running freshness-witness conflict detection in a single process
**I want to** persist latest-write records across restarts through a file-backed `FreshnessIndex`
**So that** conflict detection crosses the same durability boundary as `RedisFreshnessIndex` without Redis.

**Why this priority:** Named in the convergence doc (C5). Kept in F6 because it crosses the exact same durability boundary as the other two pieces, but it has no current consumer blocking on it.

**Acceptance Scenarios:**
- Given a recorded write, When the process restarts and a later run calls `findConflict`, Then the selected live singleton is still visible and conflict detection has the observable singleton parity defined by FR-032: inclusive `sinceMs`, same-value suppression, clean missing/expired behavior, and a refreshed 24h lifetime
- Given a resource with a live singleton, When writes arrive in any order, Then selection and replacement are one atomic transaction: the greater `succeededAtMs` wins, an equal score uses Redis reverse-binary member ordering, and a lower-scored loser leaves the winner intact while refreshing the lifetime; a reader sees either complete singleton, never partial JSON
- Given no live record for a resource, When I call `findConflict`, Then the result is a clean no-conflict — never an error

---

## Functional Requirements

### Core — file-backed job and event log (US1)

- FR-001: The file backend MUST provide a `JobLike` implementation (`createFileJob`) exposing the full kernel surface — `data`, `updateData`, `updateProgress`, and `appendEvent` — with the same semantics as the in-memory/Redis adapters, changing nothing in the kernel contract.
- FR-002: `appendEvent` MUST durably persist events in append order, such that the persisted sequence equals the happens-before order of appends.
- FR-003: A JobLike journal MUST live under a caller-supplied directory and MUST be fully recoverable in a fresh process from that directory alone — no in-memory state, no external registry.
- FR-004: `appendEvent` MUST be idempotent under a supplied `dedupKey`: a second append with a key already present in the journal MUST be a no-op leaving exactly one record, preserving the first record's content and position; the dedup decision MUST itself be durable, so a retry after a crash at any point still lands as a no-op.
- FR-005: `appendEvent` MUST NOT return until the event is durably persisted, preserving the kernel's append-before-checkpoint ordering (runner FR-005): a crash between `appendEvent` and `updateData` leaves the log ahead of the checkpoint by exactly the appended event, which resume MUST treat as the one benign lag window — never as corruption.
- FR-006: `updateData` MUST durably persist the post-state snapshot atomically — after a crash, a reader observes either the complete prior snapshot or the complete new one, never a partial write.
- FR-007: `updateProgress` MUST durably persist progress so it survives a process restart, with the same atomicity as `updateData`.
- FR-008: The event-log reader MUST expose records as the kernel's `RecordedEvent` envelope shape (`recordedAtMs`, `event`) so they are directly replayable through the pure `replayEvents` fold.
- FR-009: Record losslessness and integrity are enforced at BOTH persistence boundaries — the writer MUST reject any event value the serializer cannot represent losslessly at the write boundary (before any bytes exist), and the reader MUST strictly validate every record on the read side — schema version, non-negative integer sequence, finite recorded timestamp, and dedup-key charset — and MUST fail closed with a typed parse error on any corrupt/truncated record; the event log is authoritative, so a corrupt entry is never silently dropped mid-log.
- FR-010: `resumeFileJob` MUST treat the event log as authoritative and the checkpoint as a projection that may lag; any disagreement between the stored checkpoint and the replay of any strict prefix of the log MUST fail closed with a typed `FrameworkError` (`checkpoint-corrupt`, with a message precise enough to diagnose the disagreement).
- FR-011: Resume MUST reconstruct state by replaying events through the pure machine and MUST NOT re-invoke the executor or any side effect.
- FR-012: A terminal-failed run MUST NOT be resumable into a state its own machine rejected — the checkpoint of a failed terminal state is never persisted (kernel FR-005 discipline preserved).
- FR-013: Appends to a single journal MUST be serialized so sequence equals happens-before order even when calls interleave; the single-writer contract for a journal directory (one `JobLike` writer; any number of concurrent readers) MUST be enforced by design and documented in the public surface.
- FR-014: Resume of a run directory with no recoverable state MUST surface a typed `FrameworkError` (`checkpoint-missing`) — never a silent fresh start.
- FR-015: `dedupKey` values MUST be validated against the charset `^[A-Za-z0-9:_-]{1,256}$` at the persistence boundary; because `appendEvent` has the immutable `Promise<void>` signature, out-of-range values MUST reject with a typed `FrameworkError`, never a raw `Error`.
- FR-016: Job-side identifiers MUST be re-validated at the persistence boundary (charset `^[A-Za-z0-9_:-]{1,128}$`) and MUST NOT be allowed to address anything outside the caller-supplied run directory — path-escape attempts fail closed through the FR-040 transport available to the boundary.

### Core — file Checkpointer and composite address space (US2)

- FR-020: The file Checkpointer (`createFileCheckpointer`) MUST implement the `Checkpointer` port — `load`, `saveNode`, `setMeta` — durably, over a caller-supplied directory keyed by run, and MUST pass the shared `checkpointerSuite` in its entirety.
- FR-021: The Checkpointer port MUST gain a backend-agnostic composite node-key extension — `(namespace, nodeId, index, attempt)` — with a default namespace (`"dag"`) and a canonical fallback (absent index/attempt ⇒ key = `nodeId`) so existing consumers see identical behavior.
- FR-022: The file backend MUST implement full composite addressing: any two distinct addresses MUST resolve to distinct durable entries (no collision between composite and canonical forms), and a load MUST return every stored node under any address form.
- FR-023: The composite-key extension MUST NOT change the in-memory or Redis backends or their on-disk layouts; their existing behavior stays byte-identical (verified by the shared suite remaining green).
- FR-024: `setMeta` MUST stamp the framework version (`FRAMEWORK_VERSION`) unless the caller supplies one, exactly mirroring the in-memory and Redis backends.
- FR-025: `load` MUST reject with `checkpoint-version-mismatch` when the stored framework version differs from `FRAMEWORK_VERSION` (ADR-0017).
- FR-026: `load` MUST reject with `checkpoint-version-mismatch` when `expectedDagFingerprint` is supplied and the stored fingerprint is absent or different.
- FR-027: `load` MUST evaluate 24h expiry lazily at load and report `checkpoint-expired` for past-TTL metadata, mirroring the Redis TTL contract; there MUST be no background sweeper and no physical garbage collection in this pass.
- FR-028: A corrupt/truncated individual node entry MUST be dropped from the loaded node set and its address surfaced in `corruptNodeAddresses` as the `CorruptCheckpointAddress` discriminated union — `node-key` (a stored key was recovered and is re-executable) or `digest-filename` (only the opaque digest filename was) — so callers can distinguish "never ran" from "ran but stored corrupt"; a corrupt metadata entry MUST surface a typed `checkpoint-corrupt` error.
- FR-029: Checkpointer writes MUST be atomic (reader observes prior-complete or new-complete, never partial), and run/node identifiers MUST be re-validated at the persistence boundary under the same fail-closed charset discipline as FR-016.

### Core — file FreshnessIndex (US3)

- FR-030: The file FreshnessIndex (`createFileFreshnessIndex`) MUST implement the `FreshnessIndex` port — `recordWrite` and `findConflict` — durably, such that recorded writes survive process restart.
- FR-031: `recordWrite` MUST serialize selection and persist exactly one score-monotonic singleton per resource atomically (prior-complete or new-complete, never partial); the file format MUST NOT retain Redis members, an append set, or write history.
- FR-032: `recordWrite` and `findConflict` MUST provide observable singleton parity with `RedisFreshnessIndex`, not exact Redis ZSET mutation or history parity. During a live 24h singleton window, the retained entry MUST be the maximum `(succeededAtMs, memberBytes)` tuple observed: a greater `succeededAtMs` wins; at equal scores, the lexicographically greater unsigned UTF-8 byte sequence of Redis's exact member serialization `JSON.stringify([runId, nodeId, newWitness.kind, newWitness.value])` wins, matching Redis reverse-binary member ordering independently of arrival order; and a lower score MUST NOT replace the singleton. Every successful `recordWrite` MUST refresh `writtenAtMs` and the 24h visibility window even when the incoming entry loses. A singleton is live at exactly 24h and MUST be treated as missing once its age is greater than 24h; after expiry, the next write starts a new window and MAY replace the expired singleton regardless of score. `findConflict(conditionedOn, sinceMs)` MUST return the selected live entry iff `succeededAtMs >= sinceMs` and `newWitness.value !== conditionedOn.value`; otherwise, including a missing or expired singleton, it MUST return clean no-conflict (`ok(null)`). Identical-member downward-score mutation is explicitly outside parity: Redis can lower that member's score and reselect from retained members, but the file backend MUST preserve the higher live singleton because exact emulation would require the full member history rejected by FR-031 and AD-5.

### Cross-cutting (all scenarios)

- FR-040: Every file-backend operation whose immutable signature admits a `Result` MUST return failure as `Result<_, FrameworkError>` and MUST NOT throw or reject for an expected operational failure. The existing throwing-only surfaces — in particular the immutable `JobLike` `data` getter and `updateData`/`updateProgress`/`appendEvent` `Promise<void>` methods — MUST throw or reject only values satisfying the `FrameworkError` union and MUST catch and re-tag raw `Error`, arbitrary thrown values, hostile accessors/proxies, and dependency throws before they cross the boundary. All surfaces MUST use only the existing closed taxonomy (including `cache-error`, `checkpoint-corrupt`, `checkpoint-expired`, `checkpoint-version-mismatch`, `checkpoint-write-failed`, and `checkpoint-missing` as applicable); no file-specific error kind and no existing port-signature change are permitted.
- FR-041: The file backend MUST depend only on `node:fs`, `node:crypto`, and `node:path`; it MUST add no new package dependencies.
- FR-042: The file backend MUST ship as a clean `@fuguejs/framework/file` subpath export of the existing package, with the framework frozen at 0.4.0 and the existing public surface unchanged.
- FR-043: The file backend MUST satisfy the existing `check-imports.ts` boundary rules — no imports of `bullmq`, `ioredis`, or `queue-bullmq` anywhere in the file backend, and no new boundary violations anywhere.
- FR-044: Run-directory lifecycle (creation, deletion, retention, reaping) is the consumer's concern, documented as such; the backend MUST NOT perform background or out-of-band directory management.

---

## Non-Functional Requirements

### Reliability

- NFR-001: A crash at any point during a write MUST leave the run directory in a state from which resume either recovers exactly (benign lag window) or fails closed with a typed `FrameworkError` transported according to FR-040 — never silently bogus state (verified by the crash-window test).
- NFR-002: Resume/replay MUST be deterministic: the same journal in the same order yields the same state, with no executor invocation (FR-011).

### Security

- NFR-010: Identifier values MUST never influence addressing outside the caller-supplied directory (no path escape, fail closed) — verified by boundary tests with hostile identifiers.

### Compatibility

- NFR-020: Backend swap compatibility: a consumer written against the Checkpointer/JobLike/FreshnessIndex ports MUST be able to switch among in-memory, Redis, and file backends without changing port calls or the closed `FrameworkError` taxonomy. Behavioral parity is bounded by each port's normative contract: FreshnessIndex parity means FR-032 observable singleton behavior and explicitly does not mean physical or command-by-command Redis ZSET equivalence; failure transport follows each immutable signature as specified by FR-040.

---

## Success Criteria

Measurable outcomes that define "done". Acceptance bar for **P1** is SC-001 through SC-006 in full; **P2** additionally requires SC-007.

- SC-001: `createFileCheckpointer` passes the ENTIRE shared `checkpointerSuite` — zero failures across all parametrized cases: version-mismatch rejection (ADR-0017), `expectedDagFingerprint` opt-in, 24h TTL expiry at load, per-entry corrupt-node drop with `corruptNodeAddresses`, composite addressing, atomicity.
- SC-002: Crash-window resume test proves both sides of the suite: (a) a crash between `appendEvent` and `updateData` resumes and recovers the lagging checkpoint by log replay; (b) a manufactured checkpoint/log disagreement fails closed with the typed `checkpoint-corrupt` error. Both asserted by automated test.
- SC-003: Append dedup idempotency is proven by automated test: the same `dedupKey` appended twice produces exactly one record (content and position of the first preserved), and the no-op holds across a simulated crash between the two calls.
- SC-004: `bun run typecheck` in `packages/framework` is green (zero errors).
- SC-005: The full framework test suite is green — zero failures, no regressions in existing in-memory/Redis/BullMQ backends.
- SC-006: `check-imports.ts` boundary rules are green — zero violations, including no `bullmq` or `ioredis` imports anywhere in the file backend.
- SC-007: FreshnessIndex tests prove restart durability and the complete FR-032 observable singleton contract: one persisted singleton; higher-score and Redis reverse-binary equal-score selection independent of arrival order; inclusive `sinceMs`; same-value suppression; clean missing behavior; 24h boundary, refresh-on-every-success, and post-expiry replacement; and explicit rejection of member/history file shapes. No test MAY claim identical-member downward-score or full-ZSET-history parity.

**Measurement approach:** automated tests — the shared `checkpointerSuite` (parametrized over backends), new file-specific tests (crash-window, dedup, corrupt-file, atomicity, boundary/hostile identifiers, restart durability), the existing boundary-imports test, and `bun run typecheck`.

---

## Out of Scope

Explicitly NOT part of this feature:

- File `QueueBackend` / workers (approach B) — no enqueue/worker lifecycle, concurrency, attempts, delay, backoff, dead-letter, or markers in this pass; a file worker is later composed from `createFileJob` + a small polling loop.
- SQLite (approach C) — pure JSON only; no native dependencies.
- Store / memory capability — separate future ADR.
- Workflow DSL / generic registry (FR-004 discipline).
- F1 dynamic fan-out, F8 nested subgraph, F4 caching — they only *consume* the composite address space later.
- Changes to existing in-memory/Redis/BullMQ backends or their on-disk layouts.
- Migration of historical Loom run directories — they are read-only artifacts; the Loom retirement effort adapts (no migration tooling).
- Background sweeper / physical GC of expired run directories — TTL is evaluated lazily at load/findConflict only; run-directory lifecycle belongs to the consumer.
- Exact Redis ZSET member-history or command-by-command mutation parity — including identical-member downward-score mutation and reselection from retained members; FR-031/FR-032 deliberately require one score-monotonic singleton instead.
- Changes to `JobLike` or any other existing port signature to add a `Result` channel — throwing-only immutable surfaces use typed `FrameworkError` throws under FR-040.
- Parallel writers to a single journal directory — single-writer contract by design; multi-writer orchestration is the consumer's job.

---

## Open Questions

None outstanding. The full interview was pre-completed: scenario priorities, scope boundary, measurable success criteria, per-P1 acceptance bars, sensitive failure modes, user-visible error states, data/state lifecycle, permissions, external dependencies, and out-of-scope clarifications are all settled and reflected above.

**Deferred to Phase 3 (architecture), not spec ambiguities:** the composite node-key filename encoding scheme (design decision, recommendation recorded in brainstorm open question 4); append-serialization mechanics; record schema field names.

---

## Dependencies

- ADR-0075 — composite checkpoint node-key encoding with canonical folding.
- ADR-0079 — binding file FreshnessIndex singleton selection, reverse-binary tie ordering, lazy TTL parity, and explicit member-history exclusion.
- ADR-0080 — binding failure transport: `Result` wherever immutable signatures permit and typed `FrameworkError` throwing on `JobLike` and other throwing-only surfaces.
- ADR-0017 — framework-version mismatch rejection semantics (`checkpoint-version-mismatch`).
- ADR-0025 — freshness witness contract (`FreshnessIndex` port semantics).
- Kernel state-machine — `replayEvents` pure fold, `Runner` append-before-checkpoint ordering (runner FR-005), `computeDedupKey` injection.
- Shared `checkpointerSuite` — defined in `__tests__/_checkpointer-suite.ts`, parametrized over backends (in-memory, Redis, file).
- `FRAMEWORK_VERSION` and the existing `FrameworkError` kind taxonomy.
- Loom's proven `ProgramJournal` (`claude-plugins/loom/engine/src/orchestration/fugue-program-runtime.ts`) as the validated behavioral reference.

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Crash-window semantics drift (log-ahead-by-one treated as corruption) | High — resume correctness | Crash-window test goes both directions: benign lag recovers, manufactured disagreement fails closed (SC-002) |
| On-disk corruption from partial writes / truncation | High — silent state loss | Strict read-side validation, atomic writes, typed fail-closed errors transported under FR-040 (FR-006, FR-009, FR-028) |
| Composite addressing collides with canonical form or existing layouts | Med — cross-backend inconsistency | Collision-free mapping plus canonical fallback, proven by shared suite across all backends (FR-022, FR-023) |
| “Redis parity” is read as full ZSET history/mutation emulation | High — contradiction with the singleton design | FR-031/FR-032 define the observable singleton boundary, score/tie selection, since/value/missing/TTL behavior, and the identical-member downward-score exclusion; ADR-0079 and tests pin it |
| `Result`-only wording contradicts immutable `JobLike: Promise<void>` signatures | High — either raw throws leak or ports break | FR-040 preserves signatures, requires `Result` where admitted and only typed `FrameworkError` throws elsewhere; ADR-0080 and hostile-boundary tests pin the closed taxonomy |
| Scope creep toward QueueBackend/workers or GC | Med — effort blowout | Explicit Out of Scope list; file worker and reaping deferred to consumers |
| Suites diverging per-backend (file-only exceptions) | Med — specified parity loss | Single parametrized shared suites plus file-specific tests for the explicitly bounded FR-032 singleton and FR-040 throwing surfaces |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| JobLike | The kernel's abstract job handle port: `data`, `updateData`, `updateProgress`, `appendEvent`; its immutable getter/`Promise<void>` surface has no `Result` channel, so file failures cross it only as typed `FrameworkError` throws/rejections (FR-040) |
| dedupKey | Caller/`computeDedupKey`-supplied key making `appendEvent` idempotent under retry |
| Event log | The append-only, ordered, immutable sequence of a job's events; authoritative for resume |
| Checkpoint | The durable post-state projection that may lag the event log by the append→checkpoint window |
| Composite node address | `(namespace, nodeId, index, attempt)` identity for checkpointed node entries; canonical form = `nodeId` when index/attempt are absent |
| checkpointerSuite | The shared parametrized acceptance suite for every `Checkpointer` backend (version, fingerprint, TTL, corrupt-drop, addressing) |
| RecordedEvent | Kernel envelope `{recordedAtMs, event}` returned by event-log readers, consumed by `replayEvents` |
| FrameworkError | The framework's closed typed error union; file boundaries transport it as `Result` where signatures admit that channel and as the only permitted thrown/rejected value on immutable throwing-only signatures |
| FreshnessIndex | The port (`recordWrite` and `findConflict`) for durable stale-write conflict detection; the file adapter retains one score-monotonic live singleton per resource, not Redis member history |
| Observable singleton parity | Freshness behavior shared with Redis at the port boundary: maximum live `(succeededAtMs, memberBytes)` selection, reverse-binary equal-score ordering, inclusive `sinceMs`, same-value suppression, clean missing/expired results, and refresh-on-success TTL; excludes exact ZSET history and identical-member downward rescoring |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-12 | Initial draft from brainstorm + completed interview rulings | specify agent (F6) |
| 2026-08-13 | Repaired FR-032/FR-040 contradictions against binding AD-5/AD-6 and ADR-0079/0080 without changing port signatures | code implementer (T15) |
| 2026-08-21 | Renamed the stale `corruptNodeIds` surface name to the shipped `corruptNodeAddresses` (`CorruptCheckpointAddress` union, ADR-0075) in US2, FR-028, and SC-001 — no port-signature or behavior change (round-29 remediation, comment-analyzer-1) | review-and-fix remediation (round 29) |
