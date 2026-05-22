/**
 * Property tests for DAG diff — set-theoretic invariants.
 *
 * Invariants:
 * 1. |added| + |changed| + |unchanged| == |current| (when ids unique)
 * 2. Every id in added is absent from previous
 * 3. Every id in removed is absent from current
 * 4. diffDags(a, a) → all unchanged
 * 5. diffDags([], b) → all added
 * 6. diffDags(a, []) → all removed
 * 7. hasChanges is false iff added + removed + changed are empty
 */

import { describe, it } from "bun:test";
import * as fc from "fast-check";
import { dagId } from "@fugue/framework";
import { diffDags, hasChanges, diffSummary } from "../domain/dag-diff.js";
import type { DagSnapshot } from "../domain/dag-diff.js";

// ── Arbitraries ────────────────────────────────────────────────────────────

const arbDagId = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/).map((s) => dagId(s));
const arbSha = fc.stringMatching(/^[0-9a-f]{7}$/);

const arbSnapshot = fc.record({
  id: arbDagId,
  path: fc.stringMatching(/^\/dags\/[a-z]+\/[a-z-]+\/dag\.ts$/),
  sha: arbSha,
});

const arbSnapshotList = fc.uniqueArray(arbSnapshot, {
  comparator: (a, b) => a.id === b.id,
  maxLength: 20,
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("diff property tests", () => {
  it("added + changed + unchanged == |current| (unique ids)", () => {
    fc.assert(
      fc.property(arbSnapshotList, arbSnapshotList, (prev, curr) => {
        const diff = diffDags(prev, curr);
        return diff.added.length + diff.changed.length + diff.unchanged.length === curr.length;
      }),
    );
  });

  it("removed + changed + unchanged == |previous| (unique ids)", () => {
    fc.assert(
      fc.property(arbSnapshotList, arbSnapshotList, (prev, curr) => {
        const diff = diffDags(prev, curr);
        return diff.removed.length + diff.changed.length + diff.unchanged.length === prev.length;
      }),
    );
  });

  it("every added id is absent from previous", () => {
    fc.assert(
      fc.property(arbSnapshotList, arbSnapshotList, (prev, curr) => {
        const diff = diffDags(prev, curr);
        const prevIds = new Set(prev.map((d) => d.id));
        return diff.added.every((d) => !prevIds.has(d.id));
      }),
    );
  });

  it("every removed id is absent from current", () => {
    fc.assert(
      fc.property(arbSnapshotList, arbSnapshotList, (prev, curr) => {
        const diff = diffDags(prev, curr);
        const currIds = new Set(curr.map((d) => d.id));
        return diff.removed.every((d) => !currIds.has(d.id));
      }),
    );
  });

  it("diffDags(a, a) → all unchanged", () => {
    fc.assert(
      fc.property(arbSnapshotList, (snaps) => {
        const diff = diffDags(snaps, snaps);
        return (
          diff.added.length === 0 &&
          diff.removed.length === 0 &&
          diff.changed.length === 0 &&
          diff.unchanged.length === snaps.length
        );
      }),
    );
  });

  it("diffDags([], b) → all added", () => {
    fc.assert(
      fc.property(arbSnapshotList, (curr) => {
        const diff = diffDags([], curr);
        return diff.added.length === curr.length && diff.removed.length === 0;
      }),
    );
  });

  it("diffDags(a, []) → all removed", () => {
    fc.assert(
      fc.property(arbSnapshotList, (prev) => {
        const diff = diffDags(prev, []);
        return diff.removed.length === prev.length && diff.added.length === 0;
      }),
    );
  });

  it("hasChanges is false iff no added/removed/changed", () => {
    fc.assert(
      fc.property(arbSnapshotList, arbSnapshotList, (prev, curr) => {
        const diff = diffDags(prev, curr);
        const expectedNoChanges =
          diff.added.length === 0 &&
          diff.removed.length === 0 &&
          diff.changed.length === 0;
        return hasChanges(diff) === !expectedNoChanges;
      }),
    );
  });

  it("diffSummary returns non-empty string", () => {
    fc.assert(
      fc.property(arbSnapshotList, arbSnapshotList, (prev, curr) => {
        const diff = diffDags(prev, curr);
        const summary = diffSummary(diff);
        return typeof summary === "string" && summary.length > 0;
      }),
    );
  });
});
