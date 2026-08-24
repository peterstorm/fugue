import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCheckpointer } from "../file/checkpointer.js";
import { createFileJournal } from "../file/journal.js";
import { createFileFreshnessIndex } from "../file/freshness-index.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { serializeMeta, serializeNode, snapshotMeta, snapshotNodeState } from "../file/checkpointer-codec.js";
import { isRepresentableTimestampMs } from "../types/clock.js";
import { runId as R, nodeId as N, dagId as D } from "../types/ids.js";
import { witness, resourceName } from "../types/freshness.js";

/**
 * Clock-guard parity — the deepening-round pin (simp-5) for the file
 * backend's TWO clock domains.
 *
 * The five file/checkpoint clock-guard sites are deliberately NOT one shared
 * guard function: the sites differ on domain, error channel, and pinned
 * message shape, so a shared function would be a shallow module by
 * construction. What IS shared is the DOMAIN SPLIT, and this test pins it:
 *
 *   raw-ms domain (value STORED as a raw number, consumed by arithmetic —
 *     no `Date` conversion ever happens):
 *     - journal `appendEvent` (`recordedAtMs`)
 *     - freshness-index `recordWrite` / `findConflict` (`writtenAtMs`, and
 *       `findConflict`'s `sinceMs` parameter)
 *     Guard: finiteness only. `±1e300` is a finite number and is STORED as
 *     such — representability is out of domain.
 *
 *   ms→Date domain (value CONVERTED via `new Date(ms)` — `toISOString()`,
 *     TTL comparison):
 *     - file checkpointer `readClock`
 *     - in-memory checkpointer `readClock`
 *     - checkpoint codec serializers (`serializeMeta`'s `createdAtMs`,
 *       `serializeNode`'s `completedAt` getTime)
 *     Guard: finiteness AND representability — ONE encoding,
 *     `isRepresentableTimestampMs` (`types/clock.ts`). A finite number
 *     outside the ±100,000-year Time Value range (e.g. `1e300`) yields an
 *     invalid `Date`, so the guard rejects it before the conversion.
 *
 * `±1e300` is the discriminator row: the SAME value is accepted at raw-ms
 * sites and rejected at ms→Date sites. If either domain's semantics drift
 * in either direction, this build fails.
 */

const tempDir = (): string => mkdtempSync(join(tmpdir(), "clock-parity-"));

const W = (resource: string, value: string): ReturnType<typeof witness> =>
  witness("version", resourceName(resource), value);

const VALID_MS = 1_755_542_400_000; // 2026-08-18T00:00:00Z

/** A clock that returns `value` (type-erased — hostile runtimes return anything). */
const clockReturning = (value: unknown): (() => number) => () => value as number;

const throwingClock: (() => number) = () => {
  throw new Error("clock broke");
};

const meta = {
  dagId: D("clock-dag"),
  startedAt: new Date("2026-08-18T00:00:00Z"),
  nodeCount: 1,
};

/** [label, clock, accepted in ms→Date domain, accepted in raw-ms domain] */
const clockCorpus: ReadonlyArray<readonly [string, () => number, boolean, boolean]> = [
  ["a throwing clock", throwingClock, false, false],
  ["NaN", clockReturning(Number.NaN), false, false],
  ["+Infinity", clockReturning(Number.POSITIVE_INFINITY), false, false],
  ["-Infinity", clockReturning(Number.NEGATIVE_INFINITY), false, false],
  // The discriminator rows: finite but outside the Time Value range.
  ["+1e300", clockReturning(1e300), false, true],
  ["-1e300", clockReturning(-1e300), false, true],
  ["a valid ms timestamp", clockReturning(VALID_MS), true, true],
];
describe("clock-guard parity — the two file-backend clock domains agree (deepening round, simp-5)", () => {
  it("ms→Date: file checkpointer readClock (via setMeta) pins the domain map", async () => {
    for (const [label, clock, accepted] of clockCorpus) {
      const cp = createFileCheckpointer(tempDir(), { now: clock });
      const result = await cp.setMeta(R("clock-r"), { ...meta });
      expect(result.ok, `${label}: file checkpointer setMeta — expected ${accepted ? "accepted" : "rejected"}`).toBe(accepted);
    }
  });

  it("ms→Date: in-memory checkpointer readClock (via setMeta) pins the same domain map", async () => {
    for (const [label, clock, accepted] of clockCorpus) {
      const cp = new InMemoryCheckpointer({ now: clock });
      const result = await cp.setMeta(R("clock-r"), { ...meta });
      expect(result.ok, `${label}: in-memory checkpointer setMeta — expected ${accepted ? "accepted" : "rejected"}`).toBe(accepted);
    }
  });

  it("ms→Date: the codec serializers reject the same unrepresentable inputs", () => {
    const snap = snapshotMeta(meta);
    const nodeState = { nodeId: N("clock-node"), output: { ok: true }, completedAt: new Date("2026-08-18T00:00:00Z") };
    for (const unrepresentable of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -1e300]) {
      expect(() => serializeMeta(snap, unrepresentable), `serializeMeta accepted unrepresentable createdAtMs ${unrepresentable}`).toThrow(
        /non-representable timestamp/,
      );
    }
    // The `typeof` conjunct closes the string-coercion hole: a string that
    // `new Date` would happily parse must not be admitted as a timestamp.
    expect(() => serializeMeta(snap, "2026-08-18T00:00:00Z" as unknown as number)).toThrow(
      /non-representable timestamp/,
    );
    expect(() => serializeMeta(snap, VALID_MS)).not.toThrow();

    expect(() => serializeNode("clock-node", snapshotNodeState({ ...nodeState, completedAt: new Date(Number.NaN) }))).toThrow(
      /must be a valid Date/,
    );
    expect(() => serializeNode("clock-node", snapshotNodeState(nodeState))).not.toThrow();
    // A valid `Date` cannot carry an out-of-range getTime, so the
    // ±1e300 discriminator rows do not apply to the Date-input edge — the
    // ms→Date verdict there is "valid Date ⟺ representable", pinned above.
  });

  it("raw-ms: journal appendEvent accepts the discriminator, rejects non-finite", async () => {
    for (const [label, clock, , accepted] of clockCorpus) {
      const journal = createFileJournal(tempDir(), { now: clock });
      const outcome = await journal.appendEvent({ type: "clock-parity" }, "clock-key").then(
        () => "appended",
        (error: unknown) => `rejected: ${error instanceof Error ? error.message : "unknown"}`,
      );
      if (accepted) {
        expect(outcome, `${label}: journal appendEvent — expected appended`).toBe("appended");
      } else {
        expect(outcome, `${label}: journal appendEvent — expected a typed rejection`).toMatch(/^rejected/);
      }
    }
  });

  it("raw-ms: freshness findConflict accepts the discriminator (sinceMs parameter and internal clock), rejects non-finite", async () => {
    for (const [label, clock, , accepted] of clockCorpus) {
      const index = createFileFreshnessIndex(tempDir(), { now: clock });
      const sinceMs = accepted ? 1e300 : Number.NaN;
      const result = await index.findConflict(W("cp:parity", "1"), sinceMs);
      expect(result.ok, `${label}: freshness findConflict — expected ${accepted ? "ok (raw-ms domain admits the value)" : "a typed rejection"}`).toBe(accepted);
    }
  });

  it("the shared ms→Date predicate pins its own verdict table", () => {
    expect(isRepresentableTimestampMs(VALID_MS)).toBe(true);
    expect(isRepresentableTimestampMs(0)).toBe(true);
    expect(isRepresentableTimestampMs(Number.NaN)).toBe(false);
    expect(isRepresentableTimestampMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRepresentableTimestampMs(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isRepresentableTimestampMs(1e300)).toBe(false);
    expect(isRepresentableTimestampMs(-1e300)).toBe(false);
    expect(isRepresentableTimestampMs("2026-08-18T00:00:00Z")).toBe(false);
    expect(isRepresentableTimestampMs(null)).toBe(false);
    expect(isRepresentableTimestampMs(undefined)).toBe(false);
  });
});
