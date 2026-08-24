/**
 * Integration tests for `src/file/journal.ts` (durable store) and
 * `src/file/event-log.ts` (strict reader) — the Phase-2 write/read sides
 * (ADR-0076, ADR-0078; spec FR-002/FR-006/FR-007/FR-008/FR-009/FR-013, SC-003):
 *
 * - append layout: `events/<NNNNNN>-<digest>.json`, sequence = count,
 *   keyed/keyless digests per ADR-0076; keyless appends never dedup
 * - keyed dedup by the durable listing: same instance AND across a fresh
 *   instance over the same directory (simulated crash — SC-003), by key
 *   alone (in-memory/Redis parity)
 * - sequence contiguity under concurrent `Promise.all` appends (FR-013:
 *   replayable lock-acquisition order; concurrent order scheduler-selected), including
 *   same-key concurrency collapsing to one record
 * - atomic checkpoint/progress projections: reader never observes a partial
 *   `checkpoint.json`; `.tmp.<unique-token>` litter and leftover lock dirs are
 *   invisible to both writers and readers
 * - strict read side (FR-009): corrupt JSON, invalid record, sequence gaps,
 *   filename-prefix ↔ content-sequence mismatch, filename-digest ↔ content
 *   mismatch — all fail closed with the offending file named
 * - `readFileEvents` envelope mapping (FR-008) and FR-015 write-side
 *   rejection incl. the ADR-0076 NAME_MAX regression (256-char key still fits)
 */

import { describe, it, expect, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFileJournal,
  readFileEventRecords,
  readFileEvents,
  resumeFileJob,
  serializeFileCheckpoint,
  serializeFileEventRecord,
} from "../file.js";
import { journalCapacityError, rawCheckpointJson } from "../file/journal.js";
import { asCacheError } from "./_cache-error-helpers.js";
import {
  CHECKPOINT_FILE,
  EVENTS_DIR,
  PROGRESS_FILE,
  APPEND_LOCK,
  MAX_LEXICOGRAPHIC_SEQUENCE,
  eventFileName,
  keyDigest,
} from "../file/layout.js";
import type { FrameworkError } from "../types/errors.js";
import { retriabilityOf } from "../types/errors.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import type { Result } from "../types/result.js";
import { err, ok } from "../types/result.js";
import { runId } from "../types/ids.js";
import { genesis, machine } from "./_file-resume-fixture.js";
import type { C, E, S } from "./_file-resume-fixture.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanup: string[] = [];
afterEach(() => {
  __resetFrameworkLogger();
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp directory, removed after the test. */
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "file-journal-"));
  cleanup.push(dir);
  return dir;
};

const listEventFiles = (dir: string): readonly string[] =>
  readdirSync(join(dir, EVENTS_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort();

/** A pid that is provably dead: reap a throwaway child process. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", "0"]).pid;

const eventsOf = (dir: string): readonly { type: string }[] => {
  const result = readFileEvents(dir);
  expect(result.ok).toBe(true);
  return result.ok ? result.value.map((e) => e.event as { type: string }) : [];
};

// ---------------------------------------------------------------------------
// Closed typed factory/runtime boundary
// ---------------------------------------------------------------------------

/**
 * Capture the value a rejecting promise / throwing call produces, so a test can
 * ASSERT on it.
 *
 * This idiom appeared 20+ times in two spellings. Sharing it also removes the
 * failure mode each hand-rolled copy had: forgetting to assert that anything
 * threw at all, which turns a silently-succeeding call into a passing test.
 */
const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject");
};

/** Synchronous twin of `captureRejection`, for constructor/parse boundaries. */
const captureThrow = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to throw");
};

describe("createFileJournal — closed typed throwing shell", () => {
  it("rejects invalid factory directory/options with cache-error(createFileJournal)", () => {
    for (const [directory, options] of [
      ["", {}],
      ["bad\u0000path", {}],
      [tempDir(), null],
      [tempDir(), { now: 7 }],
      [tempDir(), { typo: true }],
      [tempDir(), new (class OptionsInstance {})()],
    ] as const) {
      const failure: unknown = captureThrow(() => {
        createFileJournal(
          directory,
          options as unknown as Parameters<typeof createFileJournal>[1],
        );
      });
      expect(asCacheError(failure, "createFileJournal").message.length).toBeGreaterThan(0);
    }
  });

  it("rejects a class-instance options bag on the PROTOTYPE branch (pinned by exact message)", () => {
    class OptionsInstance {}
    const failure: unknown = captureThrow(() => {
      createFileJournal(
        tempDir(),
        new OptionsInstance() as unknown as Parameters<typeof createFileJournal>[1],
      );
    });
    // The exact message isolates the prototype branch of
    // `parseFileFactoryClock`: `null` takes the first-check message ("options
    // must be a plain object, got …"), a class instance the bare branch
    // message — the identical branch the stricter sibling parser pins in
    // `file-checkpointer.test.ts`.
    expect(asCacheError(failure, "createFileJournal").message).toBe(
      "createFileJournal failed at factory configuration: options must be a plain object",
    );
  });

  it("contains hostile clock throws and logger throws without raw leakage", async () => {
    const dir = tempDir();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const journal = createFileJournal(dir, { now: () => { throw revoked.proxy; } });
    const failure = await journal.appendEvent({ type: "X" }, "clock-key").then(
      () => null,
      (error: unknown) => error,
    );
    const typed = asCacheError(failure, "appendEvent");
    expect(typed.message).toContain(dir);
    expect(typed.message).toMatch(/unprintable|Proxy|revoked/i);
    // The injected clock is the failing dependency — the diagnostic must
    // name it instead of misattributing the failure to the lock machinery.
    expect(typed.message).toMatch(/clock/);

    const eventsDir = join(dir, EVENTS_DIR);
    mkdirSync(join(eventsDir, APPEND_LOCK), { recursive: true });
    writeFileSync(join(eventsDir, APPEND_LOCK, "pid"), `${deadPid()}`);
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => { throw revoked.proxy; },
      error: () => {},
    });
    const healthy = createFileJournal(dir, { now: () => 1 });
    await healthy.appendEvent({ type: "AFTER" }, "after-logger");
    expect(readFileEventRecords(dir).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Append layout + keyless semantics
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — layout", () => {
  it("writes the ADR-0076 layout: events/000000-<digest>.json, parseable record, recordedAtMs stamped", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 1_700_000_000_123 });
    await journal.appendEvent({ type: "A", n: 1 });

    const files = listEventFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^000000-[0-9a-f]{64}\.json$/);

    const raw = readFileSync(join(dir, EVENTS_DIR, files[0]), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sequence).toBe(0);
    expect(parsed.dedupKey).toBe("");
    expect(parsed.recordedAtMs).toBe(1_700_000_000_123);
    expect(parsed.event).toEqual({ type: "A", n: 1 });
  });

  it("keyless appends never dedup — identical events land as distinct content-addressed records", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" });
    await journal.appendEvent({ type: "A" });
    await journal.appendEvent({ type: "A" });

    const files = listEventFiles(dir);
    expect(files).toHaveLength(3);
    expect(new Set(files).size).toBe(3); // distinct digests (sequence folded in)
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1, 2]);
    expect(records.value.every((r) => r.event)).toBe(true);
  });

  it("treats an explicit empty key as keyless across fresh public journal instances", async () => {
    const dir = tempDir();
    const event = { type: "EXPLICIT-EMPTY" };

    const journalA = createFileJournal(dir);
    await journalA.appendEvent(event, "");

    // A fresh public-surface instance must observe the committed first record
    // when assigning sequence 1. The explicit empty sentinel is keyless, so
    // the identical second append persists instead of deduplicating.
    const journalB = createFileJournal(dir);
    await journalB.appendEvent(event, "");

    const files = listEventFiles(dir);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((record) => Number(record.sequence))).toEqual([0, 1]);
    expect(records.value.map((record) => String(record.dedupKey))).toEqual(["", ""]);
    expect(records.value.map((record) => record.event)).toEqual([event, event]);
  });

  it("derives the keyless filename digest from the PERSISTED canonical bytes, not a second walk of caller state (round-22 tda-1)", async () => {
    // A stateful Proxy whose `get` trap returns a DIFFERENT value per read:
    // the write-side losslessness gate makes all its own walks agree (the
    // round-trip verdict compares canonicalized values), but a subsequent
    // digest walk could observe a divergent value — emitting a record whose
    // filename digest disagrees with its persisted content, which the strict
    // reader then rejects at resume (FR-009). The digest must be computed
    // from the round-trip-verified json (ONE observation), exactly as the
    // reader recomputes it from the parsed record.
    const dir = tempDir();
    const journal = createFileJournal(dir);
    let reads = 0;
    // Each read of `value` returns a fresh object; the serializer's own
    // canonicalization sees a stable `{ v: read % 2 }` shape only if it reads
    // consistently. To make the divergence DETERMINISTIC and confined to a
    // post-serialization walk, flip the returned value on a high read count
    // (well past any serializer walk): the digest must not depend on which
    // value the LAST walk saw.
    const statefulEvent = new Proxy(
      { type: "PROXY", value: { v: 0 } },
      {
        get(target, prop, receiver) {
          if (prop === "value") {
            reads += 1;
            // Stable for all serializer walks (well below this floor), then
            // divergent for any LATER walk.
            return { v: reads <= 20 ? 1 : 2 };
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );

    await journal.appendEvent(statefulEvent as never);

    // The strict reader recomputes the digest from the PARSED persisted
    // bytes and requires it to equal the filename — if the writer had hashed
    // a divergent later walk, readFileEventRecords would fail closed here.
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value).toHaveLength(1);
    expect(records.value[0]!.event).toEqual({ type: "PROXY", value: { v: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Keyed dedup — durable by filename (SC-003)
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — keyed dedup", () => {
  it("dedups two consecutive calls with the same key to one record (first content preserved)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "STEP" }, "t:abcd");
    await journal.appendEvent({ type: "STEP" }, "t:abcd");

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value).toHaveLength(1);
    expect(Number(records.value[0].sequence)).toBe(0);
    expect(String(records.value[0].dedupKey)).toBe("t:abcd");
    expect(records.value[0].event).toEqual({ type: "STEP" });
  });

  it("dedup is by key alone — a different event re-derived under the same key is a no-op (in-memory/Redis parity)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "STEP" }, "k1");
    await journal.appendEvent({ type: "STEP-AGAIN" }, "k1"); // same key, different payload
    expect(eventsOf(dir)).toHaveLength(1);
  });

  it("dedup no-op across a FRESH instance over the same directory (simulated crash — SC-003)", async () => {
    const dir = tempDir();

    // Instance A: the append commits, then the "process crashes" before the
    // consumer ever re-reads anything.
    const journalA = createFileJournal(dir);
    await journalA.appendEvent({ type: "STEP" }, "crash-window:1");

    // Instance B — a fresh process over the same directory re-derives the
    // same transition (kernel FR-004): the durable listing itself is the
    // dedup decision, so the re-append is a no-op and the first record's
    // content/position are preserved (SC-003).
    const journalB = createFileJournal(dir);
    await journalB.appendEvent({ type: "STEP" }, "crash-window:1");

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value).toHaveLength(1);
    expect(Number(records.value[0].sequence)).toBe(0);
    expect(records.value[0].event).toEqual({ type: "STEP" });
  });

  it("after a cross-instance dedup no-op, a NEW key continues the sequence (no gap, no clobber)", async () => {
    const dir = tempDir();
    const journalA = createFileJournal(dir);
    await journalA.appendEvent({ type: "STEP" }, "k1"); // "crashed" after append

    const journalB = createFileJournal(dir);
    await journalB.appendEvent({ type: "STEP" }, "k1"); // re-derived → no-op
    await journalB.appendEvent({ type: "DONE" }, "k2"); // genuinely new transition

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1]);
    expect((records.value[0].event as { type: string }).type).toBe("STEP");
    expect((records.value[1].event as { type: string }).type).toBe("DONE");
  });

  it("keyed and keyless appends share one contiguous sequence space", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "ka");
    await journal.appendEvent({ type: "B" }); // keyless
    await journal.appendEvent({ type: "C" }, "kc");

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1, 2]);
    expect(records.value.map((r) => String(r.dedupKey))).toEqual(["ka", "", "kc"]);
  });
});

// ---------------------------------------------------------------------------
// Serialization (FR-013) — contiguous, replayable lock-acquisition order
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — concurrency", () => {
  it("concurrent Promise.all appends with distinct keys produce distinct contiguous sequences", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) => journal.appendEvent({ type: "E", i }, `k:${i}`)),
    );

    const files = listEventFiles(dir);
    expect(files).toHaveLength(N);
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    // The lock serializes appends: sequences are exactly 0..N-1, each file
    // matches its content (the strict reader already proved that), and every
    // event survived — nothing was lost or duplicated under interleaving.
    expect(records.value.map((r) => Number(r.sequence))).toEqual(Array.from({ length: N }, (_, i) => i));
    const tags = records.value.map((r) => (r.event as { i: number }).i).sort((a, b) => a - b);
    expect(tags).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("concurrent Promise.all appends with the SAME key collapse to exactly one record", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await Promise.all(
      Array.from({ length: 10 }, () => journal.appendEvent({ type: "X" }, "same-key")),
    );
    expect(eventsOf(dir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Atomic projections (FR-006/FR-007) — no partial checkpoint.json
// ---------------------------------------------------------------------------

describe("createFileJournal — checkpoint/progress projections", () => {
  it("writeCheckpoint/readCheckpoint round-trip, overwrite, and null on an untouched directory", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    expect(journal.readCheckpoint()).toBeNull();

    const first = serializeFileCheckpoint({ state: "s1", context: null });
    await journal.writeCheckpoint(first);
    expect(journal.readCheckpoint()).toBe(rawCheckpointJson(first.json));

    const second = serializeFileCheckpoint({ state: "s2", context: null });
    await journal.writeCheckpoint(second);
    expect(journal.readCheckpoint()).toBe(rawCheckpointJson(second.json));
  });

  it("writeCheckpoint creates a nonexistent nested run directory on the first write", async () => {
    const parent = tempDir();
    const dir = join(parent, "nested", "run");
    const checkpoint = serializeFileCheckpoint({ state: "first", context: { n: 1 } });

    await createFileJournal(dir).writeCheckpoint(checkpoint);

    expect(readFileSync(join(dir, "checkpoint.json"), "utf-8")).toBe(checkpoint.json);
  });

  it("writeCheckpoint rejects a forged/raw runtime input with typed operation/path", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const failure = await journal.writeCheckpoint(
      { json: '{"schemaVersion":1,"data":{}}', data: {} } as never,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const typed = asCacheError(failure, "writeCheckpoint");
    expect(typed.message).toContain(join(dir, "checkpoint.json"));
    expect(journal.readCheckpoint()).toBeNull();
  });

  it("readCheckpoint: absent is null; existing-but-unreadable is a typed fs failure, never absence", () => {
    // ENOENT is the ONLY absence verdict — `existsSync` would swallow
    // EACCES/ENOTDIR and misreport a permission-broken directory as
    // "no checkpoint" (a silent fresh start one layer below the protected
    // resume path).
    const dir = tempDir();
    expect(createFileJournal(dir).readCheckpoint()).toBeNull();

    // Root cannot manufacture EACCES via chmod (see the sibling tests).
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const blocked = tempDir();
    const journal = createFileJournal(blocked);
    const commit = serializeFileCheckpoint({ state: "s", context: null });
    let failure: unknown = null;
    return journal.writeCheckpoint(commit).then(() => {
      expect(createFileJournal(blocked).readCheckpoint()).toBe(rawCheckpointJson(commit.json));
      chmodSync(join(blocked, CHECKPOINT_FILE), 0o000);
      try {
        createFileJournal(blocked).readCheckpoint();
      } catch (error) {
        failure = error;
      } finally {
        chmodSync(join(blocked, CHECKPOINT_FILE), 0o600);
      }
      const typed = asCacheError(failure, "readCheckpoint");
      // Environment class: an unreadable file may clear on retry.
      expect(typed.failureClass).toBeUndefined();
      expect(typed.message).toContain(blocked);
    });
  });

  it("writeProgress creates a nonexistent nested run directory on the first write", async () => {
    const parent = tempDir();
    const dir = join(parent, "nested", "run");

    await createFileJournal(dir).writeProgress(25);

    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 25 });
  });

  it("writeCheckpoint maps a POST-mkdir atomic-write failure to typed cache-error(writeCheckpoint) — the branch the EACCES suite misses by failing at mkdir first", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    // Establish the run directory FIRST so mkdirSync({recursive:true}) is a
    // no-op afterwards: the existing EACCES tests chmod before the directory
    // exists and fail at mkdirSync, never reaching atomicWriteFile. This
    // pins the real write-failure branch of writeCheckpoint (round-24
    // pta-1).
    await journal.writeCheckpoint(serializeFileCheckpoint({ state: "s", context: null }));
    chmodSync(dir, 0o500); // read+execute, no write — mkdir no-ops, the tmp write fails

    try {
      const error: unknown = await captureRejection(journal.writeCheckpoint(serializeFileCheckpoint({ state: "s2", context: null })));
      expect(error).toBeDefined();
      const typed = asCacheError(error as FrameworkError);
      expect(typed.operation).toBe("writeCheckpoint");
      expect(typed.message).toContain(dir);
      expect(typed.message).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach cleanup can rm
    }
  });

  it("writeProgress persists { percent } and overwrites atomically", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.writeProgress(10);
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 10 });
    await journal.writeProgress(90);
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 90 });
  });

  it("a reader never observes a partial checkpoint.json across many atomic writes, and no tmp litter remains", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const a = serializeFileCheckpoint({
      state: { kind: "A", payload: "x".repeat(200_000) },
      context: null,
    });
    const b = serializeFileCheckpoint({
      state: { kind: "B", payload: "y".repeat(40_000) },
      context: null,
    });

    for (let i = 0; i < 20; i++) {
      await journal.writeCheckpoint(i % 2 === 0 ? a : b);
      // Every observation is a complete snapshot — either A or B, never a
      // torn write (FR-006/FR-029). Read through a FRESH journal instance
      // too, so the check does not rely on a warm reader.
      const observed = createFileJournal(dir).readCheckpoint();
      expect(observed === a.json || observed === b.json).toBe(true);
      expect(JSON.parse(observed!).data.state.kind).toBe(i % 2 === 0 ? "A" : "B");
    }

    // Success path leaves no `.tmp.<unique-token>` litter behind.
    const litter = readdirSync(dir).filter((name) => name.includes(".tmp."));
    expect(litter).toEqual([]);
    // The final committed checkpoint is the last write.
    expect(journal.readCheckpoint()).toBe(rawCheckpointJson(b.json));
  });
});

// ---------------------------------------------------------------------------
// Litter invisibility — readers and writers only ever see *.json
// ---------------------------------------------------------------------------

describe("tmp litter and leftover lock dirs are invisible", () => {
  it("readers ignore .tmp.<token> files and a leftover append.lock dir; appends continue at the true count", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    await journal.appendEvent({ type: "B" }, "k1");

    // Simulate crash litter: a torn write (tmp of a file that never
    // committed), a stale tmp of a committed file, and a leftover lock
    // directory whose recorded owner is dead (crash while holding the lock).
    const eventsDir = join(dir, EVENTS_DIR);
    const files = listEventFiles(dir);
    writeFileSync(join(eventsDir, `${files[0]}.tmp.31337`), '{"schemaVersion":1,"sequence":9,"dedupKey":"","recordedAtMs":1,"event":{"type":"GHOST"}}');
    writeFileSync(join(eventsDir, "000042-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json.tmp.99999"), "partial");
    mkdirSync(join(eventsDir, "append.lock"));
    writeFileSync(join(eventsDir, "append.lock", "pid"), `${deadPid()}`);

    // The strict reader sees only the two committed records (FR-009); the
    // tmp litter — including the *content-valid* ghost — is invisible.
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1]);

    // A new append must not deadlock on the stale lock (stale-steal) and must
    // count only `*.json` files: sequence 2, not 4.
    await journal.appendEvent({ type: "C" }, "k2");
    const after = readFileEventRecords(dir);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.map((r) => Number(r.sequence))).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Strict reader — fail closed (FR-009)
// ---------------------------------------------------------------------------

describe("readFileEventRecords — strict fail-closed validation", () => {
  it("a missing events directory is an empty log, not an error", () => {
    const dir = tempDir();
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value).toEqual([]);
  });

  it("a sequence gap fails closed with the offending file named", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    await journal.appendEvent({ type: "B" }, "k1");
    await journal.appendEvent({ type: "C" }, "k2");
    rmSync(join(dir, EVENTS_DIR, listEventFiles(dir)[1])); // delete 000001-*

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (records.ok) return;
    const failure = asCacheError(records.error);
    expect(failure.message).toContain("000002");
    expect(failure.message).toMatch(/breaks strict contiguity.*expected 1/);
    expect(failure.operation).toBe("readFileEventRecords");
  });

  it("a filename prefix that disagrees with the content sequence fails closed", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    // Copy the record under a WRONG prefix (content still says sequence 0).
    const eventsDir = join(dir, EVENTS_DIR);
    const name = listEventFiles(dir)[0];
    writeFileSync(join(eventsDir, `000002-${name.slice(7)}`), readFileSync(join(eventsDir, name), "utf-8"));

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (records.ok) return;
    expect(asCacheError(records.error).message).toContain("000002");
    expect(asCacheError(records.error).message).toMatch(/filename prefix "000002" does not match record sequence 0/);
  });

  it("a filename digest that disagrees with the recomputed content digest fails closed", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    // Rewrite the event file with a record whose key digests differently.
    // (T5's codec serializes a valid record; the filename was keyed on "k0".)
    const eventsDir = join(dir, EVENTS_DIR);
    const name = listEventFiles(dir)[0];
    writeFileSync(
      join(eventsDir, name),
      serializeFileEventRecord(0, "k0-TAMPERED", 1_700_000_000_000, { type: "A" }),
    );

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (records.ok) return;
    expect(asCacheError(records.error).message).toContain(name);
    expect(asCacheError(records.error).message).toMatch(/digest does not match the recomputed content digest/);
  });

  it("a corrupt/truncated record file fails closed with the source named", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    const name = listEventFiles(dir)[0];
    writeFileSync(join(eventsDir, name), '{"schemaVersion":1,"sequence":');

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (records.ok) return;
    expect(asCacheError(records.error).message).toContain(name);
    expect(asCacheError(records.error).message).toMatch(/not valid JSON/);
  });

  it("a well-formed but non-record .json file fails closed (never silently dropped)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    writeFileSync(join(dir, EVENTS_DIR, "README.json"), '{"hello":1}');

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (records.ok) return;
    // The strict codec rejects it at the unknown-top-level-field gate (the
    // fail-closed strict schema runs before the field-by-field checks).
    expect(asCacheError(records.error).message).toContain("README.json");
    expect(asCacheError(records.error).message).toContain("unknown top-level field");
  });

  it("a hand-crafted 7-digit record (bypassing the codec ceiling) fails closed before its listing position could be misread", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    // Content with sequence 1000000 under a 7-digit prefix: the prefix↔content
    // check passes here (name and content agree on 1000000), so the mis-sort
    // would only matter relative to a 999999- entry — rejection falls to the
    // strict codec's lexicographic-ceiling gate (parse and eventFileName
    // share MAX_LEXICOGRAPHIC_SEQUENCE), which errs at parse with the source
    // named, BEFORE the listing order could be misread as append order. (The
    // write side cannot even produce such a record — serializeFileEventRecord
    // throws on sequences past the ceiling — so the file is hand-crafted.)
    writeFileSync(
      join(eventsDir, "1000000-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"),
      JSON.stringify({
        schemaVersion: 1,
        sequence: 1_000_000,
        dedupKey: "",
        recordedAtMs: 1_700_000_000_000,
        event: { type: "BIG" },
      }),
    );
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (records.ok) return;
    expect(asCacheError(records.error).message).toMatch(/sequence 1000000.*lexicographic ceiling/);
    expect(asCacheError(records.error).message).toContain("1000000-deadbeef");
  });
});

describe("readFileEvents — RecordedEvent envelopes (FR-008)", () => {
  it("maps records to { recordedAtMs, event } in append order, directly replayable", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => 42 });
    await journal.appendEvent({ type: "A" });
    await journal.appendEvent({ type: "B" }, "kb");

    const result = readFileEvents(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { recordedAtMs: 42, event: { type: "A" } },
      { recordedAtMs: 42, event: { type: "B" } },
    ]);
  });

  it("readFileEvents fails closed with its own operation tagged", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, EVENTS_DIR));
    writeFileSync(join(dir, EVENTS_DIR, "000000-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"), "nope");
    const result = readFileEvents(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(asCacheError(result.error).operation).toBe("readFileEvents");
    expect(asCacheError(result.error).message).toMatch(/not valid JSON/);
  });

  it("records and envelopes are DEEP-FROZEN — the readonly promise is runtime-true (round-24 tda-4)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A", nested: { deep: [1, 2] } }, "k0");
    await journal.appendEvent({ type: "B" }, "k1");

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(Object.isFrozen(records.value)).toBe(true); // the array itself
    expect(Object.isFrozen(records.value[0])).toBe(true); // each record
    const firstEvent = records.value[0]!.event as { nested: { deep: unknown[] } };
    expect(Object.isFrozen(firstEvent.nested)).toBe(true);
    expect(Object.isFrozen(firstEvent.nested.deep)).toBe(true);

    const envelopes = readFileEvents(dir);
    expect(envelopes.ok).toBe(true);
    if (!envelopes.ok) return;
    expect(Object.isFrozen(envelopes.value)).toBe(true);
    expect(Object.isFrozen(envelopes.value[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lock-acquire failure (ADR-0080) — typed, never a raw leak
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — lock-acquire failures are typed (ADR-0080)", () => {
  it("a file squatting on events/append.lock fails with { kind: cache-error, operation: appendEvent }", async () => {
    const dir = tempDir();
    const eventsDir = join(dir, EVENTS_DIR);
    mkdirSync(eventsDir, { recursive: true });
    // A FILE at the lock path: the rename-born lock cannot be born (renaming
    // a directory onto a file is ENOTDIR), and the acquire throws a raw fs
    // error — which must be classified through the typed path, never leaked.
    writeFileSync(join(eventsDir, APPEND_LOCK), "squatter");

    const journal = createFileJournal(dir);
    const error: unknown = await captureRejection(journal.appendEvent({ type: "X" }, "k1"));
    expect(error).toBeDefined();
    expect((error as FrameworkError).kind).toBe("cache-error");
    // `asCacheError` narrows the union: it throws unless the error is the
    // `cache-error` member, so the operation/message assertions below are
    // type-safe.
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    expect(typed.message).toContain(dir);
    // Nothing was appended (the lock never came up).
    expect(listEventFiles(dir)).toEqual([]);
    expect(typed.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Writer-side listing contract (fail-fast parity with the strict reader): a
// foreign or stale `*.json` entry would otherwise silently inflate
// `sequence = count` and defer the failure to resume time
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — writer-side listing contract", () => {
  it("a foreign .json entry (README.json) fails the append with a typed cache-error naming the file", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const before = listEventFiles(dir);
    writeFileSync(join(dir, EVENTS_DIR, "README.json"), "{}");

    const error: unknown = await captureRejection(journal.appendEvent({ type: "B" }, "k1"));
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    expect(typed.message).toContain("README.json");
    expect(typed.message).toMatch(/naming contract/);
    // Deterministic: the foreign entry reproduces the identical rejection on
    // every retry of the same append — classified permanent so
    // `retriabilityOf` fast-fails instead of burning the retry budget
    // (ADR-0080; same class as the sibling journalCapacityError pin).
    expect(typed.failureClass).toBe("permanent");
    expect(retriabilityOf(typed)).toBe("non-retriable");
    // Fail fast: the failed append committed NOTHING — the listing gained no
    // record beyond the pre-existing foreign entry.
    expect(listEventFiles(dir)).toEqual([...before, "README.json"].sort());
  });

  it("a record-shaped name with a malformed digest fails the naming contract", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const before = listEventFiles(dir);
    writeFileSync(join(dir, EVENTS_DIR, "000000-deadbeef.json"), "{}"); // digest too short

    const error: unknown = await captureRejection(journal.appendEvent({ type: "B" }, "k1"));
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.message).toContain("000000-deadbeef.json");
    expect(typed.message).toMatch(/naming contract/);
    // No new record was committed (the malformed name is still the only addition).
    expect(listEventFiles(dir)).toEqual([...before, "000000-deadbeef.json"].sort());
  });

  it("a validly-named record with corrupt content does NOT block a different-key append (writer never parses content, ADR-0078)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    // A VALID name (correct 6-digit sequence + a real key digest) wearing
    // corrupt CONTENT: the append hot path verifies names only — keyed dedup
    // is by digest suffix and never parses existing record bytes (ADR-0078
    // writer/reader split). This is the SUCCESS-direction pin the negative-
    // direction suite above lacks: a future refactor that starts parsing
    // content on the append hot path fails HERE, not only at resume time.
    const corruptName = `000001-${keyDigest("k-corrupt")}.json`;
    writeFileSync(join(dir, EVENTS_DIR, corruptName), "not json at all");

    await journal.appendEvent({ type: "B" }, "k1"); // must NOT throw

    // The corrupt record was COUNTED (sequence = count) but never read: the
    // new record landed at sequence 2 beside it.
    expect(listEventFiles(dir)).toEqual([
      `000000-${keyDigest("k0")}.json`,
      corruptName,
      `000002-${keyDigest("k1")}.json`,
    ].sort());
  });
});

// ---------------------------------------------------------------------------
// Directory squat on a record name — the name-only `*.json` filter lists it,
// and the append must FAIL CLOSED rather than count it (inflated sequence) or
// no-op a keyed dedup match against it (silent loss of a genuine append)
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — a directory squatting on a record name cannot no-op an append", () => {
  it("a DIRECTORY at the keyed dedup target filename fails closed (typed cache-error), never a silent successful no-op", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const eventsDir = join(dir, EVENTS_DIR);
    mkdirSync(eventsDir, { recursive: true });
    // The exact filename the append of key "squat:k" would dedup against:
    // `000000-<keyDigest("squat:k")>.json` — a DIRECTORY wears it, so the
    // name-only listing sees a valid-looking record that is not a record.
    const squatName = `000000-${keyDigest("squat:k")}.json`;
    mkdirSync(join(eventsDir, squatName), { recursive: true });
    writeFileSync(join(eventsDir, squatName, "inner"), "x");

    const error: unknown = await captureRejection(journal.appendEvent({ type: "X" }, "squat:k"));
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    // The error names the squatted entry — not a generic failure.
    expect(typed.message).toContain(squatName);
    expect(typed.message).toMatch(/not a regular file/);
    // Same deterministic class as the naming-contract rejection: only manual
    // removal of the squatting entry clears it.
    expect(typed.failureClass).toBe("permanent");
    expect(retriabilityOf(typed)).toBe("non-retriable");
    // NOT a successful no-op: no record was skipped AND none was committed.
    expect(readdirSync(eventsDir).filter((n) => n.endsWith(".json"))).toEqual([squatName]);
  });
});

// ---------------------------------------------------------------------------
// Capacity ceiling — existing ADR-0080 cache-error taxonomy
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — capacity ceiling classification (ADR-0080)", () => {
  it("uses cache-error with append operation and precise capacity context", () => {
    const dir = tempDir();
    const full = journalCapacityError(
      "appendEvent",
      dir,
      MAX_LEXICOGRAPHIC_SEQUENCE + 1,
    );
    const typed = asCacheError(full);
    expect(typed.operation).toBe("appendEvent");
    expect(typed.message).toContain(dir);
    expect(typed.message).toContain(String(MAX_LEXICOGRAPHIC_SEQUENCE + 1));
    expect(typed.message).toContain("capacity exhausted");
    // Deterministic — the retry machinery must fast-fail it (ADR-0080's
    // taxonomy contract: a re-run of the append reproduces the ceiling).
    expect(typed.failureClass).toBe("permanent");
    expect(retriabilityOf(full)).toBe("non-retriable");
  });

  // Hitting the ceiling end-to-end would require a 1,000,000-entry listing.
  // The reader and naming tests pin the sequence domain; this seam pins the
  // exact existing error kind that the append branch throws.
});

// ---------------------------------------------------------------------------
// Writer-side genuine fs failures (ADR-0080) — the readdir branch of
// `listEventFiles` inside `appendEvent`, which the reader-only chmod tests
// cannot cover
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — writer-side readdir failure (ADR-0080)", () => {
  it("readdir EACCES on the events dir (0o300: writable, not readable) fails typed with the directory named", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    // 0o300 = write+execute, no read: the rename-born lock can still be born
    // (mkdir + pid write need w+x) but readdirSync fails EACCES — so this
    // exercises listEventFiles' READDIR branch specifically, not the lock
    // acquire (the 0o000 reader tests would fail earlier at the lock here).
    chmodSync(eventsDir, 0o300);
    try {
      const error: unknown = await captureRejection(journal.appendEvent({ type: "B" }, "k1"));
      expect(error).toBeDefined();
      const typed = asCacheError(error as FrameworkError);
      expect(typed.operation).toBe("appendEvent");
      expect(typed.message).toContain(eventsDir);
      expect(typed.message).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(eventsDir, 0o700); // restore so afterEach cleanup can rm
    }
  });
});

describe("createFileJournal.appendEvent — per-entry stat failure in the writer's listing (ADR-0080)", () => {
  // pr-test-analyzer-3. `listEventFiles`'s per-entry `statSync(entryPath)` catch
  // is a SEPARATE error-mapping path from the directory-level `readdirSync`
  // EACCES branch (0o300, above) and the "not a regular file" branch: readdir
  // succeeds, the name parses, and the stat itself fails. A dangling symlink
  // reaches it deterministically and without root-sensitivity — `statSync`
  // FOLLOWS symlinks, so the missing target surfaces as ENOENT at exactly that
  // call, where a `chmod` technique would have failed earlier at the lock mkdir.
  it("a dangling symlink wearing a valid record name fails the append typed, naming the run directory", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");

    const eventsDir = join(dir, EVENTS_DIR);
    const dangling = join(eventsDir, `000001-${"a".repeat(64)}.json`);
    symlinkSync(join(eventsDir, "target-that-does-not-exist"), dangling);

    const error: unknown = await captureRejection(journal.appendEvent({ type: "B" }, "k1"));

    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    expect(typed.message).toContain(dir);
    expect(typed.message).toMatch(/ENOENT|no such file/i);
    // An unstatable entry is the ENVIRONMENT class (restoring the target clears
    // it), unlike the deterministic name-contract and non-regular-file squats
    // this same loop pins "permanent".
    expect(typed.failureClass).toBeUndefined();

    // The append did NOT land: a listing the writer cannot verify must never
    // be used to assign a sequence. Only the original record and the dangling
    // symlink wear a `.json` name; no `000002-…` record was committed.
    const records = readdirSync(eventsDir).filter((n) => n.endsWith(".json")).sort();
    expect(records).toHaveLength(2);
    expect(records.some((n) => n.startsWith("000002-"))).toBe(false);
  });
});

describe("createFileJournal.appendEvent — events-dir creation failure (ADR-0080)", () => {
  it("a FILE squatting the events path (ENOTDIR) fails the first append typed with the run directory named", async () => {
    const dir = tempDir();
    // A regular file squatting the events path BEFORE the first append:
    // mkdirSync({recursive: true}) on a file-backed path throws (EEXIST on
    // the recursive leaf, ENOTDIR on some platforms) — the first I/O of the
    // append transaction.
    writeFileSync(join(dir, EVENTS_DIR), "squatter");
    const journal = createFileJournal(dir);

    const error: unknown = await captureRejection(journal.appendEvent({ type: "A" }, "k0"));
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    expect(typed.message).toContain(dir);
    expect(typed.message).toMatch(/EEXIST|ENOTDIR|file already exists|not a directory/i);
  });

  it("an unwritable run directory (EACCES) fails the events-dir creation typed, never raw", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    // 0o500 = read+execute, no write: mkdirSync of the events child fails
    // EACCES — the create path of the append transaction, before the lock.
    chmodSync(dir, 0o500);
    try {
      const error: unknown = await captureRejection(journal.appendEvent({ type: "A" }, "k0"));
      expect(error).toBeDefined();
      const typed = asCacheError(error as FrameworkError);
      expect(typed.operation).toBe("appendEvent");
      expect(typed.message).toContain(dir);
      expect(typed.message).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach cleanup can rm
    }
  });
});

// ---------------------------------------------------------------------------
// writeProgress caller-bug validation (0..100)
// ---------------------------------------------------------------------------

describe("createFileJournal.writeProgress — percent validated (0..100)", () => {
  it("persists the boundaries 0 and 100", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.writeProgress(0);
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 0 });
    await journal.writeProgress(100);
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 100 });
  });

  it("throws typed cache-error(writeProgress) on invalid progress and persists nothing", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.writeProgress(42); // a good write first
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 101, 100.5]) {
      const error: unknown = await captureRejection(journal.writeProgress(bad));
      const typed = asCacheError(error, "writeProgress");
      expect(typed.message).toContain("percent");
      expect(typed.message).toMatch(/\[0, 100\]/);
      expect(typed.message).toContain(join(dir, PROGRESS_FILE));
    }
    // The prior good write is untouched — no partial/null progress file.
    expect(JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf-8"))).toEqual({ percent: 42 });
  });
});

// ---------------------------------------------------------------------------
// Non-serializable events: the codec's contextual error on BOTH append paths
// — one shared rule, no path-dependent divergence
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — non-serializable events fail identically on both paths", () => {
  it("keyed and keyless non-lossless events throw the same typed cache-error(appendEvent)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const symbolEvent = { a: 1, s: Symbol("x") };

    const keyedError = await journal.appendEvent(symbolEvent, "k1").then(
      () => null,
      (e: unknown) => e,
    );
    const keylessError = await journal.appendEvent(symbolEvent).then(
      () => null,
      (e: unknown) => e,
    );

    const keyedTyped = asCacheError(keyedError, "appendEvent");
    const keylessTyped = asCacheError(keylessError, "appendEvent");
    expect(keyedTyped.message).toContain("FR-009");
    // Identical contextual message on both paths (the sequence is the same:
    // neither append ever commits, so both serialize the same record).
    expect(keylessTyped.message).toBe(keyedTyped.message);
    expect(keyedTyped.message).toContain(dir);
    // `fileOperationError` class inference: the inner permanent class must
    // survive the fs-wrap — a regression erasing it would mislabel a
    // deterministic append rejection retriable with no test failing.
    expect(keyedTyped.failureClass).toBe("permanent");
    expect(retriabilityOf(keyedTyped)).toBe("non-retriable");
    expect(keylessTyped.failureClass).toBe("permanent");
    // Nothing was persisted.
    expect(listEventFiles(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lock release outcomes — release failure is observable after a successful
// body, but cannot replace a primary append-body failure.
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — lock release outcomes", () => {
  it("rejects typed after a committed append when owned-lock release fails", async () => {
    const dir = tempDir();
    const lockPath = join(dir, EVENTS_DIR, APPEND_LOCK);
    const journal = createFileJournal(dir, {
      now: () => {
        // Deterministic release sabotage after acquisition but before commit:
        // the body can still write its event, while release cannot prove the
        // token because the canonical owner metadata is torn.
        unlinkSync(join(lockPath, "owner"));
        return 42;
      },
    });

    const failure = await journal.appendEvent({ type: "COMMITTED" }, "release-fails").then(
      () => null,
      (error: unknown) => error,
    );

    const typed = asCacheError(failure, "appendEvent");
    expect(typed.message).toContain("releaseFileLock");
    expect(typed.message).toContain(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    // The append body did commit. Reporting success here would strand this
    // live/torn lock invisibly; rejection makes retry/remediation mandatory.
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0].event).toEqual({ type: "COMMITTED" });
    }
    rmSync(lockPath, { recursive: true, force: true });
  });

  it("preserves the primary append failure when owned-lock release also fails", async () => {
    const warnings: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warnings.push(message); },
      error: () => {},
    });
    const dir = tempDir();
    const lockPath = join(dir, EVENTS_DIR, APPEND_LOCK);
    const journal = createFileJournal(dir, {
      now: () => {
        unlinkSync(join(lockPath, "owner"));
        return 42;
      },
    });

    const failure = await journal.appendEvent(
      { type: "MUST-NOT-COMMIT", unsupported: Symbol("x") },
      "body-and-release-fail",
    ).then(() => null, (error: unknown) => error);

    const typed = asCacheError(failure, "appendEvent");
    expect(typed.message).toContain("FR-009");
    expect(warnings.some((warning) => warning.includes("secondary lock-release failure"))).toBe(true);
    expect(warnings.some((warning) => warning.includes(lockPath))).toBe(true);
    expect(listEventFiles(dir)).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { recursive: true, force: true });
  });

  it("a locked-section serialization failure releases the append lock; a subsequent GOOD append lands", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);

    // A GOOD append first, so the failure below is genuinely mid-log.
    await journal.appendEvent({ type: "OK" }, "first");

    // Force a failure INSIDE the locked section: the symbol-bearing event
    // passes the FR-015 gate, the lock is acquired, and only then does the
    // serialization rejection through the closed typed shell.
    const failed = await journal
      .appendEvent({ a: 1, s: Symbol("x") }, "boom")
      .then(() => null, (e: unknown) => e);
    expect(asCacheError(failed, "appendEvent").message).toContain("FR-009");

    // If the finally-path release had not run, this GOOD append would spin
    // on the leaked lock for ~5s and throw "Could not acquire lock" — the
    // success below proves the lock was released despite the failure.
    await journal.appendEvent({ type: "AFTER" }, "after");

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1]);
    expect((records.value[1].event as { type: string }).type).toBe("AFTER");
  });
});

// ---------------------------------------------------------------------------
// Genuine fs-failure branches of the strict reader — typed cache-error with
// operation; not just content-validation paths
// ---------------------------------------------------------------------------

describe("readFileEvents — genuine fs failures fail closed with typed cache-error", () => {
  it("readdir EACCES on the events directory fails closed (operation readFileEvents)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");

    const eventsDir = join(dir, EVENTS_DIR);
    chmodSync(eventsDir, 0o000); // rwx stripped — readdir fails EACCES even for the owner
    try {
      const result = readFileEvents(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(asCacheError(result.error).operation).toBe("readFileEvents");
        expect(asCacheError(result.error).message).toContain(eventsDir);
        expect(asCacheError(result.error).message).toMatch(/EACCES|permission denied/i);
      } else {
        throw new Error("expected EACCES readdir failure to fail closed");
      }
    } finally {
      chmodSync(eventsDir, 0o700); // restore so afterEach cleanup can rm
    }
  });

  it("readFileEventRecords readdir EACCES carries its own operation tag", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    chmodSync(eventsDir, 0o000);
    try {
      const result = readFileEventRecords(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(asCacheError(result.error).operation).toBe("readFileEventRecords");
      }
    } finally {
      chmodSync(eventsDir, 0o700);
    }
  });

  it("a directory squatting at a record path fails the per-file read with the file named", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");

    const eventsDir = join(dir, EVENTS_DIR);
    const name = listEventFiles(dir)[0];
    rmSync(join(eventsDir, name));
    // A DIRECTORY wearing a *.json record name: readdir lists it, and the
    // per-file read fails with EISDIR — a deterministic squat (only manual
    // removal clears it), fail closed with the offending path named (FR-009).
    mkdirSync(join(eventsDir, name), { recursive: true });
    writeFileSync(join(eventsDir, name, "inner"), "x");

    const result = readFileEvents(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure = asCacheError(result.error);
      expect(failure.operation).toBe("readFileEvents");
      expect(failure.message).toContain(name);
      expect(failure.message).toMatch(/read failed/);
      // A deterministic on-disk condition: re-running cannot clear it, only
      // manual removal — pinned permanent at the construction site, parity
      // with the append-time gate in journal.ts listEventFiles (ADR-0080).
      expect(failure.failureClass).toBe("permanent");
      expect(retriabilityOf(failure)).toBe("non-retriable");
    } else {
      throw new Error("expected the squatted record read to fail closed");
    }
  });

  it("an unreadable record file (EACCES) fails the per-file read as an ENVIRONMENT failure — retriable, unlike the EISDIR squat pin", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");

    const eventsDir = join(dir, EVENTS_DIR);
    const name = listEventFiles(dir)[0];
    // Root cannot manufacture EACCES via chmod (DAC bypass) — the sibling
    // readCheckpoint test carries the same guard.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    chmodSync(join(eventsDir, name), 0o000);
    try {
      const result = readFileEvents(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const failure = asCacheError(result.error);
        expect(failure.operation).toBe("readFileEvents");
        expect(failure.message).toContain(name);
        expect(failure.message).toMatch(/read failed/);
        // EACCES on an individual record is the environment class: a retry
        // (or a restore) may clear it — the `permanent` flag is NOT pinned
        // (contrast the deterministic EISDIR squat pin above, which is
        // non-retriable). This is the errno branch the squat pin leaves open.
        expect(failure.failureClass).toBeUndefined();
        expect(retriabilityOf(failure)).toBe("retriable");
      } else {
        throw new Error("expected the unreadable record read to fail closed");
      }
    } finally {
      chmodSync(join(eventsDir, name), 0o600); // restore so afterEach cleanup can rm
    }
  });

  it("a corrupt record file is classified permanent (deterministic — retriabilityOf fast-fails)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    const name = listEventFiles(dir)[0];
    // Overwrite the record with bytes the strict grammar rejects: the same
    // bytes reproduce the identical rejection on every re-read, so the class
    // is permanent, not retriable.
    writeFileSync(join(eventsDir, name), "{ not json");

    const result = readFileEventRecords(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure = asCacheError(result.error);
      expect(failure.operation).toBe("readFileEventRecords");
      expect(failure.message).toContain(name);
      expect(failure.failureClass).toBe("permanent");
      expect(retriabilityOf(failure)).toBe("non-retriable");
    } else {
      throw new Error("expected the corrupt record read to fail closed");
    }
  });
});

// ---------------------------------------------------------------------------
// Content-validation drift guards
// ---------------------------------------------------------------------------

describe("strict reader — content-validation stays green after the ceiling gate", () => {
  it("a sequence 999999 record still passes the codec and reaches the contiguity gate (backstop pin)", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    // A hand-crafted 999999-sequence record is codec-valid (at the ceiling)
    // but sits at listing position 1 — the strict-contiguity gate rejects it,
    // preserving the reader's defense in depth downstream of the codec.
    writeFileSync(
      join(eventsDir, "999999-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json"),
      JSON.stringify({
        schemaVersion: 1,
        sequence: 999_999,
        dedupKey: "",
        recordedAtMs: 1_700_000_000_000,
        event: { type: "BIG" },
      }),
    );
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(false);
    if (!records.ok) {
      expect(asCacheError(records.error).message).toMatch(/breaks strict contiguity.*expected 1/);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-015 write-side gate + ADR-0076 NAME_MAX regression
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — FR-015 dedupKey boundary", () => {
  it("accepts omitted/undefined and explicit empty as keyless plus the full keyed range", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "OMITTED" });
    await journal.appendEvent({ type: "UNDEFINED" }, undefined);
    await journal.appendEvent({ type: "EMPTY" }, "");
    await journal.appendEvent({ type: "ONE" }, "a");
    await journal.appendEvent({ type: "TWO-HUNDRED" }, "x".repeat(200));
    await journal.appendEvent({ type: "MAX" }, "y".repeat(256));

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => r.dedupKey.length)).toEqual([0, 0, 0, 1, 200, 256]);
    expect(records.value.map((r) => (r.event as { type: string }).type)).toEqual([
      "OMITTED",
      "UNDEFINED",
      "EMPTY",
      "ONE",
      "TWO-HUNDRED",
      "MAX",
    ]);
    // Every filename stays within NAME_MAX (ADR-0076 — the digest adaptation).
    for (const name of listEventFiles(dir)) {
      expect(name.length).toBeLessThanOrEqual(255);
    }
  });

  it("rejects malformed strings and every non-string runtime class as typed errors before persistence", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const malformed: readonly unknown[] = [
      "a|b",
      "a.b",
      "a/b",
      "a b",
      "../x",
      "å",
      "a".repeat(257),
      null,
      0,
      1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      false,
      1n,
      Symbol("key"),
      {},
      [],
      new String("looks-valid"),
      new Date(0),
      () => "looks-valid",
    ];

    for (const bad of malformed) {
      const failure = await journal.appendEvent(
        { type: "X" },
        bad as string,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      const typed = asCacheError(failure, "appendEvent");
      expect(typed.message).toContain("FR-015");
      expect(typed.message).toContain(dir);
      expect(readdirSync(dir)).toEqual([]);
    }

    expect(existsSync(join(dir, EVENTS_DIR))).toBe(false);
  });

  it("rejects getters, Proxies, revoked Proxies, traps, and stateful coercion hooks without invoking them", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    let hostileReads = 0;
    const hostileAccessor = (): never => {
      hostileReads += 1;
      throw new Error("dedupKey object must never be dereferenced");
    };
    const accessorObject = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperties(accessorObject, {
      length: { get: hostileAccessor },
      toJSON: { get: hostileAccessor },
      toString: { get: hostileAccessor },
      [Symbol.toPrimitive]: { get: hostileAccessor },
      [Symbol.toStringTag]: { get: hostileAccessor },
    });

    let proxyTraps = 0;
    const trap = (): never => {
      proxyTraps += 1;
      throw new Error("dedupKey Proxy trap must never run");
    };
    const hostileProxy = new Proxy(Object.create(null) as object, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      has: trap,
      ownKeys: trap,
      set: trap,
    });
    const revoked = Proxy.revocable(Object.create(null) as object, {});
    revoked.revoke();

    for (const bad of [accessorObject, hostileProxy, revoked.proxy]) {
      const hostileDedupKey: unknown = bad;
      const failure = await journal.appendEvent({ type: "X" }, hostileDedupKey as string).then(
        () => null,
        (error: unknown) => error,
      );
      const typed = asCacheError(failure, "appendEvent");
      expect(typed.message).toContain("runtime type object");
      expect(typed.message).toContain("FR-015");
      expect(readdirSync(dir)).toEqual([]);
    }

    expect(hostileReads).toBe(0);
    expect(proxyTraps).toBe(0);
    expect(existsSync(join(dir, EVENTS_DIR))).toBe(false);
  });

  it("evaluates a supplied accessor once and a failed runtime value cannot mutate an existing journal", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "SEED" }, "seed:key");

    const beforeNames = readdirSync(dir).sort();
    const beforeFiles = listEventFiles(dir);
    const beforeBytes = beforeFiles.map((name) =>
      readFileSync(join(dir, EVENTS_DIR, name), "utf-8")
    );
    let reads = 0;
    const supplied = {
      get dedupKey(): unknown {
        reads += 1;
        return reads === 1 ? null : "statefully-valid";
      },
    };

    const failure = await journal.appendEvent(
      { type: "MUST-NOT-LAND" },
      supplied.dedupKey as string,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(asCacheError(failure, "appendEvent").message).toContain("runtime type null");
    expect(reads).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(beforeNames);
    expect(listEventFiles(dir)).toEqual(beforeFiles);
    expect(beforeFiles.map((name) => readFileSync(join(dir, EVENTS_DIR, name), "utf-8"))).toEqual(beforeBytes);
  });
});

// ---------------------------------------------------------------------------
// cache-error failure-class classification (ADR-0080): deterministic
// failures carry `failureClass: "permanent"` so `retriabilityOf` fast-fails
// them; environment failures stay unclassified (retriable).
// ---------------------------------------------------------------------------

describe("cache-error failure-class classification (permanent vs transient)", () => {
  it("code-constructed clock rejections are permanent (a broken injected clock is deterministic)", async () => {
    // Throwing clock — the injected dependency fails identically on every retry.
    const dir = tempDir();
    const journal = createFileJournal(dir, { now: () => { throw new Error("clock boom"); } });
    const thrown = await journal.appendEvent({ type: "X" }, "clock-throws").then(
      () => null,
      (error: unknown) => error,
    );
    const thrownTyped = asCacheError(thrown as FrameworkError, "appendEvent");
    expect(thrownTyped.failureClass).toBe("permanent");
    expect(retriabilityOf(thrownTyped)).toBe("non-retriable");

    // Non-finite timestamp — the codec-constructed invariant rejection.
    const dir2 = tempDir();
    const journal2 = createFileJournal(dir2, { now: () => Number.NaN });
    const nonFinite = await journal2.appendEvent({ type: "X" }, "clock-nan").then(
      () => null,
      (error: unknown) => error,
    );
    const nonFiniteTyped = asCacheError(nonFinite as FrameworkError, "appendEvent");
    expect(nonFiniteTyped.failureClass).toBe("permanent");
    expect(retriabilityOf(nonFiniteTyped)).toBe("non-retriable");
    expect(nonFiniteTyped.message).toMatch(/clock/);
  });

  it("FR-015 dedupKey violations and invalid progress are permanent through the typed shell", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);

    // FR-015: "a|b" violates ADR-0076 keyed/keyless digest disjointness.
    const appendFailure = await journal.appendEvent({ type: "X" }, "a|b").then(
      () => null,
      (error: unknown) => error,
    );
    const appended = asCacheError(appendFailure as FrameworkError, "appendEvent");
    expect(appended.failureClass).toBe("permanent");
    expect(retriabilityOf(appended)).toBe("non-retriable");

    // Invalid progress value — deterministic caller bug.
    const progressFailure: unknown = await captureRejection(journal.writeProgress(101));
    const progressed = asCacheError(progressFailure as FrameworkError, "writeProgress");
    expect(progressed.failureClass).toBe("permanent");
    expect(retriabilityOf(progressed)).toBe("non-retriable");
  });

  it("environment failures (lock acquire EACCES) stay retriable", async () => {
    // Root cannot manufacture EACCES via chmod (see the sibling tests).
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "A" }, "k0");
    const eventsDir = join(dir, EVENTS_DIR);
    chmodSync(eventsDir, 0o000); // lock acquire fails EACCES before any write
    try {
      const failure = await journal.appendEvent({ type: "B" }, "k1").then(
        () => null,
        (error: unknown) => error,
      );
      const typed = asCacheError(failure as FrameworkError, "appendEvent");
      expect(typed.failureClass).toBeUndefined();
      expect(retriabilityOf(typed)).toBe("retriable");
    } finally {
      chmodSync(eventsDir, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-process lock serialization (ADR-0078) — the in-process Promise.all tests
// cannot prove the lock spans processes; spawn three real bun children that
// append to one directory concurrently and demand strict contiguity
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — cross-process lock serialization (ADR-0078)", () => {
  it("three concurrent processes append a replayable contiguous sequence in scheduler-selected lock order", async () => {
    const dir = tempDir();
    // The child script imports the journal by absolute path and appends 10
    // records with distinct keys, sleeping briefly between appends to widen
    // the contention window so both processes actually overlap.
    const journalPath = pathToFileURL(join(__dirname, "..", "file", "journal.js")).href;
    const script = join(dir, "child-append.ts");
    writeFileSync(
      script,
      [
        `import { createFileJournal } from ${JSON.stringify(journalPath)};`,
        `const dir = process.env.J_DIR;`,
        `const id = process.env.J_ID;`,
        `if (!dir || !id) throw new Error("missing J_DIR/J_ID");`,
        `const journal = createFileJournal(dir);`,
        `for (let i = 0; i < 10; i++) {`,
        `  await journal.appendEvent({ type: "E", id, i }, \`k:\${id}:\${i}\`);`,
        `  await new Promise((r) => setTimeout(r, 10));`,
        `}`,
      ].join("\n"),
    );

    const runChild = (id: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          env: { ...process.env, J_DIR: dir, J_ID: id },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`child ${id} exited ${code}: ${stderr.slice(0, 500)}`));
          else resolve(code ?? 0);
        });
      });

    const codes = await Promise.all([runChild("A"), runChild("B"), runChild("C")]);
    expect(codes).toEqual([0, 0, 0]);

    // Concurrent ordering is intentionally scheduler-dependent. What the
    // lock guarantees is one acquisition order, strict contiguity in that
    // order, and a log the strict reader can replay without gaps or loss.
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const tags = records.value
      .map((r) => `${(r.event as { id: string; i: number }).id}:${(r.event as { id: string; i: number }).i}`)
      .sort();
    expect(tags).toEqual(
      ["A", "B", "C"].flatMap((id) => Array.from({ length: 10 }, (_, i) => `${id}:${i}`)).sort(),
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// round-14 A2 — stale-lock reaping at the JOURNAL level (ADR-0078 closes its
// own loop): the primitive test (file-atomic.test.ts) proves a fresh process
// reaps a crashed holder's lock through `withFileLock` directly; this test
// proves the recovery through the journal's OWN append path — a crashed
// writer's `events/append.lock` must not wedge a fresh instance's
// `appendEvent`.
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — crashed-writer stale lock (ADR-0078, round-14 A2)", () => {
  it("a fresh process appends successfully when the previous writer died holding events/append.lock", async () => {
    const dir = tempDir();
    const journalPath = pathToFileURL(join(__dirname, "..", "file", "journal.js")).href;
    const atomicPath = pathToFileURL(join(__dirname, "..", "file", "atomic.js")).href;
    const marker = join(dir, "writer-ready");
    const script = join(dir, "crashed-writer.ts");
    writeFileSync(
      script,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { createFileJournal } from ${JSON.stringify(journalPath)};`,
        `import { withFileLock } from ${JSON.stringify(atomicPath)};`,
        `const dir = process.env.J_DIR;`,
        `if (!dir) throw new Error("missing J_DIR");`,
        `const journal = createFileJournal(dir);`,
        `await journal.appendEvent({ type: "BEFORE" });`,
        `writeFileSync(process.env.J_MARKER, "1");`,
        `// Hold the journal's append lock the way an in-flight append does,`,
        `// then die while holding it (SIGKILL from the parent).`,
        `await withFileLock(dir + "/events/append.lock", () => new Promise(() => {}));`,
      ].join("\n"),
    );

    const writer = spawn(process.execPath, [script], {
      env: { ...process.env, J_DIR: dir, J_MARKER: marker },
      stdio: "ignore",
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(marker)).toBe(true);

    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("exit", () => resolve()));

    // The crash left the lock file behind (a stale owner: dead pid + token).
    const lockPath = join(dir, "events", "append.lock");
    expect(existsSync(lockPath)).toBe(true);

    // A FRESH journal instance over the same directory appends through its
    // own append path — the reaping happens inside `appendEvent`, not by
    // calling the primitive from user code.
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "AFTER" });

    // The log is contiguous across the crash: BEFORE (0) + AFTER (1), and
    // the release cleaned up the reaped lock.
    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value.map((r) => Number(r.sequence))).toEqual([0, 1]);
    expect(records.value.map((r) => (r.event as { type: string }).type)).toEqual(["BEFORE", "AFTER"]);
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Symlink policy (journal.ts module header) — the pinned deliberate
// divergence from the file checkpointer's non-symlink trust anchor:
// a writer inside the caller's run directory can already forge record bytes
// directly, so the journal follows symlinks instead of rejecting them.
// (The rename-replaces-symlink mechanism these writes rely on is pinned at the
// `atomicWriteFile` level in file-atomic.test.ts.) If the checkpointer's
// symlink rejection is ever extended to the journal, these are the behavior
// pins to update — the divergence is test-visible.
// ---------------------------------------------------------------------------

describe("symlink policy (pinned divergence from the file checkpointer)", () => {
  it("a symlink at a record name is read THROUGH on resume — the strict reader follows it", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    await journal.appendEvent({ type: "read-through" }, "symlink-read-key");

    const events = join(dir, EVENTS_DIR);
    const names = listEventFiles(dir);
    expect(names).toHaveLength(1);
    const recordPath = join(events, names[0]!);

    // Move the real record out of the listing, then re-create its name as a
    // symlink to the moved file — what a writer inside the run directory can
    // already do. The journal's documented policy: follow it.
    const parked = join(dir, "parked.json");
    renameSync(recordPath, parked);
    symlinkSync(parked, recordPath);
    expect(lstatSync(recordPath).isSymbolicLink()).toBe(true);

    const result = readFileEvents(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.event).toEqual({ type: "read-through" });
    }
  });

  it("a keyed append against a symlink squatting at its keyed name is a dedup NO-OP — the writer reads the symlink through the listing and writes nothing", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);

    // A writer inside the run directory squats a symlink at the exact name a
    // keyed append of key "k" would use. `listEventFiles` `statSync`s (follows)
    // it — a symlink to a regular file passes the regular-file gate — and the
    // keyed dedup no-ops against it: no write happens; the symlink and its
    // target stay untouched.
    const target = join(dir, "squat-target.json");
    writeFileSync(target, "squatting bytes");
    const events = join(dir, EVENTS_DIR);
    mkdirSync(events, { recursive: true });
    const name = eventFileName(0, keyDigest("k"));
    symlinkSync(target, join(events, name));

    await journal.appendEvent({ type: "never-written" }, "k");

    expect(listEventFiles(dir)).toEqual([name]);
    expect(lstatSync(join(events, name)).isSymbolicLink()).toBe(true); // untouched
    expect(readFileSync(target, "utf8")).toBe("squatting bytes"); // untouched
  });
});

// ---------------------------------------------------------------------------
// Scale (review run.vtN26syQLu pta-1): per-append listing is O(files) and
// resume's strict-prefix scan is O(n). Both are unguarded at the design's
// stated scale (hundreds-to-low-thousands of events); the largest
// real-journal exercise before this block was ~25–30 events. This pins that
// the full append→checkpoint→resume cycle stays practical at N=1000.
// ---------------------------------------------------------------------------

describe("scale — N=1000 keyed appends + full-log resume (review pta-1)", () => {
  const N = 1000;

  /** The caller's strict checkpoint decoder — the same idiom as
   * `file-resume.test.ts`: envelope fields validated, payload passed to the
   * machine replay. */
  const scaleParseCheckpoint = (data: unknown): Result<{ state: S; context: C }, string> => {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return err("checkpoint data must be an object with state and context");
    }
    const record = data as Record<string, unknown>;
    if (!("state" in record) || !("context" in record)) {
      return err("checkpoint data must have state and context fields");
    }
    return ok({ state: record.state as S, context: record.context as C });
  };

  it("1000 appends stay contiguous and a 1000-event resume replays fully in bounded wall-clock", async () => {
    const dir = tempDir();
    const journal = createFileJournal(dir);
    const startedAt = Date.now();

    for (let i = 0; i < N; i += 1) {
      await journal.appendEvent({ type: "STEP", i }, `scale:${i}`);
      // The kernel's own commit cadence at scale: a checkpoint projection
      // every 100th event plus a final one (crash lag ≤ 99 events — the
      // strict-prefix window the resume proof accepts).
      if ((i + 1) % 100 === 0 || i === N - 1) {
        await journal.writeCheckpoint(
          serializeFileCheckpoint({
            state: { kind: "pending", count: i + 1 },
            context: { value: i + 1 },
          }),
        );
      }
    }

    const appendElapsedMs = Date.now() - startedAt;
    // Pathological per-append regressions (O(n²) re-listing, per-file content
    // parsing on the hot path) blow past this at N=1000 long before a slow
    // CI runner's flake window; a healthy run measures ~2 s locally.
    expect(appendElapsedMs).toBeLessThan(60_000);

    const files = listEventFiles(dir);
    expect(files).toHaveLength(N);
    // Lexicographic order == append order survives at scale: contiguous
    // 6-digit prefixes 000000…000999 in exactly append order, each named by
    // its own key digest.
    for (let i = 0; i < N; i += 1) {
      expect(files[i]).toBe(`${String(i).padStart(6, "0")}-${keyDigest(`scale:${i}`)}.json`);
    }

    const records = readFileEventRecords(dir);
    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value).toHaveLength(N);
    expect(records.value.map((r) => Number(r.sequence))).toEqual(Array.from({ length: N }, (_, i) => i));

    // Resume through the real agreement proof: the final checkpoint agrees
    // with the full 1000-event replay (guards the O(n) strict-prefix scan
    // and the checkpoint-first acquisition at scale).
    const resumed = await resumeFileJob<S, E, C>({
      runId: runId("scale-1000"),
      directory: dir,
      machine,
      genesis: genesis(),
      parseCheckpoint: scaleParseCheckpoint,
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.value.state).toEqual({ kind: "pending", count: N });
      expect(resumed.value.context).toEqual({ value: N });
    }

    // The total cycle (1000 appends + 10 checkpoints + 1000-record replay)
    // stays inside the same generous bound.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  }, 90_000);
});
