// Registry diff tests — FR-062, SC-007
// Covers: empty active, empty desired, identical, partial-overlap, update detection,
//         disjointness property: add ∩ remove = ∅, add ∩ update = ∅, remove ∩ update = ∅
//         completeness property (Wave 6 §6.8): every id ∈ active ∪ desired is
//         classified into exactly one of {add, remove, update, unchanged}

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { diffRegistry } from "../scheduler/diff.js";
import type { TaskConfig, TaskRegistry } from "../scheduler/types.js";

function task(
  id: string,
  overrides: Partial<Omit<TaskConfig, "id">> = {},
): TaskConfig {
  return {
    id,
    cron: "* * * * *",
    validForMs: 60_000,
    ...overrides,
  };
}

function reg(...tasks: TaskConfig[]): TaskRegistry {
  return new Map(tasks.map((t) => [t.id, t]));
}

describe("diffRegistry", () => {
  it("returns all desired as add when active is empty", () => {
    const desired = reg(task("A"), task("B"));
    const diff = diffRegistry(new Map(), desired);

    expect(diff.add.map((t) => t.id).sort()).toEqual(["A", "B"]);
    expect(diff.remove).toEqual([]);
    expect(diff.update).toEqual([]);
  });

  it("returns all active ids as remove when desired is empty", () => {
    const active = reg(task("A"), task("B"));
    const diff = diffRegistry(active, new Map());

    expect(diff.add).toEqual([]);
    expect([...diff.remove].sort()).toEqual(["A", "B"]);
    expect(diff.update).toEqual([]);
  });

  it("returns empty diff for identical registries", () => {
    const r = reg(task("A"), task("B", { cron: "0 * * * *" }));
    const diff = diffRegistry(r, r);

    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
    expect(diff.update).toEqual([]);
  });

  it("handles partial overlap — adds new, removes old, keeps unchanged", () => {
    const active = reg(task("A"), task("B"), task("C"));
    const desired = reg(task("B"), task("C"), task("D"));
    const diff = diffRegistry(active, desired);

    expect(diff.add.map((t) => t.id)).toEqual(["D"]);
    expect(diff.remove).toEqual(["A"]);
    expect(diff.update).toEqual([]);
  });

  it("detects cron change as an update", () => {
    const active = reg(task("A", { cron: "* * * * *" }));
    const desired = reg(task("A", { cron: "0 * * * *" }));
    const diff = diffRegistry(active, desired);

    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
    expect(diff.update.map((t) => t.id)).toEqual(["A"]);
    // The updated task should carry the new config
    expect(diff.update[0]!.cron).toBe("0 * * * *");
  });

  it("detects validForMs change as an update", () => {
    const active = reg(task("A", { validForMs: 60_000 }));
    const desired = reg(task("A", { validForMs: 120_000 }));
    const diff = diffRegistry(active, desired);

    expect(diff.update.map((t) => t.id)).toEqual(["A"]);
  });

  it("detects dependsOn change as an update", () => {
    const active = reg(task("A", { dependsOn: ["B"] }));
    const desired = reg(task("A", { dependsOn: ["C"] }));
    const diff = diffRegistry(active, desired);

    expect(diff.update.map((t) => t.id)).toEqual(["A"]);
  });

  it("treats adding dependsOn where none existed as an update", () => {
    const active = reg(task("A"));
    const desired = reg(task("A", { dependsOn: ["B"] }));
    const diff = diffRegistry(active, desired);

    expect(diff.update.map((t) => t.id)).toEqual(["A"]);
  });

  // ---------------------------------------------------------------------------
  // Disjointness property tests
  // ---------------------------------------------------------------------------

  function assertDisjoint(active: TaskRegistry, desired: TaskRegistry): void {
    const diff = diffRegistry(active, desired);

    const addSet = new Set(diff.add.map((t) => t.id));
    const removeSet = new Set(diff.remove);
    const updateSet = new Set(diff.update.map((t) => t.id));

    // add ∩ remove = ∅
    for (const id of addSet) {
      expect(removeSet.has(id)).toBe(false);
    }

    // add ∩ update = ∅
    for (const id of addSet) {
      expect(updateSet.has(id)).toBe(false);
    }

    // remove ∩ update = ∅
    for (const id of removeSet) {
      expect(updateSet.has(id)).toBe(false);
    }
  }

  it("disjointness: empty → empty", () => {
    assertDisjoint(new Map(), new Map());
  });

  it("disjointness: active=∅, desired={A,B,C}", () => {
    assertDisjoint(new Map(), reg(task("A"), task("B"), task("C")));
  });

  it("disjointness: active={A,B,C}, desired=∅", () => {
    assertDisjoint(reg(task("A"), task("B"), task("C")), new Map());
  });

  it("disjointness: partial overlap with updates", () => {
    const active = reg(
      task("A"),
      task("B", { cron: "* * * * *" }),
      task("C"),
    );
    const desired = reg(
      task("B", { cron: "0 * * * *" }), // update
      task("C"),                          // unchanged
      task("D"),                          // new
    );
    assertDisjoint(active, desired);
  });

  it("disjointness: full replacement", () => {
    const active = reg(task("A"), task("B"));
    const desired = reg(task("C"), task("D"));
    assertDisjoint(active, desired);
  });

  // Wave 6 §6.8 — completeness property test
  describe("completeness property (§6.8)", () => {
    // Cron expressions we sample from. Two values mean "configs may differ"
    // for the same id, which exercises the update arm.
    const cronArb = fc.constantFrom("* * * * *", "0 * * * *", "*/5 * * * *");
    const validForArb = fc.integer({ min: 1, max: 600_000 });
    const idArb = fc.string({ minLength: 1, maxLength: 4 });

    const taskArb = (id: string): fc.Arbitrary<TaskConfig> =>
      fc.record({
        id: fc.constant(id),
        cron: cronArb,
        validForMs: validForArb,
        dependsOn: fc.option(fc.array(idArb, { maxLength: 3 }), { nil: undefined }) as fc.Arbitrary<readonly string[] | undefined>,
      });

    const registryArb = fc.uniqueArray(idArb, { maxLength: 8, selector: (s) => s })
      .chain((ids) => fc.tuple(...ids.map((id) => taskArb(id))).map((tasks) => reg(...tasks)));

    it("|add| + |remove| + |update| + |unchanged| = |active ∪ desired|", () => {
      fc.assert(
        fc.property(registryArb, registryArb, (active, desired) => {
          const diff = diffRegistry(active, desired);
          const unionIds = new Set<string>([...active.keys(), ...desired.keys()]);

          // Compute "unchanged" as the leftover: ids in both registries that
          // were NOT emitted as add/remove/update.
          const classified = new Set<string>([
            ...diff.add.map((t) => t.id),
            ...diff.remove,
            ...diff.update.map((t) => t.id),
          ]);
          const unchanged = [...unionIds].filter((id) => !classified.has(id));

          const total =
            diff.add.length + diff.remove.length + diff.update.length + unchanged.length;
          return total === unionIds.size;
        }),
        { numRuns: 200 },
      );
    });

    it("every id ∈ active ∪ desired appears in EXACTLY one of {add, remove, update, unchanged}", () => {
      fc.assert(
        fc.property(registryArb, registryArb, (active, desired) => {
          const diff = diffRegistry(active, desired);
          const unionIds = new Set<string>([...active.keys(), ...desired.keys()]);

          const adds = new Set(diff.add.map((t) => t.id));
          const removes = new Set(diff.remove);
          const updates = new Set(diff.update.map((t) => t.id));
          const unchanged = new Set<string>(
            [...unionIds].filter(
              (id) => !adds.has(id) && !removes.has(id) && !updates.has(id),
            ),
          );

          for (const id of unionIds) {
            const buckets = [
              adds.has(id),
              removes.has(id),
              updates.has(id),
              unchanged.has(id),
            ].filter(Boolean).length;
            if (buckets !== 1) return false;
          }
          return true;
        }),
        { numRuns: 200 },
      );
    });

    it("add ⊆ desired \\ active, remove ⊆ active \\ desired, update ⊆ active ∩ desired", () => {
      fc.assert(
        fc.property(registryArb, registryArb, (active, desired) => {
          const diff = diffRegistry(active, desired);
          for (const t of diff.add) {
            if (!desired.has(t.id) || active.has(t.id)) return false;
          }
          for (const id of diff.remove) {
            if (!active.has(id) || desired.has(id)) return false;
          }
          for (const t of diff.update) {
            if (!active.has(t.id) || !desired.has(t.id)) return false;
          }
          return true;
        }),
        { numRuns: 200 },
      );
    });
  });
});
