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
//
// Scope: `ClockCapability` governs only *node-visible* wall-clock reads. It is a
// distinct seam from the runtime's infrastructure timestamp source (`now:
// () => number`, defaulting to `Date.now`, threaded through `run-node`, the
// scheduler, cache, checkpointer, and observers). Wiring `fixedClock` pins what
// a node reads via `ctx.clock`; it does NOT pin event/observer timestamps —
// those follow the separate `now` injection. A test that needs both pinned must
// wire both seams.

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
 * Test clock pinned to a fixed instant. Every `now()` returns a *fresh* `Date`
 * for the same instant, making any DAG that reads `ctx.clock` reproducible. Pass
 * to `makeNodeContext` as `clock` (or in the `capabilities` record).
 *
 * A new `Date` is minted per call (rather than handing back the captured `at`)
 * so a node that mutates the returned `Date` in place cannot poison the fixture
 * for later readers — matching `systemClock`'s fresh-instance semantics.
 *
 * ```ts
 * const ctx = makeNodeContext({ runId, dagId, clock: fixedClock(new Date("2026-06-12T00:00:00Z")) });
 * ```
 */
export const fixedClock = (at: Date): ClockCapability => {
  const ms = at.getTime();
  return { now: () => new Date(ms) };
};

/**
 * ONE encoding of the ms→Date clock domain's representability check
 * (deepening round, simp-5): a raw millisecond timestamp is representable
 * when it is a `number` that is finite AND `new Date` accepts — the
 * ±100,000-year Time Value range. A finite number OUTSIDE that range
 * (e.g. `1e300`) yields an invalid `Date`, so `toISOString()` throws and
 * TTL comparisons silently compare `NaN` — both fail-closed only when the
 * guard rejects the value BEFORE the conversion.
 *
 * This is the shared guard for the three ms→Date clock sites — the file
 * checkpointer `readClock`, the in-memory checkpointer `readClock`, and the
 * checkpoint codec serializers' timestamp checks (`serializeMeta`'s
 * `createdAtMs`, `serializeNode`'s `completedAt` getTime). The raw-ms clock
 * domain (journal `recordedAtMs`, freshness-index `writtenAtMs`) is
 * deliberately NOT this check: those values are stored as raw `number`s
 * and consumed by arithmetic — no `Date` conversion ever happens — so
 * representability is out of domain and finiteness alone is the guard
 * there. The two-domain split is pinned in `clock-parity.test.ts` (`±1e300`
 * is the discriminator row: raw-ms sites accept, ms→Date sites reject).
 *
 * The `typeof` conjunct stays explicit so a hostile brand-bypassed
 * non-number never reaches `new Date`'s string coercion — matching the
 * per-site behavior exactly.
 */
export const isRepresentableTimestampMs = (ms: unknown): boolean =>
  typeof ms === "number" && Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
