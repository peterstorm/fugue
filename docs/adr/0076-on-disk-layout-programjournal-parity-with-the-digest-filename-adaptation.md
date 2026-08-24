# ADR-0076: On-disk layout — ProgramJournal parity with the digest-filename adaptation

## Status
Accepted

## Date
2026-08-14

## Context
Fugue needed a filesystem-backed durable `JobLike` that could replace Loom's hand-written `ProgramJournal` without introducing Redis, BullMQ, SQLite, or an external registry. The journal directory must be sufficient to recover a run in a fresh process. Its event log must preserve append order (FR-002), make keyed retries durably idempotent (FR-004), and remain strict enough that corrupt authoritative history is rejected rather than partially replayed (FR-009).

Loom's deployed `ProgramJournal` supplied a validated failure model: one immutable, sequence-prefixed JSON file per event; deduplication from the durable directory listing rather than an in-memory index; and atomic replacement of checkpoint and progress projections. Reusing that model reduced semantic risk, but its literal `NNNNNN-<dedupKey>.json` filename is not portable to the framework contract. FR-015 admits deduplication keys up to 256 characters, making a literal event filename 268 bytes, beyond the common 255-byte `NAME_MAX`; future composite checkpoint node keys can be longer still.

The layout therefore had to retain the reference journal's ordering, crash-retry, and atomic-commit properties while bounding every generated filename, keeping raw identifiers out of digest-addressed paths, and making a filename independently checkable against the record it claims to contain. Process-crash durability was required; power-loss durability through directory and file `fsync` was not.

## Options Considered

1. **ProgramJournal parity with digest-addressed filenames**
   - Pros: Preserves the proven immutable-file, sequence-prefix, listing-based deduplication, and atomic-rename model; produces fixed-size portable filenames; supports the full FR-015 key range; permits filename-to-content verification without a separate index.
   - Cons: Filenames are no longer human-readable keys; SHA-256 introduces a theoretical collision risk; readers must parse content to recover identifiers and must verify the digest.

2. **Use Loom's literal `<dedupKey>` and `<nodeKey>` filenames**
   - Pros: Closest visual and byte-level match to the reference; identifiers are visible during manual inspection; keyed deduplication is a simple literal suffix check.
   - Cons: A valid 256-character deduplication key exceeds common `NAME_MAX` once the sequence prefix and extension are added; composite node keys can also exceed the limit; raw identifiers become filesystem addressing material.

3. **Truncate raw identifiers to fit `NAME_MAX`**
   - Pros: Keeps a partly readable filename and avoids hashing machinery.
   - Cons: Distinct keys with a shared prefix can map to the same filename, causing a false deduplication no-op or checkpoint overwrite; no safe truncation length works for all filesystems and suffixes.

4. **Store events or checkpoint nodes in aggregate JSON files**
   - Pros: Avoids per-identifier filenames and reduces directory entry counts.
   - Cons: Rewrites growing shared state, enlarges the crash and contention surface, requires an additional durable deduplication index, and prevents the file checkpointer from dropping one corrupt node while reporting its address independently.

5. **Add `fsync` to every write and directory update**
   - Pros: Extends the guarantee from process-crash atomicity toward host power-loss durability.
   - Cons: Adds synchronous I/O cost and platform-specific complexity not required by consumers in this release; exceeds parity with the validated ProgramJournal reference. This remains a possible hardening step if the durability contract is expanded.

## Decision
**Adopt the ProgramJournal per-record layout and commit model, replacing raw identifier filenames with deterministic SHA-256 digest filenames that are verified against record content on every read.**

The shipped job layout under the caller-supplied run directory is:

```text
<runDir>/
  events/
    000000-<64-lowercase-hex-digest>.json
    000001-<64-lowercase-hex-digest>.json
    append.lock/                              transient canonical owner
      pid
      owner
    append.lock.fence/                        permanent protocol directory
      birth-intent-<unique-token>/            transient published birth intent
        pid
      reap-intent-<unique-token>/             transient published reap intent
        pid
      tomb-<unique-token>/                    transient stale-owner tomb
        pid
        owner
    append.lock.birth-<unique-suffix>/        transient owner staging
    append.lock.birth-intent-<unique-suffix>/ transient birth-intent staging
    append.lock.reap-intent-<unique-suffix>/  transient reap-intent staging
  checkpoint.json                            atomic state/context projection
  progress.json                              atomic progress projection
```

`packages/framework/src/file/layout.ts` is the single source of truth for the public layout names (`EVENTS_DIR`, `CHECKPOINT_FILE`, `PROGRESS_FILE`, `META_FILE`, `NODES_DIR`, and `APPEND_LOCK`) and for `JOURNAL_SCHEMA_VERSION = 1`. The lock implementation in `packages/framework/src/file/atomic.ts` exclusively owns the derived, private protocol names: it derives `append.lock.fence/` from the supplied lock path, names the `birth-intent-*`, `reap-intent-*`, and `tomb-*` entries inside that fence, and names the sibling staging directories shown above. The fence directory is created on first lock acquisition and intentionally retained when empty.

The recovery scope follows those directory boundaries. Published birth/reap intents and tombs live **inside** `append.lock.fence/`; lock acquisition scans those fence entries, removes dead published intents, and reconciles crash-left tombs while births remain fenced. By contrast, `append.lock.birth-*`, `append.lock.birth-intent-*`, and `append.lock.reap-intent-*` are private **sibling staging directories** used only to initialize an owner or intent before its atomic rename. A process crash before that rename can leave a staging directory behind. Neither the fence protocol nor the journal reader scans or reconciles sibling staging directories, so they can remain as harmless ignored litter until the caller removes the run directory or performs external housekeeping. These derived implementation names are deliberately not duplicated as public constants in `file/layout.ts`.

`eventFileName` emits exactly six sequence digits and rejects sequences above `999999`; this makes lexicographic listing equal numeric append order throughout the supported journal capacity. Event filenames are 76 bytes. `packages/framework/src/file/journal.ts` computes the next sequence from the validated durable `*.json` listing while holding `events/append.lock`, then commits one immutable record through `atomicWriteFile`. The append serialization mechanism is specified separately by [ADR-0078](0078-journal-single-writer-contract-and-append-serialization.md), but the layout invariant is that the filename sequence is the append order required by FR-002.

Each event file contains the closed five-field schema implemented in `packages/framework/src/file/event-record.ts`:

```text
{ schemaVersion: 1, sequence, dedupKey, recordedAtMs, event }
```

Serialization uses Fugue's tagged `toJson` representation so supported `Map`, `Set`, `Date`, and nested `undefined` values survive. The writer pre-scans the complete event and rejects values that the codec would omit, reinterpret, or coerce, then verifies a serialize/deserialize round trip. This is deliberately lossless except for one documented canonicalization: JavaScript `-0` is persisted as JSON `0`. The comparison intentionally treats those values as equivalent; no universal object-identity or bit-pattern-preservation guarantee is claimed.

Authoritative file reads validate the raw `JSON.parse` tree **before** `deserializeValue`. They reuse `validateSerializedValueGrammar` from `packages/framework/src/state-machine/serialize.ts`, the same strict grammar used by file-checkpointer node output. A reserved tag is valid only as an exact one-key object with the canonical payload emitted by the serializer: `{"__map__": [...]}` contains exact two-element entry tuples, `{"__set__": [...]}` contains canonical set members, `{"__date__": "..."}` contains the exact `Date#toISOString` form, and `{"__undefined__": true}` contains exactly `true`. Multiple reserved tags, any extra sibling, malformed payloads, duplicate primitive Map keys or Set values that decoding would collapse, raw `-0`, prototype-pollution-filtered keys at any depth, and values beyond the shared depth ceiling fail closed before permissive deserialization could reinterpret or erase bytes. The subsequent event-record parser enforces the closed five-field envelope, safe sequence range, finite timestamp, present event, and deduplication-key grammar. `readFileEventRecords` reports a typed read failure; the authoritative resume boundary reclassifies that failure as `checkpoint-corrupt`, preserving the source filename and strict-codec reason.

Digest selection is part of the durable contract:

- For a keyed append, the digest is `keyDigest(dedupKey)`. Under the append lock, an existing filename ending in that digest is the durable deduplication fact. A retry after commit is a no-op preserving the first record's payload and position; a retry before commit writes the one record. No in-memory deduplication index is involved (FR-004).
- For a keyless append, the stored sentinel is `dedupKey: ""` and the digest input is `` `${sequence}|${toJson(event)}` ``. `packages/framework/src/file/journal.ts` parses the optional runtime argument exactly once: only omission or explicit `undefined` normalizes to `""`, while an explicit `""` is already the keyless sentinel. Runtime `null`, non-strings, and malformed strings fail as typed `FrameworkError` values before any filesystem operation; object diagnostics never dereference getters, Proxy traps, or coercion hooks. An explicit empty string is not a keyed deduplication key and does not deduplicate repeated appends. Including the sequence preserves keyless append semantics: equal keyless events at different positions remain distinct records.
- `|` cannot occur in a non-empty deduplication key because `packages/framework/src/file/event-record.ts` enforces `^[A-Za-z0-9:_-]{1,256}$` for the keyed form. This keeps keyed digest inputs disjoint from keyless digest inputs. The append parser and read-side `isDedupKey` guard derive from the same grammar, accepting `""` as the keyless sentinel and rejecting invalid supplied values before filesystem writes (FR-015).

`packages/framework/src/file/event-log.ts` treats only names ending in `.json` as record candidates, so the canonical `append.lock/`, permanent `append.lock.fence/`, published intent/tomb entries inside the fence, sibling staging directories, and `<target>.tmp.<unique-token>` files are invisible. This reader invisibility is separate from lock-protocol recovery: published fence entries are reconciled by lock acquisition, whereas sibling staging directories are merely ignored and may remain as harmless litter. For every listed record the reader verifies the strict schema, filename prefix against the content sequence, contiguous sequences from zero, and the filename digest against a digest recomputed from parsed content. Any corrupt or truncated record, gap, foreign JSON file, prefix mismatch, or digest mismatch fails the complete read with a source-naming `Result` error; no middle entry is skipped (FR-009).

`packages/framework/src/file/atomic.ts` gives each call its own same-directory `<target>.tmp.<unique-token>` and renames it over the final path; rename is the process-crash commit point. Per-attempt ownership prevents same-process/same-target calls from contending on or cleaning up one shared temporary path. The same primitive writes event files, `checkpoint.json`, `progress.json`, and file-checkpointer entries. Orphaned temporary files do not match the readers' `*.json` filter. This guarantees prior-complete or new-complete observations for process crashes, but does not claim power-loss durability without `fsync`.

The digest adaptation also applies to file-checkpointer nodes in `packages/framework/src/file/checkpointer.ts`:

```text
<checkpointBase>/<validated-runId>/meta.json
<checkpointBase>/<validated-runId>/nodes/<sha256hex(nodeKey)>.json
```

The node entry stores `nodeKey` and verifies that it owns its digest filename when loaded. Run, node, and namespace values are boundary-validated before path construction. The supplied checkpoint base and backend-managed run/nodes entries are additionally `lstat`/`realpath`-verified as non-symlink directories with direct canonical-parent agreement; readable metadata/node entries must be regular non-symlink files. Directory device/inode identity is rechecked around writes. This prevents pre-existing managed-descendant symlinks from redirecting checkpointer I/O outside the base. Portable Node does not expose descriptor-relative `openat` traversal, so the backend does not claim safety against an adversary concurrently renaming filesystem entries between checks. Freshness records reuse `keyDigest` for their filenames, while their latest-write and TTL semantics are owned by [ADR-0079](0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md).

## Consequences

**Positive:**
- FR-002 append order is represented directly and deterministically by a bounded, sortable sequence prefix.
- FR-004 deduplication survives process restart because the committed filename, not process memory or a secondary index, is the deduplication authority.
- Every FR-015-valid supplied key maps to a fixed 76-byte event filename, avoiding `NAME_MAX` failures and path interpretation of raw keys.
- FR-009 validation is stronger than the reference: the raw serializer envelope must satisfy the exact canonical tag grammar before deserialization, and content, sequence, contiguity, and filename ownership must all agree before any history is returned.
- Event files and node files are independently inspectable and independently attributable when corrupt; temporary crash litter is naturally invisible.
- The implementation retains the operationally exercised ProgramJournal model while centralizing public layout names in `packages/framework/src/file/layout.ts` and keeping derived lock-protocol names encapsulated in `packages/framework/src/file/atomic.ts`.

**Negative:**
- Operators cannot recover a deduplication or node key from a filename alone; they must read the record content.
- SHA-256 addressing accepts a theoretical collision risk, although it is negligible for this domain and every readable file must still agree with its content digest.
- Appending and reading require directory scans and per-record validation; append cost grows with the number of event files.
- Once append locking is initialized, each journal retains an empty `append.lock.fence/` directory. Crash-left published intents and tombs inside that fence are scanned and reconciled by later lock acquisition; crash-left sibling staging directories are not scanned or reconciled and may remain as harmless reader-invisible litter until external run-directory cleanup.
- The six-digit ordering scheme imposes a hard capacity of 1,000,000 records per journal (`0` through `999999`); exhaustion fails rather than silently breaking ordering.
- Atomic rename covers process crashes, not sudden power loss. Without `fsync`, the newest committed-looking write can still be lost by the host or filesystem after an acknowledged operation.
- Digest filenames are a deliberate format divergence from historical Loom run directories; this decision provides no migration or byte-for-byte compatibility for those artifacts.
- Event serialization does not preserve the sign bit of negative zero: `-0` deliberately canonicalizes to persisted `0`. All other accepted event values are required to survive without omission, type reinterpretation, or value coercion.

## Related

- [ADR-0075 — Composite checkpoint node-key encoding with canonical folding](./0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md)
- [ADR-0077 — Resume agreement proof: log authoritative, checkpoint may lag](./0077-resume-agreement-proof-log-authoritative-checkpoint-may-lag.md)
- [ADR-0078 — Journal single-writer contract and append serialization](./0078-journal-single-writer-contract-and-append-serialization.md)
- [ADR-0079 — File FreshnessIndex: digest-addressed latest-write files with lazy TTL parity](./0079-file-freshness-index-digest-addressed-latest-write-files-with-lazy-ttl-parity.md)
- [ADR-0080 — Failure surface: `Result` everywhere the port allows; typed throwing inside the `JobLike` shell](./0080-failure-surface-result-everywhere-the-port-allows-typed-throwing-inside-the-joblike-shell.md)
