// Cycle detection tests — FR-061, SC-007
// 5 cases: no deps, self-loop, 2-cycle, 3-cycle, DAG-no-cycle

import { describe, it, expect } from "bun:test";
import { hasCycle } from "../scheduler/cycle.js";
import type { TaskRegistry } from "../scheduler/types.js";

function makeRegistry(
  entries: Array<{ id: string; dependsOn?: string[] }>,
): TaskRegistry {
  return new Map(
    entries.map((e) => [
      e.id,
      { id: e.id, cron: "* * * * *", validForMs: 60_000, dependsOn: e.dependsOn },
    ]),
  );
}

describe("hasCycle", () => {
  it("returns false when task has no dependencies", () => {
    const reg = makeRegistry([{ id: "A" }]);
    expect(hasCycle("A", reg)).toBe(false);
  });

  it("returns true for a self-loop (A depends on A)", () => {
    const reg = makeRegistry([{ id: "A", dependsOn: ["A"] }]);
    expect(hasCycle("A", reg)).toBe(true);
  });

  it("returns true for a 2-cycle (A→B→A)", () => {
    const reg = makeRegistry([
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ]);
    expect(hasCycle("A", reg)).toBe(true);
    expect(hasCycle("B", reg)).toBe(true);
  });

  it("returns true for a 3-cycle (A→B→C→A)", () => {
    const reg = makeRegistry([
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["C"] },
      { id: "C", dependsOn: ["A"] },
    ]);
    expect(hasCycle("A", reg)).toBe(true);
    expect(hasCycle("B", reg)).toBe(true);
    expect(hasCycle("C", reg)).toBe(true);
  });

  it("returns false for a valid DAG with no cycle (A→B, A→C, B→D, C→D)", () => {
    const reg = makeRegistry([
      { id: "A", dependsOn: ["B", "C"] },
      { id: "B", dependsOn: ["D"] },
      { id: "C", dependsOn: ["D"] },
      { id: "D" },
    ]);
    expect(hasCycle("A", reg)).toBe(false);
    expect(hasCycle("B", reg)).toBe(false);
    expect(hasCycle("C", reg)).toBe(false);
    expect(hasCycle("D", reg)).toBe(false);
  });

  it("returns false when a dependency is not present in the registry (treats as leaf)", () => {
    const reg = makeRegistry([{ id: "A", dependsOn: ["missing"] }]);
    expect(hasCycle("A", reg)).toBe(false);
  });
});
