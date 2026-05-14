import { describe, test, expect } from "bun:test";
import type { Observer } from "../observer/observer.js";

/**
 * Wave 1.4 — `Observer.onRouteDecided` and `Observer.onNodePruned` are now
 * required. Custom observers that forget to implement them used to silently
 * miss routing/pruning events; the type-level guarantee replaces the runtime
 * `?.()` paper-over in `dispatchEvent`.
 *
 * Phase 3 — `onWitnessCaptured`, `onWriteAttempted`, `onFreshnessViolation`
 * are now required for freshness-witness observability.
 *
 * This test is a compile-time assertion: removing one of the now-required
 * methods from a literal must produce a TypeScript error. The accompanying
 * `// @ts-expect-error` lines fail the build if the constraint is ever
 * relaxed.
 */
describe("Observer port — required methods (Wave 1.4 + Phase 3 + Phase 4)", () => {
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
      onWitnessCaptured: () => {},
      onWriteAttempted: () => {},
      onFreshnessViolation: () => {},
      onHumanIntervention: () => {},
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
      onWitnessCaptured: () => {},
      onWriteAttempted: () => {},
      onFreshnessViolation: () => {},
      onHumanIntervention: () => {},
    };
    void _missingNodePruned;

    expect(true).toBe(true);
  });

  test("Observer literal missing freshness methods fails to compile", () => {
    // @ts-expect-error onWitnessCaptured is required
    const _missingWitnessCaptured: Observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRunEnd: () => {},
      onRouteDecided: () => {},
      onNodePruned: () => {},
      onWriteAttempted: () => {},
      onFreshnessViolation: () => {},
      onHumanIntervention: () => {},
    };
    void _missingWitnessCaptured;

    // @ts-expect-error onWriteAttempted is required
    const _missingWriteAttempted: Observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRunEnd: () => {},
      onRouteDecided: () => {},
      onNodePruned: () => {},
      onWitnessCaptured: () => {},
      onFreshnessViolation: () => {},
      onHumanIntervention: () => {},
    };
    void _missingWriteAttempted;

    // @ts-expect-error onFreshnessViolation is required
    const _missingFreshnessViolation: Observer = {
      onRunStart: () => {},
      onNodeStart: () => {},
      onNodeEnd: () => {},
      onNodeSkipped: () => {},
      onNodeError: () => {},
      onSubSpan: () => {},
      onRunEnd: () => {},
      onRouteDecided: () => {},
      onNodePruned: () => {},
      onWitnessCaptured: () => {},
      onWriteAttempted: () => {},
      onHumanIntervention: () => {},
    };
    void _missingFreshnessViolation;

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
      onWitnessCaptured: () => {},
      onWriteAttempted: () => {},
      onFreshnessViolation: () => {},
      onHumanIntervention: () => {},
    };
    expect(typeof full.onRouteDecided).toBe("function");
    expect(typeof full.onNodePruned).toBe("function");
    expect(typeof full.onWitnessCaptured).toBe("function");
    expect(typeof full.onWriteAttempted).toBe("function");
    expect(typeof full.onFreshnessViolation).toBe("function");
    expect(typeof full.onHumanIntervention).toBe("function");
  });
});
