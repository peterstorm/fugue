# F6 — File-backed durable runtime for Fugue (`@fuguejs/framework/file`)

**Status:** Phase 0 brainstorm — approach selected (A, pending confirmation of the single open layout question below). No code, no ADR, nothing committed.

## Building

A durable, Redis-free runtime for Fugue's state-machine kernel and persistence ports, shipped as the `@fuguejs/framework/file` subpath: `createFileJob` (a `JobLike` over an append-only file event log + atomic checkpoint), a file event-log reader, `resumeFileJob` (event-log/checkpoint agreement proof with lagging-checkpoint tolerance), `createFileCheckpointer` (the composite checkpoint address space as a Checkpointer-port backend that must pass the shared `checkpointerSuite`), and `createFileFreshnessIndex` (a durable single-process witness index). This is the primitive Loom's hand-rolled 503-line `ProgramJournal` (claude-plugins/loom/engine/src/orchestration/fugue-program-runtime.ts) retires onto — the biggest unblock per design risk on the roadmap, and now a market parity item (LangGraph SqliteSaver, Hatchet/Temporal/Inngest persist without an external broker). ADR-0075 is written first (next free ADR number; tree tops out at 0074).

## Approach

**Selected: A — minimal parity clone of Loom's proven ProgramJournal + a file Checkpointer.**

- **Job side.** Per-run directory: immutable `events/NNNNNN-<dedupKey>.json` files (sequence = append order, dedup by filename, no index), atomic tmp+rename `checkpoint.json` and `progress.json`, schema-versioned records `{schemaVersion, sequence, dedupKey, recordedAtMs, event}` with strict field validation on parse, dedupKey charset `^[A-Za-z0-9:_-]{1,256}$`, serialized appends via a per-directory lock. The kernel contract is preserved unchanged: append-before-checkpoint (runner.ts FR-005), deterministic dedup keys from the injected `computeDedupKey` (hex-safe), terminal-failed states never checkpointed.
- **Checkpointer side.** Per-run directory: `meta.json` + per-node files under `nodes/` keyed by the composite `(namespace, nodeId, index, attempt)` address. The composite key ships as a backend-agnostic extension of the Checkpointer port (default namespace `"dag"`; absent index/attempt → canonical key = `nodeId`, so existing consumers and on-disk Redis HSET layouts are untouched). Must pass the shared parametric `checkpointerSuite` (ADR-0017 frameworkVersion mismatch rejection, `expectedDagFingerprint` opt-in, 24h TTL expiry evaluated at load, per-entry corrupt-node drop surfacing `corruptNodeIds`).
- **Freshness side.** Per-resource latest-write file (tmp+rename) implementing the `FreshnessIndex` port (`recordWrite` / `findConflict`), crossing the same durability boundary as `RedisFreshnessIndex` for single-process use.

**Rejected — B: full file `QueueBackend` with workers** (enqueue/worker lifecycle/concurrency/attempts/delay/dead-letter/markers). Framework-surface parity with in-memory and BullMQ, but each of those semantics needs its own durability design (leases, retry persistence, marker TTLs) — an order of magnitude more surface with zero current consumers; Loom drives programs by calling `runStateMachine` directly. A file worker later composes `createFileJob` + a small polling loop. YAGNI violation.

**Rejected — C: SQLite-backed** (single-file store, ACID, LangGraph SqliteSaver parity). Ruled out by the convergence decision: pure JSON, no SQLite, no Store in this pass. Adds a native dependency to a dep-graph-clean package and diverges from the validated reference — Loom's proven journal is pure JSON with a known failure model. SQLite remains a possible later backend behind the same ports.

## Key Constraints

1. **Append-before-checkpoint is load-bearing.** The kernel appends the event BEFORE checkpointing the post-state (runner.ts FR-005). A crash leaves the event log ahead of the checkpoint by exactly one transition; resume must treat that window as expected, not corruption.
2. **Dedup-idempotent appends.** A retry re-derives the same dedup key; a second append with a present key is a no-op. Dedup lives in the filename — no index, survives a crash at any point, no lock needed to check it.
3. **Resume discipline (Loom-proven).** Event log is authoritative; checkpoint is a projection that may lag; disagreement between checkpoint and the replay of any strict log prefix = corruption → fail closed. Replay folds events through the pure machine (`replayEvents`), re-invoking no executor.
4. **FR-005 safety.** Terminal-failed states are never checkpointed, so a failed run can never be resumed into a state its own machine rejected.
5. **No Redis, no BullMQ.** Only node:fs / node:crypto / node:path (already used in fingerprint.ts, prompts/registry.ts); `check-imports.ts` rules stay green; `@fuguejs/framework/file` added to `package.json` exports as a clean subpath barrel.
6. **Composite-key decision ships as a backend, not the address-space decision.** Backend-agnostic Checkpointer-port extension of the node key: default namespace `"dag"`, absent index/attempt → canonical key = `nodeId`; Redis and in-memory backends and their on-disk layouts are untouched.
7. **Suite parity.** `createFileCheckpointer` must pass the shared `checkpointerSuite`: ADR-0017 version-mismatch rejection (FRAMEWORK_VERSION), `expectedDagFingerprint` opt-in, 24h TTL expiry, per-entry corrupt drop with `corruptNodeIds` (per-node files make per-entry drop natural; a single aggregate node file would not).
8. **Boundary discipline.** IDs re-validated at the filesystem boundary (`^[A-Za-z0-9_:-]{1,128}$`); every durable write is atomic tmp+rename; appends serialized so sequence = happens-before order; strict read-side validation (schemaVersion, integer non-negative sequence, finite recordedAtMs, dedupKey charset).
9. **No workflow DSL, no Store/memory capability, no F1/F8 work in this pass; framework frozen at 0.4.0.**

## In Scope

- ADR-0075 (composite checkpoint-node-key address space + file backend design), written first.
- `@fuguejs/framework/file` subpath barrel: `createFileJob`, file event-log reader (envelope `{recordedAtMs, event}` shape, replayable via `replayEvents`), `resumeFileJob`, `createFileCheckpointer`, `createFileFreshnessIndex`.
- Composite key extension of the `Checkpointer` port (`saveNode` node-key opts: namespace/index/attempt, canonical fallback to `nodeId`).
- Shared `checkpointerSuite` wired to the file backend + file-specific tests (dedup idempotency, crash-window resume, corrupt-file handling, atomicity).
- Loom retirement of `ProgramJournal` onto the new surface (separate follow-up effort, validating the primitive).

## Out of Scope

- File `QueueBackend`/workers (approach B) — no enqueue/worker lifecycle, retries, backoff, dead-letter, markers in this pass.
- SQLite (approach C) — pure JSON only.
- Store / memory capability (separate future ADR).
- Workflow DSL / generic registry (FR-004 discipline).
- F1 dynamic fan-out, F8 nested subgraph, F4 caching — they only *consume* the composite address space later.
- Changes to existing in-memory/Redis/BullMQ backends or their layouts.
- Migration of historical Loom run directories (depends on the open layout question).

## Open Questions

1. **On-disk layout compatibility with Loom's existing run dirs** (the question posed this session): byte-compatible job-side layout (`events/`, `checkpoint.json`, `progress.json`, record schema) so in-flight Loom run dirs are adoptable without migration, vs fresh canonical layout (default recommendation: follow the proven ProgramJournal conventions; byte-compat where free, but the framework owns its layout — the Loom retirement effort adapts, treating historical dirs as read-only artifacts).
2. **Append-lock hardening**: plain per-directory lock (ProgramJournal parity — recommended for F6 v1) vs anchored O_NOFOLLOW discipline (Loom's production `RunDirHandle`). Hardening is Loom's shell concern; F6 documents the single-writer contract.
3. **Expired-run reaping**: TTL evaluated at load only (mirrors Redis lazy expiry; recommended) vs physical GC of expired run dirs — no background sweeper in this pass.
4. **Composite node-key filename encoding** for `nodes/` files — exact scheme (separators, collision-freedom with the canonical `nodeId` form) deferred to ADR-0075; recommended canonical form encodes namespace/index/attempt only when present, defaulting to `nodeId`.
