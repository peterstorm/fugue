/**
 * Pure-surface tests for the journal's append DECISION core
 * (`file/append-plan.ts`) — architecture-tech-lead-1.
 *
 * These rules (SC-003 keyed-dedup convergence, FR-015 dedup keys, sequence
 * assignment and the 6-digit lexicographic ceiling, the canonical-bytes
 * filename digest) used to be reachable only through a real temp directory and
 * a real file lock. They are decisions, not I/O, so they are tested here as
 * decisions: no `mkdtempSync`, no lock, no clock.
 */

import { describe, it, expect } from "bun:test";
import { isAlreadyCommitted, planAppend, journalCapacityError } from "../file/append-plan.js";
import { parseOptionalDedupKey, parseRecordedAtMs } from "../file/event-record.js";
import type { DedupKey, RecordedAtMs } from "../file/event-record.js";
import { keyDigest, MAX_LEXICOGRAPHIC_SEQUENCE, JOURNAL_SCHEMA_VERSION } from "../file/layout.js";

const key = (raw: string | undefined): DedupKey => {
  const parsed = parseOptionalDedupKey(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const stamp = (ms: number): RecordedAtMs => {
  const parsed = parseRecordedAtMs(ms);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const DIR = "run/pure-append";
const KEYLESS = key(undefined);

describe("isAlreadyCommitted — SC-003 keyed dedup against the durable listing", () => {
  it("a keyless append is never deduped, whatever the listing holds", () => {
    expect(isAlreadyCommitted([], KEYLESS)).toBe(false);
    expect(isAlreadyCommitted(["000000-" + "a".repeat(64) + ".json"], KEYLESS)).toBe(false);
  });

  it("a keyed append is not deduped when no committed record carries its digest", () => {
    expect(isAlreadyCommitted([], key("k1"))).toBe(false);
    expect(isAlreadyCommitted([`000000-${keyDigest("other")}.json`], key("k1"))).toBe(false);
  });

  it("a keyed append IS deduped once a record carrying its digest is committed", () => {
    const listing = [`000000-${keyDigest("k1")}.json`];
    expect(isAlreadyCommitted(listing, key("k1"))).toBe(true);
  });

  it("dedup matches on the digest suffix, not on a prefix or a substring", () => {
    const digest = keyDigest("k1");
    // Same digest in the SEQUENCE position must not dedup.
    expect(isAlreadyCommitted([`${digest}-000000.json`], key("k1"))).toBe(false);
    // Right digest, wrong extension.
    expect(isAlreadyCommitted([`000000-${digest}.tmp`], key("k1"))).toBe(false);
  });
});

describe("planAppend — sequence, record, canonical bytes and durable name", () => {
  it("assigns the sequence from the durable listing length", () => {
    const empty = planAppend({ existing: [], dedupKey: KEYLESS, recordedAtMs: stamp(1_000), event: { type: "A" }, directory: DIR });
    expect(empty.fileName.startsWith("000000-")).toBe(true);

    const third = planAppend({ existing: ["a.json", "b.json"], dedupKey: KEYLESS, recordedAtMs: stamp(1_000), event: { type: "A" }, directory: DIR });
    expect(third.fileName.startsWith("000002-")).toBe(true);
  });

  it("emits the ADR-0076 record shape in the canonical bytes", () => {
    const plan = planAppend({ existing: [], dedupKey: key("k1"), recordedAtMs: stamp(1_234), event: { type: "A", n: 1 }, directory: DIR });
    expect(JSON.parse(plan.json)).toEqual({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence: 0,
      dedupKey: "k1",
      recordedAtMs: 1_234,
      event: { type: "A", n: 1 },
    });
  });

  it("names the file `<6-digit sequence>-<64-hex digest>.json`", () => {
    const plan = planAppend({ existing: [], dedupKey: KEYLESS, recordedAtMs: stamp(1), event: { type: "A" }, directory: DIR });
    expect(plan.fileName).toMatch(/^\d{6}-[0-9a-f]{64}\.json$/);
  });

  it("is deterministic — identical inputs plan identical bytes and name", () => {
    const args = { existing: ["x.json"], dedupKey: key("k1"), recordedAtMs: stamp(7), event: { type: "A" }, directory: DIR } as const;
    expect(planAppend({ ...args })).toEqual(planAppend({ ...args }));
  });

  it("digests the CANONICAL bytes, so a Map event's name survives the round trip", () => {
    // The digest is recomputed from the serialized record, never from a fresh
    // walk over the caller-owned event — a Map serializes to its tagged form,
    // and the name must be derived from that same observation.
    const event = { type: "A", m: new Map([["k", 1]]) };
    const plan = planAppend({ existing: [], dedupKey: KEYLESS, recordedAtMs: stamp(1), event, directory: DIR });
    const parsed = JSON.parse(plan.json) as { readonly event: { readonly m: unknown } };
    expect(parsed.event.m).toEqual({ __map__: [["k", 1]] });
    expect(plan.fileName).toMatch(/^000000-[0-9a-f]{64}\.json$/);
  });

  it("two different keyed appends at the same sequence get different names", () => {
    const a = planAppend({ existing: [], dedupKey: key("k1"), recordedAtMs: stamp(1), event: { type: "A" }, directory: DIR });
    const b = planAppend({ existing: [], dedupKey: key("k2"), recordedAtMs: stamp(1), event: { type: "A" }, directory: DIR });
    expect(a.fileName).not.toBe(b.fileName);
  });

  it("fails closed with the permanent capacity error at the lexicographic ceiling", () => {
    // `new Array(n)` is O(1) — only `.length` is read on this path.
    const atCeiling = new Array<string>(MAX_LEXICOGRAPHIC_SEQUENCE + 1);
    let thrown: unknown;
    try {
      planAppend({ existing: atCeiling, dedupKey: KEYLESS, recordedAtMs: stamp(1), event: { type: "A" }, directory: DIR });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(journalCapacityError("appendEvent", DIR, MAX_LEXICOGRAPHIC_SEQUENCE + 1));
  });

  it("admits the very last in-domain sequence", () => {
    const lastOk = new Array<string>(MAX_LEXICOGRAPHIC_SEQUENCE);
    const plan = planAppend({ existing: lastOk, dedupKey: KEYLESS, recordedAtMs: stamp(1), event: { type: "A" }, directory: DIR });
    expect(plan.fileName.startsWith("999999-")).toBe(true);
  });
});
