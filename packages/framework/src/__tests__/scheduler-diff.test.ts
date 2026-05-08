// Registry diff tests — FR-062, SC-007
// Covers: empty active, empty desired, identical, partial-overlap, update detection,
//         disjointness property: add ∩ remove = ∅, add ∩ update = ∅, remove ∩ update = ∅

import { describe, it, expect } from "bun:test";
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
    expect(diff.remove.sort()).toEqual(["A", "B"]);
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
});
