// Catch-up decision tests — FR-063, SC-007 (100% branch coverage)
// Covers all four cases.

import { describe, it, expect } from "bun:test";
import { decideCatchUp } from "../scheduler/catch-up.js";

describe("decideCatchUp", () => {
  // Case 1: fired but not completed → skip (in-flight)
  describe("Case 1 — fired, not completed → skip", () => {
    it("returns skip when fired=true, completed=false regardless of validity", () => {
      const result = decideCatchUp(true, false, true, ["dep-b"]);
      expect(result.kind).toBe("skip");
      if (result.kind === "skip") {
        expect(result.reason).toContain("in-flight");
      }
    });

    it("returns skip when fired=true, completed=false, outside window", () => {
      const result = decideCatchUp(true, false, false, []);
      expect(result.kind).toBe("skip");
    });

    it("returns skip when fired=true, completed=false, no dependents", () => {
      const result = decideCatchUp(true, false, true, []);
      expect(result.kind).toBe("skip");
    });
  });

  // Case 2: fired, completed, within validity, has dependents → enqueue-dependents
  describe("Case 2 — fired+completed, within window, has dependents → enqueue-dependents", () => {
    it("returns enqueue-dependents with the dependent ids", () => {
      const result = decideCatchUp(true, true, true, ["dep-b", "dep-c"]);
      expect(result.kind).toBe("enqueue-dependents");
      if (result.kind === "enqueue-dependents") {
        expect(result.dependentIds).toEqual(["dep-b", "dep-c"]);
      }
    });
  });

  // Case 2b: fired, completed, within validity, NO dependents → skip (no action)
  describe("Case 2b — fired+completed, within window, no dependents → skip", () => {
    it("returns skip when fired+completed within window but no dependents", () => {
      const result = decideCatchUp(true, true, true, []);
      expect(result.kind).toBe("skip");
    });
  });

  // Case 3: not fired, within validity → enqueue-standalone
  describe("Case 3 — not fired, within validity → enqueue-standalone", () => {
    it("returns enqueue-standalone when not fired and within validity window", () => {
      const result = decideCatchUp(false, false, true, []);
      expect(result.kind).toBe("enqueue-standalone");
    });

    it("returns enqueue-standalone even when there are dependents (own fire takes priority)", () => {
      const result = decideCatchUp(false, false, true, ["dep-b"]);
      expect(result.kind).toBe("enqueue-standalone");
    });

    it("returns enqueue-standalone when not fired and completed=false, within window", () => {
      // completed=false is the normal state for unfired tasks
      const result = decideCatchUp(false, false, true, ["dep-b"]);
      expect(result.kind).toBe("enqueue-standalone");
    });
  });

  // Case 4: outside validity window (or other non-actionable) → skip
  describe("Case 4 — outside validity window → skip", () => {
    it("returns skip when not fired and outside validity window", () => {
      const result = decideCatchUp(false, false, false, []);
      expect(result.kind).toBe("skip");
    });

    it("returns skip when not fired, outside window, with dependents", () => {
      const result = decideCatchUp(false, false, false, ["dep-b"]);
      expect(result.kind).toBe("skip");
    });

    it("returns skip when fired+completed but outside validity window", () => {
      const result = decideCatchUp(true, true, false, ["dep-b"]);
      expect(result.kind).toBe("skip");
    });

    it("returns skip when fired+completed, outside window, no dependents", () => {
      const result = decideCatchUp(true, true, false, []);
      expect(result.kind).toBe("skip");
    });
  });

  // Edge: completed=true but fired=false is a degenerate state — treat as not-fired
  describe("degenerate: completed=true but fired=false", () => {
    it("treats as not-fired case when within validity window", () => {
      // fired=false → we hit the !fired branch regardless of completed
      const result = decideCatchUp(false, true, true, []);
      expect(result.kind).toBe("enqueue-standalone");
    });

    it("treats as not-fired case when outside validity window", () => {
      const result = decideCatchUp(false, true, false, []);
      expect(result.kind).toBe("skip");
    });
  });
});
