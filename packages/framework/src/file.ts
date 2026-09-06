/**
 * @fuguejs/framework/file — filesystem-backed durable-runtime subpath barrel
 *
 * Subpath contract (FR-042): consumed as `@fuguejs/framework/file`. The file
 * backend is a zero-dependency port of the durable-runtime surfaces — no new
 * package dependencies (FR-041) and no broker imports (FR-043, enforced by the
 * `check-imports.ts` boundary rule for scope `["file", "file.ts"]`).
 *
 * Everything under `src/file/` imports only `node:fs`, `node:crypto`, and
 * `node:path` among the node built-ins.
 *
 * Public durable surfaces exported here:
 *
 * - `createFileJob` / `resumeFileJob` and strict event-log readers;
 * - `createFileCheckpointer`, backed by per-run `meta.json` and
 *   digest-addressed node files with canonical/composite addresses;
 * - `createFileFreshnessIndex`, backed by one digest-addressed atomic
 *   latest-write singleton per resource, with deterministic Redis-compatible
 *   tie-breaking and lazy 24h TTL;
 * - `createFileSpendStore`, a locked whole-snapshot store keyed by run digest;
 * - the journal and record codecs used by hosts that need forensic reads —
 *   `parseStoredEventRecord` is the text entry point (the full raw-seam →
 *   strict-parser composition); `parseFileEventRecord` remains exported as
 *   the deserialized-input stage.
 *
 * Associated option and record types are exported beside their constructors.
 * Result-bearing ports return `Result<_, FrameworkError>`; throwing-only
 * factories, JobLike/Journal methods, codecs, and snapshot getters throw only
 * existing typed `FrameworkError` values with operation/path context (ADR-0080).
 */

// Durable journal, strict event-log reader, and JobLike adapter.
export { createFileJournal, rawCheckpointJson } from "./file/journal.js";
export type {
  FileJournal,
  FileJournalOptions,
  RawCheckpointJson,
} from "./file/journal.js";
export { serializeFileCheckpoint } from "./file/checkpoint-record.js";
export { isFileCheckpointCommit } from "./file/checkpoint-record.js";
export type {
  FileCheckpointCommit,
  FileCheckpointData,
} from "./file/checkpoint-record.js";
export { readFileEvents, readFileEventRecords } from "./file/event-log.js";
export { createFileJob, readFileJobSnapshot } from "./file/job.js";
export type {
  CreateFileJobArgs,
  FileJob,
  FileJobSnapshot,
} from "./file/job.js";
// Log-authoritative resume with the checkpoint agreement proof (ADR-0077).
export { resumeFileJob } from "./file/resume.js";
export type { ResumeFileJobArgs } from "./file/resume.js";
// Strict codec for journal event records. The module also provides shared
// safety helpers reused by checkpointer output validation.
export {
  assertLosslessEvent,
  isDedupKey,
  parseFileEventRecord,
  parseStoredEventRecord,
  serializeFileEventRecord,
} from "./file/event-record.js";
export type { FileEventRecord } from "./file/event-record.js";
// Durable Checkpointer over per-run meta.json + nodes/<digest>.json.
export { createFileCheckpointer } from "./file/checkpointer.js";
export type { FileCheckpointerOptions } from "./file/checkpointer.js";
// Canonical metadata-record node id re-exported by the checkpointer codec.
export { META_RECORD_NODE_ID } from "./file/checkpointer-codec.js";
// Durable FreshnessIndex with one digest-addressed atomic latest-write
// singleton per resource and lazy TTL (ADR-0079).
export { createFileFreshnessIndex } from "./file/freshness-index.js";
export type { FileFreshnessIndexOptions } from "./file/freshness-index.js";
// Atomic spend snapshots for host ledger adapters.
export { createFileSpendStore } from "./file/spend-store.js";
export type { FileSpendStore } from "./file/spend-store.js";
// Kernel envelope type consumed by `readFileEvents` / `replayEvents`.
export type { RecordedEvent } from "./state-machine/types.js";
