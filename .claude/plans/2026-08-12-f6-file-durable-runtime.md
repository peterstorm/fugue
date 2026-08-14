# Plan: F6 — File-backed durable runtime (`@fuguejs/framework/file`)

**Spec:** `.claude/specs/2026-08-12-f6-file-durable-runtime/spec.md`
**Created:** 2026-08-12

## Summary

Ship a filesystem-backed subpath (`@fuguejs/framework/file`) implementing all three durable-runtime ports — `JobLike` (`createFileJob` + event-log reader + `resumeFileJob`), `Checkpointer` (`createFileCheckpointer` over a composite node-address space), and `FreshnessIndex` (`createFileFreshnessIndex`) — with the same port contracts and failure semantics as the Redis/BullMQ backends, zero external dependencies, and strict adherence to the framework's `Result<T,E>`/`FrameworkError` discipline. Approach A (locked): a minimal parity clone of Loom's proven `ProgramJournal` (immutable sequence-prefixed event files + atomic checkpoint projection + log-authoritative resume proof), plus a per-run file Checkpointer that must pass the entire shared `checkpointerSuite` unchanged.

This is the primitive Loom's hand-rolled `ProgramJournal` retires onto. The composite checkpoint address space ships as a backend-agnostic port extension with default-folding to the canonical nodeId key, so existing consumers, the in-memory/Redis backends, and their on-disk layouts are untouched. No file `QueueBackend`, no SQLite, no Store capability, no background GC — all explicitly out of scope.

---

## Architectural Decisions

### AD-1: Composite checkpoint node-key encoding with canonical folding

**Choice:** The `Checkpointer` port gains an optional `saveNode` 4th argument — `opts?: CompositeNodeKeyOpts { namespace?: string; index?: number; attempt?: number }` — and a pure encoding module (`checkpoint/composite-node-key.ts`):

- Canonical form: when `index` and `attempt` are BOTH absent, the stored key is exactly `nodeId` (`CompositeNodeKeyOpts` ignored → byte-identical behavior with every existing consumer and layout).
- Composite form: when either `index` or `attempt` is present, the stored key is `` `${namespace}@${nodeId}@${index}@${attempt}` `` with `namespace` defaulting to `"dag"` and missing `index`/`attempt` defaulting to `0`.
- Separator `@` is outside the framework ID charset (`ID_PATTERN` = `^[A-Za-z0-9_:-]{1,128}$`), so composite keys can never collide with canonical nodeIds (which cannot contain `@`) — collision-free by construction, and parseable by a single unambiguous split (exactly 3 separators ⇒ composite; 0 ⇒ canonical; anything else ⇒ malformed).
- `parseCompositeNodeKey(key)` round-trips any stored key back to `{ form: "canonical", nodeId }` or `{ form: "composite", namespace, nodeId, index, attempt }`; it is exported so consumers can interpret `RunState.nodes` keys and `corruptNodeIds` entries.
- `load` returns node entries keyed by the stored nodeKey (canonical nodeId for canonical saves, the composite string for composite saves); `NodeState.nodeId` inside the entry still names the real node.
- In-memory and Redis backends are NOT extended in this pass: they ignore `opts` exactly as today (spec FR-023; interview ruling 10). Composite semantics are file-backend-only until a later feature (F8 nested subgraph / F1 fan-out) extends the other backends; the shared suite is therefore untouched, and composite coverage lives in file-specific tests.

**Why:** F1/F8/F4 consumers need to checkpoint distinct instances of the same node (indexed fan-out, nested subgraph namespaces, retry attempts) without overwriting each other; the canonical fallback keeps every existing consumer byte-identical and requires no data migration.

**Rejected:**
- Composite key without `@` (e.g. `ns:nodeId:index:attempt` with `:` separators) — `:` IS in the ID charset, so composite keys could collide with a valid canonical nodeId and would not be unambiguously parseable.
- Encoding the nodeKey inside `RunState` as a structured object instead of the string form — breaks `Record<string, NodeState>` and every existing `nodes[nodeId]` consumer.
- Extending Redis/in-memory now — violates ruling 10 and FR-023 (no backend change, no layout change).

### AD-2: On-disk layout — ProgramJournal parity with the digest-filename adaptation

**Choice:** Byte-parity with Loom's proven `ProgramJournal` exactly where free, with ONE deliberate, load-bearing adaptation: record filenames carry the sha256 hex digest of an identifier instead of the raw identifier.

Job side (per run directory):
```
<runDir>/
  events/000000-<digest>.json      immutable; digest = sha256hex(dedupKey)
  events/000001-<digest>.json      sequence prefix = append order; .tmp.* and lock dirs ignored by readers
  events/append.lock/              transient dir lock while an append holds it
  checkpoint.json                  { schemaVersion: 1, data: { state, context } }, atomic tmp+rename
  progress.json                    { percent }, atomic tmp+rename
```
Event record schema (byte-identical to Loom's `ProgramEventRecord`): `{ schemaVersion: 1, sequence, dedupKey, recordedAtMs, event }`, serialized via `toJson` (Map/Set/Date survive), parsed via `tryFromJson` + strict field validation.

The digest adaptation is REQUIRED, not cosmetic: the spec's dedupKey charset upper bound is 256 chars, and `NNNNNN-<256-char-key>.json` (268 bytes) exceeds NAME_MAX (255) on ext4/APFS; the kernel's fallback `computeDedupKey` is string concatenation over arbitrarily large state keys. `-<64-hex-digest>.json` is always 76 bytes. Keyed appends digest `dedupKey` (deterministic across retries — the dedup decision stays "by filename" and stays durable); keyless appends digest `` `${sequence}|${toJson(event)}` `` (content-addressed, so repeated keyless appends never collide and never dedup — matching in-memory/Redis keyless semantics). Every read verifies the filename digest against the parsed content (keyed: `sha256hex(dedupKey)`; keyless: `sha256hex(`${sequence}|${toJson(event)}`)`) — a stronger tamper/tear check than Loom's verbatim naming. Every load-bearing property of the proven layout is preserved: immutability, sequence = order, dedup by filename with no index, atomic append commit (rename).

Checkpointer side (per run, under a caller-supplied base directory):
```
<checkpointBase>/
  <runId>/meta.json               Redis StoredMeta shape + createdAt (server-stamped, ISO)
  <runId>/nodes/<sha256hex(nodeKey)>.json   { nodeKey, nodeId, output, completedAt }
```
Node filenames are digested because composite nodeKeys (`dag@<128>@<10>@<10>` worst case) can also exceed NAME_MAX; the nodeKey itself lives in the entry content and is digest-verified on read. `runId`/`nodeId`/`namespace` directory components are re-validated against `ID_PATTERN` at the filesystem boundary (see Security).

Freshness side: `freshnessDir/<sha256hex(resource)>.json` — see AD-5.

Atomicity: every durable write is `atomicWriteFile` — write to a caller-owned `path.tmp.<unique-token>` in the same directory, `renameSync` onto the final path, unlink only that temp on failure. Readers list only `*.json`, so orphaned tmp files are invisible. Per-attempt temp ownership also prevents same-process/same-target writes from contending on one process-scoped path. Crash model = process crash (rename is the commit point); power-loss durability would additionally require fsync, which Loom's proven reference also omits — flagged as host-shell hardening beyond this pass, not silently claimed.

**Why:** the validated behavioral reference (Loom's journal has been exercised by real orchestration runs) determines the failure model; the digest adaptation fixes a genuine NAME_MAX defect in the raw scheme while preserving every property the layout exists for.

**Rejected:**
- Verbatim `<dedupKey>` filenames (Loom-literal) — a spec-valid 256-char key yields ENAMETOOLONG and fails `appendEvent`; the kernel fallback keyer can produce arbitrarily long keys.
- Truncate-to-fit filenames — two keys sharing a 243-char prefix would silently dedup (false no-op).
- A single aggregate node file (e.g. `nodes.json`) — would lose per-entry corrupt-drop with `corruptNodeIds` (US2 acceptance).
- `fsync` on every write — no consumer depends on power-loss durability in this pass; parity with the reference; documented residual.

### AD-3: Resume agreement proof — log authoritative, checkpoint may lag

**Choice:** `resumeFileJob` reconstructs state by folding the event log through the pure machine (`replayEvents` — never re-invoking the executor) and proves the checkpoint agrees with the log:

1. No recoverable state (directory missing/empty → no event files AND no `checkpoint.json`) ⇒ `checkpoint-missing` (never a silent fresh start).
2. Every event record strictly validated (schemaVersion, non-negative integer sequence, finite `recordedAtMs`, dedupKey charset, filename digest ↔ content, filename prefix ↔ content sequence, contiguous strictly-increasing sequences); ANY violation ⇒ fail closed with `checkpoint-corrupt` (precise message naming the file) — the event log is authoritative, so a corrupt entry is never silently dropped mid-log.
3. Full replay ⇒ `replayed` state; if no `checkpoint.json` ⇒ resume from `replayed` (the benign crash-before-first-checkpoint case).
4. If the checkpoint decodes (via the caller's strict `parseCheckpoint`) and `machine.stateKey(checkpoint.state) === machine.stateKey(replayed.state)` ⇒ agreement, resume from `replayed`.
5. Else, in the SAME single pass, fold the log while comparing each intermediate state key to the checkpoint key. If the checkpoint equals the replay of ANY strict prefix of the log (including the empty prefix = genesis) ⇒ benign lag (the kernel's append-before-checkpoint window, runner FR-005) ⇒ resume from `replayed`.
6. Otherwise the checkpoint disagrees with every state the log provably passed through ⇒ corruption ⇒ fail closed: `checkpoint-corrupt` with a message naming `checkpoint <key>` vs `replay <key>` (plus runId).

The single-pass formulation is semantically identical to Loom's `resumeProgram` (which re-replays prefixes — O(n²) on the disagree path, i.e. on every crash-window resume) but runs the lag test once per transition, O(n). A checkpoint matching any strict prefix is by definition a state the run genuinely occupied — accepting it as "lagging" never masks corruption, because the log alone determines the resumed state.

Terminal-failed states are never checkpointed (kernel FR-005 discipline, unchanged): the file backend merely guarantees it never writes a checkpoint that was not passed through `updateData`, and the proof above would reject a failed-state checkpoint against the log anyway (a failed terminal state's key appears in no prefix replay).

**Why:** this is the exact proven algorithm from Loom's reference, mapped onto `Result<_, FrameworkError>` with the spec's typed error kinds; it converts the crash window from a correctness hazard into the expected, recoverable case while making real corruption fail loudly.

**Rejected:**
- Trusting the checkpoint and replaying only events after it — would silently drop committed transitions on checkpoint corruption (the exact silent-bogus-state NFR-001 forbids).
- Treating any checkpoint/log mismatch as corruption without the prefix test — would turn the benign append→checkpoint window into a spurious failure on every crash resume.
- Resuming from the checkpoint when it agrees — the log is authoritative; the checkpoint is a projection (also keeps replay as the single source of resumed state).

### AD-4: Journal single-writer contract and append serialization

**Choice:** Appends to one journal directory are serialized by a per-directory lock (`events/append.lock` — a rename-based directory lock with a pid file, stale-lock detection via `process.kill(pid, 0)`, atomic birth, ownership-checked release; a port of Loom's `withLock` from its proven lock utility, inside the framework under `file/atomic.ts`). The append transaction — list existing event files, dedup check by filename suffix, assign `sequence = count`, atomic rename commit — runs entirely under the lock, so the persisted sequence equals the happens-before order of appends even when calls interleave (in-process via `Promise.all`, or across the crash-retry boundary). The dedup decision is the durable file listing itself — no index, so a crash at ANY point before or after the rename re-checks the same durable fact and lands as a no-op (SC-003).

Documented contract on the public surface (`createFileJob`):
- ONE `JobLike` writer per run directory (the lock serializes appends across processes too, but `updateData`/`updateProgress` checkpoint writes are deliberately lock-free — two concurrent WRITERS would race the projection, which is out of contract and the resume proof backstops).
- Any number of concurrent READERS — event files are immutable and read without locks.
- Run-directory lifecycle (creation, deletion, retention, reaping) is the consumer's concern; the backend performs no background or out-of-band directory management (FR-044).

**Why:** sequence-must-equal-happens-before is the invariant that makes replay deterministic; Loom's lock is battle-tested and its stale-steal behavior makes crash-retry acquisition safe. Keeping checkpoint writes lock-free preserves the single-writer simplicity the kernel already assumes (one runner loop per run, sequential `appendEvent` → `updateData`).

**Rejected:**
- An in-process mutex only — does not serialize the crash/resume boundary where an old writer process may still be alive.
- Lock-free appends relying on unique tmp names + retry — two concurrent appends with different keys could observe the same listing and claim the same sequence (the exact hazard Loom's comment documents).
- Full descriptor-relative O_NOFOLLOW traversal (Loom's production `RunDirHandle`) — portable Node does not expose openat-style path traversal. The shipped Checkpointer nevertheless rejects pre-existing symlinks at its supplied base and managed run/nodes/file entries, proves canonical parent containment, and rechecks directory identity around writes; malicious concurrent rename substitution remains a documented host-shell concern. The job journal retains its non-adversarial caller-supplied-directory contract.

### AD-5: File FreshnessIndex — digest-addressed latest-write files with lazy TTL parity

**Choice:** `createFileFreshnessIndex(directory)` persists ONE file per resource: `freshnessDir/<sha256hex(resource)>.json` containing `{ writtenAtMs, runId, nodeId, newWitness: { kind, resource, value }, succeededAtMs }`.

- `recordWrite` validates/routes through the digest path and atomically replaces the file (tmp+rename) — a reader observes prior-complete or new-complete, never partial (FR-031).
- `findConflict(conditionedOn, sinceMs)` reads the resource's file: absent ⇒ `ok(null)` (clean no-conflict, never an error); present ⇒ the entry is the LATEST write for that resource (the index holds only latest, matching the port's "latest write wins" semantics); conflict iff `succeededAtMs >= sinceMs && newWitness.value !== conditionedOn.value`.
- 24h TTL is evaluated lazily at `findConflict` (`now() - writtenAtMs > 86_400_000` ⇒ treated as absent), mirroring Redis ZSET lazy expiry visibility — including expiry-window refresh on each write (the file is replaced, so `writtenAtMs` refreshes, exactly like Redis `EXPIRE` on the ZSET key). No background sweeper, no GC.
- Corrupt/structurally-invalid entry: warn via `fwLogger()` and treat as absent — parity with `RedisFreshnessIndex.decodeMember`'s drop-with-warn; the failed record is never REPLACED by a garbage read, and the digest↔content resource check makes a crossed file detectable.
- The resource string is the ONE port value with no length bound (`resourceName()` validates only non-empty) — digest-addressing means the filesystem boundary never sees the raw resource, so no charset rejection surface exists and path escape is impossible by construction (NFR-010). This is a deliberate asymmetry with the checkpointer (whose runId/nodeId ARE bounded by `ID_PATTERN` and are re-validated): fail-closed by never deriving a path from the unbounded value at all.

**Why:** durability parity with `RedisFreshnessIndex` (US3) with the same observable semantics, reusing the digest-filename scheme from AD-2 for uniformity.

**Rejected:**
- Charset-rejecting resources outside `ID_PATTERN` — the port admits any non-empty string; rejection would diverge from Redis for legitimately long resource names.
- Per-resource append-only log files — only the latest write is ever consulted by the port; history is the event log's job.
- Eager TTL sweeps / physical GC — out of scope (spec Out of Scope; lazy evaluation only).

### AD-6: Failure surface — `Result` everywhere the port allows; typed throwing inside the `JobLike` shell

**Choice:** The file backend returns `Result<_, FrameworkError>` across every port boundary whose signature admits it (`Checkpointer.load/saveNode/setMeta`, `FreshnessIndex.recordWrite/findConflict`, `resumeFileJob`, event-log readers), using ONLY existing error kinds:

| Surface | Failure | Kind |
|---|---|---|
| `saveNode`/`setMeta` | invalid runId/nodeId/namespace/index/attempt at the fs boundary | `checkpoint-write-failed` (runId, nodeId, message naming the component) |
| `saveNode`/`setMeta` | fs I/O failure (EACCES/ENOSPC/…) | `cache-error` (operation: "saveNode"/"setMeta") — Redis parity |
| `load` | invalid runId at the fs boundary | `cache-error` (operation: "load") — Redis parity |
| `load` | meta.json unparseable / schema-invalid | `checkpoint-corrupt` |
| `load` | stored frameworkVersion ≠ `FRAMEWORK_VERSION` | `checkpoint-version-mismatch` (ADR-0017) |
| `load` | `expectedDagFingerprint` supplied and absent/different | `checkpoint-version-mismatch` |
| `load` | past-TTL meta (24h, `now()`-injected) | `checkpoint-expired` (expiredAt ISO) |
| `load` | individual node entry corrupt/truncated | DROP + `fwLogger().warn` with run/nodeKey context + `corruptNodeIds` (never an error) — Redis parity |
| `load` | no meta.json | `ok(null)` |
| `resumeFileJob` | no recoverable state | `checkpoint-missing` |
| `resumeFileJob` | corrupt event record / broken sequence / checkpoint decode failure / disagreement | `checkpoint-corrupt` (message names the file + reason) |
| `recordWrite`/`findConflict` | fs I/O or unreadable entry | `cache-error` (operation: "freshness:…") — Redis parity |
| `JobLike` adapter (`appendEvent`/`updateData`/`updateProgress`) | fs I/O failure | throws a typed `FrameworkError` (`cache-error`, operation + directory in message) |

The last row is the honest exception: `JobLike` methods are `Promise<void>` — the port itself has no error channel. The BullMQ adapter's established pattern is to throw (`job.ts` wraps failures in `Error`), and the kernel deliberately lets `appendEvent`/`updateData` failures propagate to the shell (which converts them to typed results). The file adapter therefore throws a TYPED `FrameworkError` rather than a raw `Error`, so the conversion at the shell boundary is identity-safe and FR-040's "typed failures" intent holds to the maximum degree the port contract permits. This is documented in the module header.

**Why:** zero new `FrameworkError` kinds (interview ruling 9), byte-parity error semantics with the Redis backend per surface, and honesty about the one throw surface the framework's own port shape forces.

**Rejected:**
- New error kinds (e.g. `file-io`) — ruling 9 forbids; `cache-error` + precise `operation`/`message` already match the Redis adapters' taxonomy.
- Swallowing or converting JobLike failures to `ok(undefined)` — would violate append-before-checkpoint durability (a failed append must abort the transition so the retry re-derives it).
- Returning `Result` from JobLike methods — would change the kernel's `JobLike` contract; out of scope for F6.

---

## File Structure

All paths under `packages/framework/` unless noted.

### File backend — new module tree `src/file/`

```
src/file.ts                        — @fuguejs/framework/file subpath barrel (exists from Phase 1, grows per phase)
src/file/layout.ts                 — path constants, schema version, ID_PATTERN boundary validator, keyDigest, filename mapping
src/file/atomic.ts                 — atomicWriteFile (tmp+rename), withFileLock (dir lock: pid, stale steal, ownership release)
src/file/event-record.ts           — FileEventRecord type, serialize, strict parseFileEventRecord (pure)
src/file/journal.ts                — createFileJournal: appendEvent (lock+dedup+sequence), writeCheckpoint, writeProgress, readCheckpoint
src/file/event-log.ts              — readFileEventRecords / readFileEvents (strict read side, envelopes for replayEvents)
src/file/job.ts                    — createFileJob → JobLike<S, unknown, C> over a FileJournal
src/file/resume.ts                 — resumeFileJob: replay + agreement proof (AD-3)
src/file/checkpointer.ts           — createFileCheckpointer → Checkpointer (composite address space)
src/file/freshness-index.ts        — createFileFreshnessIndex → FreshnessIndex
```

### Checkpointer port extension

```
src/checkpoint/composite-node-key.ts   — CompositeNodeKeyOpts, compositeNodeKey, parseCompositeNodeKey, DEFAULT_NODE_NAMESPACE (pure)
src/checkpoint/checkpointer.ts         — Checkpointer.saveNode gains optional SaveNodeOpts 4th param; doc block for nodeKeys on RunState
src/checkpoint/index.ts                — export the new composite-node-key surface (main barrel)
```

### Subpath wiring & boundaries

```
package.json                          — exports: add "./file": "./src/file.ts"
src/scripts/check-imports.ts          — new rule: scope ["file", "file.ts"], forbiddenModules ["bullmq","ioredis","queue-bullmq"]
docs/adr/0075-file-backend-durable-runtime.md   — ADR (composite address space + file backend design); registered in docs/adr/README.md index
```

### Tests (`src/__tests__/`)

```
_checkpointer-suite.ts            — EXTRACTED shared parametric suite (checkpointerSuite + CheckpointerSuiteRaw) from redis-checkpointer.test.ts
composite-node-key.test.ts        — encoding, folding, round-trip, collision-freedom (+ fast-check property)
file-atomic.test.ts               — tmp+rename atomicity, lock serialization, stale-lock steal
file-layout.test.ts               — boundary charset validator, digest/filename mapping
file-event-record.test.ts         — strict parse matrix (+ property: malformed generators rejected)
file-journal.test.ts              — append/dedup/sequence/atomicity/durability across instances
file-job.test.ts                  — JobLike semantics incl. kernel-driven dedup across simulated crash, concurrent append serialization
file-resume.test.ts               — SC-002 both directions, checkpoint-missing, corrupt variants, terminal-failed, replay-only
file-checkpointer.test.ts         — ENTIRE shared suite + composite addressing + corrupt-drop + boundary rejections + atomicity
file-freshness-index.test.ts      — SC-007 restart durability, atomic replace, no-record, conflict parity, lazy TTL
file-boundary.test.ts             — hostile-identifier sweep across all three surfaces (NFR-010)
```

### Modified (existing)

```
src/__tests__/redis-checkpointer.test.ts   — imports the extracted shared suite instead of defining it inline; Redis-specific tests unchanged
```

---

## Component Design

### file/layout.ts

**Responsibility:** single source of truth for the on-disk contract — names, schema version, and the fail-closed boundary validator.
**Depends on:** `types/ids.js` (`ID_PATTERN`), `node:crypto`.

```
export const EVENTS_DIR = "events";
export const CHECKPOINT_FILE = "checkpoint.json";
export const PROGRESS_FILE = "progress.json";
export const META_FILE = "meta.json";
export const NODES_DIR = "nodes";
export const APPEND_LOCK = "append.lock";
export const JOURNAL_SCHEMA_VERSION = 1;
export const TTL_SECONDS = 86_400;                       // checkpointer + freshness, matches Redis

export const isBoundaryId = (value: unknown): boolean;   // ID_PATTERN test (string + charset + ≤128)
export const keyDigest = (key: string): string;          // sha256 hex (64 chars)
export const eventFileName = (sequence: number, digest: string): string;   // `${pad6(seq)}-${digest}.json`
export const eventDigestOf = (record: { dedupKey: string; sequence: number; event: unknown }): string;
// keyed: sha256hex(dedupKey); keyless (dedupKey === ""): sha256hex(`${sequence}|${toJson(event)}`)
```

Every path construction in the backend goes through validation first and `join` second — never string concatenation with raw identifiers (see Security). Only `node:fs`, `node:crypto`, `node:path` are imported anywhere under `src/file/` (check-imports rule from Phase 1).

### file/atomic.ts

**Responsibility:** the two durability primitives — atomic commit and cross-process append serialization.
**Depends on:** `node:fs`, `node:path`.

```
export const atomicWriteFile = (path: string, contents: string): void;
// writeFileSync(`${path}.tmp.${uniqueToken()}`, contents) → renameSync(tmp, path);
// each call owns a distinct same-directory temp; on failure unlink only that temp, rethrow.

export const withFileLock = <T>(lockPath: string, fn: () => T | Promise<T>): Promise<T>;
// rename-born directory lock at `${lockPath}.lock`: stage pid file in a private birth dir,
// rename onto the lock path; EEXIST/ENOTEMPTY ⇒ held (retry loop, ms backoff);
// stale detection (pid dead) ⇒ atomic steal-to-tomb; ownership-checked release (only the
// recorded pid removes the lock). Port of Loom's proven withLock.
```

### file/event-record.ts

**Responsibility:** pure record codec — the strict parse is the fail-closed read-side gate (FR-009).
**Depends on:** `types/result.js`, `state-machine/serialize.js` (`toJson`, `tryFromJson`), `file/layout.js`.

```
export interface FileEventRecord {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;        // non-negative integer
  readonly dedupKey: string;        // "" (keyless) or ^[A-Za-z0-9:_-]{1,256}$
  readonly recordedAtMs: number;    // finite
  readonly event: unknown;          // any JSON-safe value (toJson-serialized)
}

export const serializeFileEventRecord = (sequence: number, dedupKey: string, recordedAtMs: number, event: unknown): string;
export const parseFileEventRecord = (raw: unknown, source: string): Result<FileEventRecord, string>;
// Rejects: non-object/array raw, wrong schemaVersion, non-integer/negative sequence,
// invalid dedupKey charset ("" allowed), non-finite recordedAtMs, missing event.
```

### file/journal.ts + file/event-log.ts

**Responsibility:** the durable store (write side) and the strict reader (read side). The reader is separate so resume, forensic consumers, and tests share one validated path.
**Depends on:** `file/layout.js`, `file/atomic.js`, `file/event-record.js`, `state-machine/serialize.js`, `types/errors.js`.

```
export interface FileJournal {
  appendEvent(event: unknown, dedupKey?: string): Promise<void>;   // throws typed FrameworkError (AD-6)
  writeCheckpoint(json: string): Promise<void>;                     // atomicWriteFile(checkpoint.json)
  writeProgress(percent: number): Promise<void>;                    // atomicWriteFile(progress.json, toJson({percent}))
  readCheckpoint(): string | null;
}
export const createFileJournal = (directory: string, opts?: { now?: () => number }): FileJournal;
// appendEvent: withFileLock(join(eventsDir, APPEND_LOCK), ...):
//   existing = list *.json in events/ (mkdir recursive first)
//   keyed && existing.some(name => name.endsWith(`-${keyDigest(dedupKey)}.json`)) ⇒ no-op
//   sequence = existing.length; record = {schemaVersion:1, sequence, dedupKey: dedupKey ?? "", recordedAtMs: now(), event}
//   atomicWriteFile(join(eventsDir, eventFileName(sequence, eventDigestOf(record))), toJson(record))

export const readFileEventRecords = (directory: string): Result<readonly FileEventRecord[], FrameworkError>;
export const readFileEvents = (directory: string): Result<readonly RecordedEvent<unknown>[], FrameworkError>;
// read: list *.json sorted; per file: tryFromJson → parseFileEventRecord (fail closed, named source)
// sequence continuity: filename prefix === pad6(sequence) AND sequences strictly contiguous 0..n-1
// filename digest recomputed from content (keyed/keyless per AD-2) and compared — mismatch ⇒ checkpoint-corrupt
// readFileEvents maps records → { recordedAtMs, event } envelopes (FR-008)
```

### file/job.ts

**Responsibility:** `JobLike` adapter over a `FileJournal` — the kernel's durable write surface.
**Depends on:** `state-machine/types.js`, `file/journal.js`, `file/resume` (none — resume is a sibling).

```
export interface FileJobOptions { readonly now?: () => number; }
export const createFileJob = <S, C>(args: {
  readonly directory: string;
  readonly initial: { state: S; context: C };
  readonly now?: () => number;
}): JobLike<S, unknown, C>;
// get data() → current in-memory snapshot (seeded with `initial` = genesis or resumed state)
// updateData(d) → journal.writeCheckpoint(toJson({schemaVersion:1, data:{state, context}})); snapshot = d
// updateProgress(pct) → journal.writeProgress(pct)
// appendEvent(event, dedupKey?) → journal.appendEvent(event, dedupKey)
// Throws typed FrameworkError (cache-error) on fs failure — AD-6
```

### file/resume.ts

**Responsibility:** log-authoritative state reconstruction + the agreement proof (AD-3).
**Depends on:** `file/event-log.js`, `file/journal.js` (readCheckpoint), `state-machine/replay.js`, `types/errors.js`.

```
export const resumeFileJob = async <S, E, C>(args: {
  readonly runId: RunId;                        // for typed error reporting
  readonly directory: string;
  readonly machine: Machine<S, E, C>;
  readonly genesis: { state: S; context: C };
  readonly parseCheckpoint: (data: unknown) => Result<{ state: S; context: C }, string>;
}): Promise<Result<{ state: S; context: C }, FrameworkError>>;
// Algorithm (AD-3): empty ⇒ checkpoint-missing; read records (fail closed); replay;
// absent checkpoint ⇒ ok(replayed); stateKey equality ⇒ ok(replayed);
// single-pass prefix scan ⇒ benign lag ⇒ ok(replayed); else ⇒ checkpoint-corrupt.
```

### checkpoint/composite-node-key.ts

**Responsibility:** pure, backend-agnostic composite address codec (AD-1). No I/O.
**Depends on:** `types/ids.js` (`NodeId`), `types/result.js` not needed (validation returns `string | null` style guards kept minimal — see interface).

```
export const DEFAULT_NODE_NAMESPACE = "dag";
export interface CompositeNodeKeyOpts {
  readonly namespace?: string;   // default "dag"; ID_PATTERN-validated at the fs boundary
  readonly index?: number;       // non-negative safe integer
  readonly attempt?: number;     // non-negative safe integer
}
export const compositeNodeKey = (nodeId: NodeId, opts?: CompositeNodeKeyOpts): string;
// index/attempt both absent ⇒ nodeId; else `${namespace ?? "dag"}@${nodeId}@${index ?? 0}@${attempt ?? 0}`
export type ParsedCompositeNodeKey =
  | { readonly form: "canonical"; readonly nodeId: string }
  | { readonly form: "composite"; readonly namespace: string; readonly nodeId: string; readonly index: number; readonly attempt: number };
export const parseCompositeNodeKey = (key: string): ParsedCompositeNodeKey | null;
// 0 separators ⇒ canonical; exactly 3 ⇒ composite (components re-validated); else null
```

### file/checkpointer.ts

**Responsibility:** `Checkpointer` backend over per-run `meta.json` + `nodes/` digest files, passing the shared suite in full.
**Depends on:** `checkpoint/checkpointer.js` (port + `FRAMEWORK_VERSION`), `checkpoint/composite-node-key.js`, `file/layout.js`, `file/atomic.js`, `types/error-factories.js`, `logger.js`.

```
export interface FileCheckpointerOptions { readonly now?: () => number; }
export const createFileCheckpointer = (directory: string, opts?: FileCheckpointerOptions): Checkpointer;

// setMeta(runId, meta):  validate runId ⇒ checkpoint-write-failed;
//   atomic write `${dir}/${runId}/meta.json` = { dagId, startedAt: ISO, nodeCount,
//   createdAt: new Date(now()).toISOString(), subject?, dagFingerprint?,
//   frameworkVersion: meta.frameworkVersion ?? FRAMEWORK_VERSION }
// saveNode(runId, nodeId, state, opts?): validate runId/nodeId/namespace/index/attempt ⇒ checkpoint-write-failed;
//   nodeKey = compositeNodeKey(nodeId, opts); atomic write `nodes/<keyDigest(nodeKey)>.json`
//   = { nodeKey, nodeId, output, completedAt: ISO }
// load(runId, opts?): no meta ⇒ ok(null); parse meta (fail ⇒ checkpoint-corrupt); ADR-0017 version check;
//   expectedDagFingerprint opt-in check; 24h TTL via now() ⇒ checkpoint-expired;
//   list nodes/*.json → parse each { nodeKey, nodeId, output, completedAt } + filename-digest ↔ content.nodeKey check;
//   per-entry failure ⇒ fwLogger().warn(`[FileCheckpointer] Dropping corrupt checkpoint entry runId=… nodeKey=…`) + corruptNodeIds (nodeKey if recoverable, else filename);
//   nodes keyed by nodeKey.
```

### file/freshness-index.ts

**Responsibility:** durable per-resource latest-write index (AD-5).
**Depends on:** `types/freshness.js` (port, `__brandWitness`, `__brandRunId`, `__brandNodeId`), `types/events.js` (`WriteAttemptedEvent`), `file/layout.js`, `file/atomic.js`, `logger.js`.

```
export interface FileFreshnessIndexOptions { readonly now?: () => number; }
export const createFileFreshnessIndex = (directory: string, opts?: FileFreshnessIndexOptions): FreshnessIndex;
// recordWrite(event): atomic write `<dir>/<keyDigest(event.newWitness.resource)>.json`
//   = { writtenAtMs: now(), runId, nodeId, newWitness: {kind, resource, value}, succeededAtMs }
// findConflict(conditionedOn, sinceMs): read file; absent ⇒ ok(null);
//   digest↔content resource check + shape validation fail ⇒ warn + ok(null) (Redis decodeMember parity);
//   writtenAtMs older than TTL ⇒ ok(null) (lazy expiry);
//   succeededAtMs >= sinceMs && value differs ⇒ ok(WriteEntry); else ok(null).
```

---

## Data Flow

```
Fresh run:   createFileJob(dir, genesis) ──runStateMachine──► events/NNNNNN-*.json (+ checkpoint.json, progress.json)
                 appendEvent (durable commit) → updateData (atomic projection)  [kernel FR-005 ordering]

Crash window: append committed, checkpoint stale ──► resumeFileJob(dir, machine, genesis, parseCheckpoint)
                 readFileEventRecords → replayEvents (pure fold, no executor) → agreement proof
                 ⇒ {state, context} → createFileJob(dir, resumed) → continue the run

DAG resume:   createFileCheckpointer(base) ──setMeta/saveNode(runId, nodeId, state, {namespace, index, attempt})──►
                 base/<runId>/meta.json + base/<runId>/nodes/<digest>.json
              load(runId, {expectedDagFingerprint}) ⇒ RunState | null  [version → fingerprint → TTL → nodes]

Freshness:    recordWrite(WriteAttemptedEvent) ──► freshnessDir/<digest(resource)>.json (atomic latest-write replace)
              findConflict(Witness, sinceMs) ──► WriteEntry | null   [TTL-lazy → latest-write conflict compare]
```

Key transformations: the event log is the only authoritative record — the checkpoint and progress files are atomic projections derived from it; every byte read at any boundary crosses the strict validator before it becomes a type.

---

## Invariants

Executable-model policy note: no `## Lifecycles` (framework library code, not a domain lifecycle) and no `## Pipeline` (ruling 13). All invariants below are honestly tiered `advisory`: line-based lint rules are path-blind (they cannot scope `node:*`-import or filename-discipline patterns to `src/file/`), the boundary config cannot express deny-all-with-allowlist over `node:*`, and identifier-interpolation patterns false-positive across the existing codebase (e.g. `chkpt:${runId}` in the Redis adapter). Where a deterministic gate exists it lives in the repo's own machinery and is cited per invariant.

### INV-1: File backend import boundary

**Tier:** advisory
**Statement:** Everything under `src/file/` (and the `src/file.ts` barrel) imports only `node:fs`, `node:crypto`, `node:path` among `node:*` modules and never imports `bullmq`, `ioredis`, or `queue-bullmq`; no new package dependencies (FR-041/FR-043).
**Enforcement:** deterministic — the Phase-1 `check-imports.ts` rule (scope `file` + `file.ts`, forbidden broker modules) is a hard-fail gate via the existing `boundary-imports.test.ts` (SC-006) and runs before any other phase lands. Not expressible as a lint regex rule (path-blind line matcher); stated here so impl agents never "simplify" the import set.

### INV-2: Sequence equals happens-before order (single-writer contract)

**Tier:** advisory
**Statement:** For one journal directory, the persisted event sequence equals the happens-before order of `appendEvent` calls; exactly one `JobLike` writer per directory is the documented contract; dedup decisions are durable by construction (filename presence, no index).
**Enforcement:** design (per-directory append lock, AD-4) + the concurrent-append serialization test and cross-instance dedup tests (SC-003); not statically checkable — a lint rule cannot observe interleaving.

### INV-3: Lazy TTL only — no background sweeper or physical GC

**Tier:** advisory
**Statement:** The file backend evaluates the 24h TTL lazily at `load`/`findConflict` and never performs background or out-of-band directory management; run-directory lifecycle belongs to the consumer (FR-027/FR-044).
**Enforcement:** design + code review; a lint rule cannot distinguish a legitimate timer from a sweeper.

---

## Implementation Phases

### Phase 1: Boundaries, atomic primitives, and the composite address space (no dependencies)

- Write `src/file/layout.ts` (constants, `isBoundaryId`, `keyDigest`, `eventFileName`, `eventDigestOf`) and `src/file/atomic.ts` (`atomicWriteFile`, `withFileLock` — port of Loom's proven lock).
- Add `src/checkpoint/composite-node-key.ts` (AD-1 codec); export it from `src/checkpoint/index.ts`; extend the `Checkpointer` interface with the optional `SaveNodeOpts` param and document nodeKey semantics on `RunState`.
- Add the `check-imports.ts` rule for scope `["file", "file.ts"]` (forbidden: `bullmq`, `ioredis`, `queue-bullmq`).
- Add `"./file": "./src/file.ts"` to `package.json` exports; create the empty `src/file.ts` barrel (exports grow per phase).
- Write ADR `docs/adr/0075-file-backend-durable-runtime.md` (composite address space + file backend design) per `docs/adr/adr-template.md` and register it in `docs/adr/README.md` (next index row).
- Tests: `composite-node-key.test.ts` (folding, round-trip, collision-freedom, plus a fast-check property: distinct valid addresses ⇒ distinct keys, `parse(encode(a)) = a`), `file-atomic.test.ts` (atomic commit, interrupted-write litter ignored, lock mutual exclusion, stale-lock steal), `file-layout.test.ts` (boundary validator matrix incl. hostile strings, digest/filename mapping).
- **Files:** `src/file/layout.ts`, `src/file/atomic.ts`, `src/file.ts`, `src/checkpoint/composite-node-key.ts`, `src/checkpoint/index.ts`, `src/checkpoint/checkpointer.ts`, `src/scripts/check-imports.ts`, `package.json`, `docs/adr/0075-file-backend-durable-runtime.md`, `docs/adr/README.md`, `src/__tests__/composite-node-key.test.ts`, `src/__tests__/file-atomic.test.ts`, `src/__tests__/file-layout.test.ts`.

### Phase 2: Journal, event log, and `createFileJob` (depends on Phase 1)

- Write `src/file/event-record.ts` (strict record codec), `src/file/journal.ts` (`createFileJournal`: locked append with durable dedup + sequence, atomic checkpoint/progress writes), `src/file/event-log.ts` (strict reader: contiguous sequences, filename digest ↔ content verification, envelope mapping), `src/file/job.ts` (`createFileJob`; typed throw on fs failure).
- Extend `src/file.ts` with `createFileJob`, `readFileEvents`, `readFileEventRecords` and their types.
- Tests: `file-event-record.test.ts` (strict-parse matrix + property: malformed-record generator rejected), `file-journal.test.ts` (dedup no-op incl. across a fresh instance = simulated crash, sequence contiguity, atomicity — reader never sees partial `checkpoint.json`, tmp litter invisible, concurrent `Promise.all` appends produce distinct increasing sequences), `file-job.test.ts` (kernel-driven: `runStateMachine` over a real file job; the runner-crash pattern — crash between `appendEvent`/`updateData` — then a second run re-deriving the same dedup key lands exactly one record; state survives in a fresh job instance over the same directory).
- **Files:** `src/file/event-record.ts`, `src/file/journal.ts`, `src/file/event-log.ts`, `src/file/job.ts`, `src/file.ts`, `src/__tests__/file-event-record.test.ts`, `src/__tests__/file-journal.test.ts`, `src/__tests__/file-job.test.ts`.

### Phase 3: `resumeFileJob` — the agreement proof (depends on Phase 2)

- Write `src/file/resume.ts` with the AD-3 algorithm (single-pass replay + prefix scan; `checkpoint-missing` for empty dirs; `checkpoint-corrupt` for corrupt records, sequence breaks, decode failure, disagreement — precise messages naming file/keys).
- Extend `src/file.ts` with `resumeFileJob`.
- Tests: `file-resume.test.ts` — SC-002 both directions: (a) crash between append and checkpoint (real `runStateMachine` + `createFileJob`, crash injected between the two writes) resumes and recovers the lagging checkpoint by replay; (b) manufactured disagreement (checkpoint.json edited to a state the log never passed through) fails closed with `checkpoint-corrupt`; plus checkpoint-missing on empty dir, corrupt event record fail-closed, sequence-gap fail-closed, filename-digest mismatch fail-closed, replay-only resume (no checkpoint.json), terminal-failed run never leaves a checkpoint of the failed state, resume from a completed journal round-trips to the identical final state (SC-001 replay proof).
- **Files:** `src/file/resume.ts`, `src/file.ts`, `src/__tests__/file-resume.test.ts`.

### Phase 4: File Checkpointer + shared suite extraction (depends on Phase 1)

- Extract `checkpointerSuite` + `CheckpointerSuiteRaw` from `src/__tests__/redis-checkpointer.test.ts` into `src/__tests__/_checkpointer-suite.ts`; refactor the Redis test to import it (Redis-specific tests stay put).
- Write `src/file/checkpointer.ts` (`createFileCheckpointer` per AD-1/AD-2/AD-6: meta.json + nodes/ digest files, boundary validation ⇒ `checkpoint-write-failed`, `cache-error` on fs I/O, per-entry corrupt drop with `corruptNodeIds` + `fwLogger().warn`, TTL/version/fingerprint checks in Redis load order).
- Extend `src/file.ts` with `createFileCheckpointer`.
- Tests: `file-checkpointer.test.ts` — the ENTIRE extracted suite (fresh temp dir per case via factory + cleanup; raw-bypass callbacks write raw `meta.json` for stale-version / missing-version / expired / corrupt-meta cases) with ZERO backend-specific carve-outs; plus composite addressing (canonical vs `dag@n@i@a` entries all distinct and all returned; namespace/index/attempt permutations), corrupt-node drop surfacing `corruptNodeIds` with keyed and composite keys, hostile-identifier rejections (`checkpoint-write-failed`; path traversal never escapes the base dir), atomicity (saveNode leaves no partial node file visible to a concurrent load), load of unknown run ⇒ clean `null`.
- **Files:** `src/file/checkpointer.ts`, `src/file.ts`, `src/__tests__/_checkpointer-suite.ts`, `src/__tests__/redis-checkpointer.test.ts`, `src/__tests__/file-checkpointer.test.ts`.

### Phase 5: File FreshnessIndex + cross-cutting boundary sweep + verification (depends on Phase 1)

- Write `src/file/freshness-index.ts` (`createFileFreshnessIndex` per AD-5: digest-addressed latest-write files, atomic replace, lazy 24h TTL at `findConflict`, `cache-error` parity, warn+absent on corrupt entries).
- Extend `src/file.ts` with `createFileFreshnessIndex` (barrel complete).
- Tests: `file-freshness-index.test.ts` — SC-007 restart durability (record in instance A, `findConflict` in a fresh instance B over the same dir detects the stale-write conflict), atomic replace (reader sees prior or new), no-record ⇒ clean `ok(null)`, semantics parity vs the in-memory index on a scenario table (sinceMs boundaries, same-value no-conflict), lazy TTL expiry; `file-boundary.test.ts` — hostile-identifier sweep across all three surfaces (`../`, `..%2F`, absolute paths, NUL, charset violations, 129-char ids, `$input`-style reserved strings) asserting typed failures and that nothing is ever created outside the caller-supplied directories.
- Full verification: `bun run typecheck` (both tsconfigs), `bun test` in `packages/framework` (zero failures, no regressions in in-memory/Redis/BullMQ), boundary-imports green — mapping SC-001…SC-007; final read of the exported `src/file.ts` barrel against the spec's FR-001…FR-044 surface.
- **Files:** `src/file/freshness-index.ts`, `src/file.ts`, `src/__tests__/file-freshness-index.test.ts`, `src/__tests__/file-boundary.test.ts`.

---

## Testing Strategy

| Component | Unit (pure) | Integration (I/O) | Property |
|---|---|---|---|
| `checkpoint/composite-node-key.ts` | folding rules, canonical fallback, parse round-trip, malformed rejects | — | fast-check: distinct valid addresses ⇒ distinct keys; `parse(encode(a)) === a`; canonical keys never contain `@` |
| `file/layout.ts` | boundary validator matrix, digest mapping, filename formatting | — | charset/长度 boundary fuzz |
| `file/atomic.ts` | — | atomic commit + litter invisibility, lock mutual exclusion (concurrent `Promise.all`), stale-lock steal | lock re-entrancy exclusion |
| `file/event-record.ts` | strict-parse matrix (schemaVersion, sequence, dedupKey charset incl. `""` and 256-char, recordedAtMs finiteness, missing `event`) | — | malformed-record generator: every generated invalid record rejected; valid records round-trip |
| `file/journal.ts` | — | dedup no-op across instances (simulated crash), sequence contiguity + serialization, atomicity of checkpoint/progress, append lock across async interleaving | — |
| `file/job.ts` | — | kernel-driven dedup crash window, durability across fresh instances, progress/checkpoint round-trip | — |
| `file/resume.ts` | agreement matrix (agree / lag-by-one / lag-by-many-prefix / disagree / empty) over synthetic records | crash-window resume via real `runStateMachine`; corrupt-file variants on disk; checkpoint-missing | replay determinism: same journal ⇒ same resumed state |
| `file/checkpointer.ts` | boundary rejection mapping table | ENTIRE shared `checkpointerSuite` + composite addressing + corrupt-drop + TTL + atomicity | — |
| `file/freshness-index.ts` | conflict decision table (sinceMs boundaries, same-value, expired) | SC-007 restart durability, atomic replace | scenario parity vs `InMemoryFreshnessIndex` |
| cross-cutting | — | hostile-identifier sweep (all surfaces) | — |

The shared `checkpointerSuite` is the antidote to per-backend drift (spec risk "suites diverging per-backend"): the file backend gets no acceptance carve-outs, composite coverage is additive in file-specific tests only, and the existing in-memory/Redis suite entries are byte-identical after extraction.

---

## Security & NFR Notes

- **Trust boundary (primary risk):** identifiers and address components are re-validated at the filesystem boundary (FR-016, FR-029, NFR-010): runId/nodeId/namespace against `ID_PATTERN` (`^[A-Za-z0-9_:-]{1,128}$`), index/attempt as non-negative safe integers, dedupKey against its 256-char charset at append. Paths are built with `join` AFTER validation — raw identifiers never reach a path string. Every failure is typed (`checkpoint-write-failed` on the write side, `cache-error` on the load side / freshness). The one unbounded port value (freshness `resource`) is addressed by digest only — no path is ever derived from it (AD-5). Hostile-identifier tests (`../`, absolute paths, NUL, charset violations) assert nothing is created outside the caller-supplied directory.
- **Symlink anchoring:** the plain job-journal dir-lock and tmp+rename primitive do not carry descriptor-relative O_NOFOLLOW discipline (Loom's production `RunDirHandle` does); that surface assumes a caller-protected, non-adversarial run directory. The Checkpointer is stricter: its supplied base and managed run/nodes entries are `lstat`/`realpath`-verified as non-symlink directories under their canonical parent, readable files must be regular non-symlinks, and directory identity is rechecked around writes. Portable Node cannot eliminate a malicious concurrent rename race without openat-style APIs, so that residual is not silently claimed away.
- **Durability model:** process-crash durability (kill -9, exceptions) is fully covered by tmp+rename — rename is the commit point, and readers only ever see `*.json`. Power-loss durability (fsync before rename) is a documented residual shared with the Loom reference (AD-2). The crash-window test (SC-002) proves resume never silently proceeds on corruption (NFR-001/002).
- **Performance:** appends are O(files-in-events-dir) under the lock — appropriate for run journals (hundreds to low thousands of transitions); the resume proof is O(n) single-pass (AD-3); TTL expiry is lazy at load/findConflict only — no background work of any kind (FR-044).
- **Observability:** `fwLogger().warn` on every dropped corrupt checkpoint node entry (runId + nodeKey) and on corrupt freshness entries, mirroring `RedisCheckpointer.load` / `decodeMember`; `corruptNodeIds` surfaced on `RunState` (FR-028) — callers can always distinguish "never ran" from "ran but stored corrupt".

---

## Verification

1. `cd packages/framework && bun run typecheck` — zero errors (SC-004; both `tsconfig.json` and `tsconfig.bin.json`).
2. `cd packages/framework && bun test` — zero failures; existing in-memory/Redis/BullMQ suites stay green (SC-005), with the shared `checkpointerSuite` now parametrized over InMemory + (env-gated) Redis + File.
3. `bun test src/__tests__/file-checkpointer.test.ts` — the ENTIRE shared suite passes against `createFileCheckpointer` with zero carve-outs (SC-001).
4. `bun test src/__tests__/file-resume.test.ts` — crash-window both directions: benign lag recovers, manufactured disagreement fails closed with `checkpoint-corrupt` (SC-002).
5. `bun test src/__tests__/file-journal.test.ts` — dedup idempotency incl. the cross-instance simulated crash; exactly one record (SC-003).
6. Boundary gate — `bun test src/__tests__/boundary-imports.test.ts` — zero violations including the new `file` scope (SC-006).
7. `bun test src/__tests__/file-freshness-index.test.ts` — restart durability with conflict semantics identical to `RedisFreshnessIndex` (SC-007).
8. Manual surface read: `@fuguejs/framework/file` exports exactly `createFileJob`, `resumeFileJob`, `readFileEvents`, `readFileEventRecords`, `createFileCheckpointer`, `createFileFreshnessIndex` (+ types); main-barrel consumers and the in-memory/Redis backends unchanged (FR-042, NFR-020).
