import { describe, test, expect } from "bun:test";
import type { Observer } from "../observer/observer.js";

/**
 * Wave 1.4 — `Observer.onRouteDecided` and `Observer.onNodePruned` are now
 * required. Custom observers that forget to implement them used to silently
 * miss routing/pruning events; the type-level guarantee replaces the runtime
 * `?.()` paper-over in `dispatchEvent`.
 *
 * This test is a compile-time assertion: removing one of the now-required
 * methods from a literal must produce a TypeScript error. The accompanying
 * `// @ts-expect-error` lines fail the build if the constraint is ever
 * relaxed.
 */
describe("Observer port — required methods (Wave 1.4)", () => {
  test("Observer literal missing onRouteDecided fails to compile", () => {
    // @ts-expect-error onRouteDecided is required
    const _missingRouteDecided: Observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRunEnd: () => {},
      onNodePruned: () => {},
    };
    void _missingRouteDecided;

    // @ts-expect-error onNodePruned is required
    const _missingNodePruned: Observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRunEnd: () => {},
      onRouteDecided: () => {},
    };
    void _missingNodePruned;

    expect(true).toBe(true);
  });

  test("Observer literal with all methods compiles", () => {
    const full: Observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRunEnd: () => {},
      onRouteDecided: () => {},
      onNodePruned: () => {},
    };
    expect(typeof full.onRouteDecided).toBe("function");
    expect(typeof full.onNodePruned).toBe("function");
  });
});
