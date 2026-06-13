// Clock capability (C2) — the framework's injectable wall-clock source.
//
// Nodes that need the current time declare `requires: ["clock"]` and read
// `ctx.clock.now()` instead of calling `new Date()` / `Date.now()` directly.
// The host wires `systemClock` in production; tests wire `fixedClock(at)` so a
// run is deterministic without monkey-patching globals or threading a hand-
// rolled `now` seam through a DAG factory.
//
// Keeping the clock a capability (not a `BaseNodeContext` infrastructure field)
// means pure transforms stay clock-free by construction: only a node that
// *declares* `["clock"]` can read time, so a transform that secretly depends on
// the wall clock is a compile error at its use site, not a hidden runtime
// nondeterminism.

/**
 * Wall-clock capability. `now()` returns the current instant as a `Date`.
 * The single method keeps the seam minimal; everything date-shaped a node
 * needs (epoch ms, ISO string) derives from the returned `Date`.
 */
export interface ClockCapability {
  readonly now: () => Date;
}

/**
 * Production clock — reads the real system time on every call. Host wiring
 * passes this as the `clock` capability. (`new Date()` is the intended source
 * here; this is the one sanctioned place the framework reads the wall clock.)
 */
export const systemClock: ClockCapability = {
  now: () => new Date(),
};

/**
 * Test clock pinned to a fixed instant. Every `now()` returns the same `Date`,
 * making any DAG that reads `ctx.clock` reproducible. Pass to `makeNodeContext`
 * as `clock` (or in the `capabilities` record).
 *
 * ```ts
 * const ctx = makeNodeContext({ runId, dagId, clock: fixedClock(new Date("2026-06-12T00:00:00Z")) });
 * ```
 */
export const fixedClock = (at: Date): ClockCapability => ({
  now: () => at,
});
