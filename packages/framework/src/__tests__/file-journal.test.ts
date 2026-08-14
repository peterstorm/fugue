/**
 * Integration tests for `src/file/journal.ts` (durable store) and
 * `src/file/event-log.ts` (strict reader) — the Phase-2 write/read sides
 * (AD-2, AD-4; spec FR-002/FR-006/FR-007/FR-008/FR-009/FR-013, SC-003):
 *
 * - append layout: `events/<NNNNNN>-<digest>.json`, sequence = count,
 *   keyed/keyless digests per AD-2; keyless appends never dedup
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
 *   rejection incl. the AD-2 NAME_MAX regression (256-char key still fits)
 */

import { describe, it, expect, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  serializeFileCheckpoint,
  serializeFileEventRecord,
} from "../file.js";
import { journalCapacityError } from "../file/journal.js";
import {
  EVENTS_DIR,
  PROGRESS_FILE,
  APPEND_LOCK,
  MAX_LEXICOGRAPHIC_SEQUENCE,
  keyDigest,
} from "../file/layout.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError } from "../types/errors.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";

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

/** Narrow a reader failure to the `cache-error` member for property assertions. */
const asCacheError = (
  error: unknown,
  expectedOperation?: string,
): Extract<FrameworkError, { readonly kind: "cache-error" }> => {
  expect(isFrameworkError(error)).toBe(true);
  if (!isFrameworkError(error) || error.kind !== "cache-error") {
    throw new Error("expected a typed cache-error");
  }
  expect(error.kind).toBe("cache-error");
  if (expectedOperation !== undefined) expect(error.operation).toBe(expectedOperation);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
};

// ---------------------------------------------------------------------------
// Closed typed factory/runtime boundary
// ---------------------------------------------------------------------------

describe("createFileJournal — closed typed throwing shell", () => {
  it("rejects invalid factory directory/options with cache-error(createFileJournal)", () => {
    for (const [directory, options] of [
      ["", {}],
      ["bad\u0000path", {}],
      [tempDir(), null],
      [tempDir(), { now: 7 }],
      [tempDir(), { typo: true }],
    ] as const) {
      let failure: unknown;
      try {
        createFileJournal(
          directory,
          options as unknown as Parameters<typeof createFileJournal>[1],
        );
      } catch (error) {
        failure = error;
      }
      expect(asCacheError(failure, "createFileJournal").message.length).toBeGreaterThan(0);
    }
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
  it("writes the AD-2 layout: events/000000-<digest>.json, parseable record, recordedAtMs stamped", async () => {
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
    expect(records.value.map((r) => r.sequence)).toEqual([0, 1, 2]);
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
    expect(records.value.map((record) => record.sequence)).toEqual([0, 1]);
    expect(records.value.map((record) => record.dedupKey)).toEqual(["", ""]);
    expect(records.value.map((record) => record.event)).toEqual([event, event]);
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
    expect(records.value[0].sequence).toBe(0);
    expect(records.value[0].dedupKey).toBe("t:abcd");
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
    expect(records.value[0].sequence).toBe(0);
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
    expect(records.value.map((r) => r.sequence)).toEqual([0, 1]);
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
    expect(records.value.map((r) => r.sequence)).toEqual([0, 1, 2]);
    expect(records.value.map((r) => r.dedupKey)).toEqual(["ka", "", "kc"]);
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
    expect(records.value.map((r) => r.sequence)).toEqual(Array.from({ length: N }, (_, i) => i));
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
    expect(journal.readCheckpoint()).toBe(first.json);

    const second = serializeFileCheckpoint({ state: "s2", context: null });
    await journal.writeCheckpoint(second);
    expect(journal.readCheckpoint()).toBe(second.json);
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
    expect(journal.readCheckpoint()).toBe(b.json);
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
    expect(records.value.map((r) => r.sequence)).toEqual([0, 1]);

    // A new append must not deadlock on the stale lock (stale-steal) and must
    // count only `*.json` files: sequence 2, not 4.
    await journal.appendEvent({ type: "C" }, "k2");
    const after = readFileEventRecords(dir);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.map((r) => r.sequence)).toEqual([0, 1, 2]);
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
});

// ---------------------------------------------------------------------------
// Lock-acquire failure (AD-6) — typed, never a raw leak
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — lock-acquire failures are typed (AD-6)", () => {
  it("a file squatting on events/append.lock fails with { kind: cache-error, operation: appendEvent }", async () => {
    const dir = tempDir();
    const eventsDir = join(dir, EVENTS_DIR);
    mkdirSync(eventsDir, { recursive: true });
    // A FILE at the lock path: the rename-born lock cannot be born (renaming
    // a directory onto a file is ENOTDIR), and the acquire throws a raw fs
    // error — which must be classified through the typed path, never leaked.
    writeFileSync(join(eventsDir, APPEND_LOCK), "squatter");

    const journal = createFileJournal(dir);
    let error: unknown;
    try {
      await journal.appendEvent({ type: "X" }, "k1");
    } catch (e) {
      error = e;
    }
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

    let error: unknown;
    try {
      await journal.appendEvent({ type: "B" }, "k1");
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    expect(typed.message).toContain("README.json");
    expect(typed.message).toMatch(/naming contract/);
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

    let error: unknown;
    try {
      await journal.appendEvent({ type: "B" }, "k1");
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.message).toContain("000000-deadbeef.json");
    expect(typed.message).toMatch(/naming contract/);
    // No new record was committed (the malformed name is still the only addition).
    expect(listEventFiles(dir)).toEqual([...before, "000000-deadbeef.json"].sort());
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

    let error: unknown;
    try {
      await journal.appendEvent({ type: "X" }, "squat:k");
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const typed = asCacheError(error as FrameworkError);
    expect(typed.operation).toBe("appendEvent");
    // The error names the squatted entry — not a generic failure.
    expect(typed.message).toContain(squatName);
    expect(typed.message).toMatch(/not a regular file/);
    // NOT a successful no-op: no record was skipped AND none was committed.
    expect(readdirSync(eventsDir).filter((n) => n.endsWith(".json"))).toEqual([squatName]);
  });
});

// ---------------------------------------------------------------------------
// Capacity ceiling — existing AD-6 cache-error taxonomy
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — capacity ceiling classification (AD-6)", () => {
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
  });

  // Hitting the ceiling end-to-end would require a 1,000,000-entry listing.
  // The reader and naming tests pin the sequence domain; this seam pins the
  // exact existing error kind that the append branch throws.
});

// ---------------------------------------------------------------------------
// Writer-side genuine fs failures (AD-6) — the readdir branch of
// `listEventFiles` inside `appendEvent`, which the reader-only chmod tests
// cannot cover
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — writer-side readdir failure (AD-6)", () => {
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
      let error: unknown;
      try {
        await journal.appendEvent({ type: "B" }, "k1");
      } catch (e) {
        error = e;
      }
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
      let error: unknown;
      try {
        await journal.writeProgress(bad);
      } catch (e) {
        error = e;
      }
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
    expect(records.value.map((r) => r.sequence)).toEqual([0, 1]);
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
    // per-file read fails with EISDIR — a genuine fs failure branch, fail
    // closed with the offending path named (FR-009).
    mkdirSync(join(eventsDir, name), { recursive: true });
    writeFileSync(join(eventsDir, name, "inner"), "x");

    const result = readFileEvents(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure = asCacheError(result.error);
      expect(failure.operation).toBe("readFileEvents");
      expect(failure.message).toContain(name);
      expect(failure.message).toMatch(/read failed/);
    } else {
      throw new Error("expected the squatted record read to fail closed");
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
// FR-015 write-side gate + AD-2 NAME_MAX regression
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
    // Every filename stays within NAME_MAX (AD-2 — the digest adaptation).
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
// Cross-process lock serialization (AD-4) — the in-process Promise.all tests
// cannot prove the lock spans processes; spawn three real bun children that
// append to one directory concurrently and demand strict contiguity
// ---------------------------------------------------------------------------

describe("createFileJournal.appendEvent — cross-process lock serialization (AD-4)", () => {
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
    expect(records.value.map((r) => r.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const tags = records.value
      .map((r) => `${(r.event as { id: string; i: number }).id}:${(r.event as { id: string; i: number }).i}`)
      .sort();
    expect(tags).toEqual(
      ["A", "B", "C"].flatMap((id) => Array.from({ length: 10 }, (_, i) => `${id}:${i}`)).sort(),
    );
  }, 30_000);
});
