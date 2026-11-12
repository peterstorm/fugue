// fan-machine — LC-1, the fan scheduler lifecycle (AD-1, AD-2, AD-11).
//
// A pure Mealy transition `fanStep(state, event) → { state, commands }` that
// owns admission and termination of one `map` fan. The shell (`runMappedFan`)
// executes the commands — runs a slot per `replay` / `dispatch`, emits the
// observer events, saves the seed — and feeds back `slot-settled` events with
// a fresh headroom snapshot. The machine sees only data.
//
// Phases (INV-1: these literals live in THIS file only):
//   fan-dispatching ─ work runs out ─────────────▶ fan-done{reduce}
//   fan-dispatching ─ failure / refusal / abort ─▶ fan-draining{cause} ─▶ fan-done{fail}
// `fan-done` is absorbing: every event there returns the same state and no
// commands. Draining entered with zero slots in flight goes straight to done.
//
// Rules this module decides, once:
//   - Indices START in strictly ascending order through one cursor; a
//     replayed index is `replay`ed, never dispatched. A replay occupies a slot
//     like a dispatch, so at C = 1 the command order is today's sequential
//     loop exactly (FR-004).
//   - Slots in flight ≤ effective concurrency, always (FR-003).
//   - Unseeded: the first min(C, unreplayed) dispatches are the unprojected
//     probe batch (FR-010, AS-009). Every later dispatch is preceded by a
//     projection `settled + remainingChildren × estimate` on every budgeted
//     axis; a breach refuses and drains (FR-011, AS-010).
//   - Seeded (AD-11): ceilings not raised and work left ⇒ sticky refusal at
//     start with 0 dispatches (FR-017, AS-014); raised ⇒ no probe, the
//     estimator restarts from the seeded samples, and EVERY dispatch is
//     projected (AS-056). No work left ⇒ reduce normally.
//   - `remainingChildren` = width − saved children (AD-4). Replayed indices
//     are saved from the start (they cost nothing in this run), so the
//     projection and the refusal's `completed` / `remaining` count only the
//     children still owed spend; a replay that fails to parse returns to the
//     remainder.
//   - A terminal failure, a refusal or an abort stops starts; in-flight slots
//     drain and their outcomes are kept (FR-020). The drain cause accumulates
//     failures, the refusal and the abort flag, so a mixed drain loses nothing
//     (FR-025); the single error comes from `finishError` (AD-6 precedence).
//   - Every transition into fan-done with a refusal emits `emit-refused`,
//     then `persist-seed`, then `finish`, in that order (FR-026, AS-056).
//
// Functional core: pure, total, no I/O (INV-4).

import { match } from "ts-pattern";
import type { Remaining } from "../../types/budget-capability.js";
import type { Ceiling } from "../../types/budget.js";
import { frameworkError } from "../../types/error-factories.js";
import type { FrameworkError } from "../../types/errors.js";
import type { FanProjectionEvent } from "../../types/events.js";
import {
  FAN_SEED_VERSION,
  fanRefusal,
  type ChildConcurrency,
  type FanEstimator,
  type FanRefusal,
  type FanRefusalSeed,
  type IndexedError,
  type SpendSample,
} from "../../types/fan-scheduling.js";
import type { NodeId } from "../../types/ids.js";
import { mapIndex, type MapIndex } from "../../types/map-index.js";
import { finishError } from "./error-order.js";
import { estimate, type Estimate } from "./estimator.js";
import { project, type AxisCheck } from "./projection.js";
import { ceilingsOfRemaining, ceilingsRaised } from "./seed.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Failure = IndexedError<FrameworkError>;

/**
 * A projection refusal as decided, with what its refusal seed needs: the
 * budgeted ceilings in force and the per-child estimate at the decision.
 * `refusal.completed` / `remaining` are refreshed when the drain finishes, so
 * drain completions are counted (FR-022).
 */
type RefusalDecision = Readonly<{
  refusal: FanRefusal;
  ceilings: readonly Ceiling[];
  estimate: SpendSample;
  /** Replayed from a persisted seed at start (AD-11), not freshly projected. */
  sticky: boolean;
}>;

/** Why a fan stopped starting children. Accumulates — nothing observed in the drain is dropped. */
type DrainCause = Readonly<{
  failures: readonly Failure[];
  refusal: RefusalDecision | null;
  aborted: boolean;
}>;

/** How a finished fan ends: the reducer's ordered input, or its single error. */
export type FanFinish =
  | Readonly<{ kind: "reduce"; ordered: readonly unknown[] }>
  | Readonly<{ kind: "fail"; error: FrameworkError }>;

type FanPhase =
  | Readonly<{ phase: "fan-dispatching" }>
  | Readonly<{ phase: "fan-draining"; cause: DrainCause }>
  | Readonly<{ phase: "fan-done"; finish: FanFinish }>;

/** What one started slot came to. A replay-parse or save failure is `failed`. */
export type SlotOutcome =
  | Readonly<{ kind: "replayed"; value: unknown }>
  | Readonly<{ kind: "completed"; value: unknown; sample: SpendSample }>
  | Readonly<{ kind: "failed"; error: FrameworkError; sample?: SpendSample }>;

export type FanEvent =
  | Readonly<{ type: "start"; admission: Remaining }>
  | Readonly<{ type: "slot-settled"; index: MapIndex; outcome: SlotOutcome; admission: Remaining }>
  | Readonly<{ type: "abort" }>;

/** One evaluated budget axis of a projection: the payload of a `fan-projection` event. */
export type ProjectionRecord = Readonly<Pick<FanProjectionEvent,
  "effectiveConcurrency" | "axis" | "estimate" | "estimatorApplied" | "remainingChildren" | "verdict" | "lowerBound">>;

export type FanCommand =
  | Readonly<{ type: "replay"; index: MapIndex }>
  | Readonly<{ type: "dispatch"; index: MapIndex }>
  | Readonly<{ type: "emit-projection"; record: ProjectionRecord }>
  | Readonly<{ type: "emit-refused"; refusal: FanRefusal; sticky: boolean; attachedToChildFailure: boolean }>
  | Readonly<{ type: "persist-seed"; seed: FanRefusalSeed }>
  | Readonly<{ type: "finish"; finish: FanFinish }>;

export type FanConfig = Readonly<{
  nodeId: NodeId;
  /** The fan's resolved child count. */
  width: number;
  /** Indices satisfied from checkpoints of the current execution epoch. */
  replayedIndices: ReadonlySet<number>;
  effective: ChildConcurrency;
  estimator: FanEstimator;
  /** The refusal seed of the current execution epoch, if one was persisted. */
  seed: FanRefusalSeed | null;
}>;

export type FanState = Readonly<{
  config: FanConfig;
  phase: FanPhase;
  started: boolean;
  /** The next index to start; every index below it has been started. */
  cursor: number;
  inFlight: ReadonlySet<number>;
  values: ReadonlyMap<number, unknown>;
  /** Seeded samples, then every measured sample in settle order. */
  samples: readonly SpendSample[];
  /** Saved children: replayed indices (from the start) plus successful completions. */
  saved: number;
  /** Unprojected probe dispatches left. */
  probe: number;
}>;

type FanStep = Readonly<{ state: FanState; commands: readonly FanCommand[] }>;

// ---------------------------------------------------------------------------
// Construction and guards
// ---------------------------------------------------------------------------

const DISPATCHING: FanPhase = Object.freeze({ phase: "fan-dispatching" });

const replayedInRange = (c: FanConfig): number =>
  [...c.replayedIndices].filter((i) => Number.isSafeInteger(i) && i >= 0 && i < c.width).length;

/** The initial state of a fan: nothing started, the probe budget set by whether a seed exists. */
export const initFan = (config: FanConfig): FanState => {
  const replayed = replayedInRange(config);
  return Object.freeze({
    config,
    phase: DISPATCHING,
    started: false,
    cursor: 0,
    inFlight: new Set<number>(),
    values: new Map<number, unknown>(),
    samples: Object.freeze([...(config.seed?.samples ?? [])]),
    saved: replayed,
    probe: config.seed === null ? Math.min(config.effective, config.width - replayed) : 0,
  });
};

/** True once the fan has finished; its `finish` command has been emitted. */
export const isFanDone = (s: FanState): boolean => s.phase.phase === "fan-done";

const stay = (state: FanState): FanStep => Object.freeze({ state, commands: Object.freeze([]) });
const stepOf = (state: FanState, commands: readonly FanCommand[]): FanStep =>
  Object.freeze({ state: Object.freeze(state), commands: Object.freeze([...commands]) });

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

/** LC-1: the one transition function. */
export const fanStep = (s: FanState, e: FanEvent): FanStep =>
  match(s.phase)
    .returnType<FanStep>()
    .with({ phase: "fan-done" }, () => stay(s))
    .with({ phase: "fan-dispatching" }, () => dispatchingStep(s, e))
    .with({ phase: "fan-draining" }, (p) => drainingStep(s, p.cause, e))
    .exhaustive();

const dispatchingStep = (s: FanState, e: FanEvent): FanStep =>
  match(e)
    .returnType<FanStep>()
    .with({ type: "start" }, (ev) => (s.started ? stay(s) : start({ ...s, started: true }, ev.admission)))
    .with({ type: "slot-settled" }, (ev) => {
      if (!s.inFlight.has(ev.index)) return stay(s);
      const settled = record(s, ev.index, ev.outcome);
      return ev.outcome.kind === "failed"
        ? drain(settled, { failures: [{ index: ev.index, error: ev.outcome.error }], refusal: null, aborted: false }, [])
        : fill(settled, ev.admission, []);
    })
    .with({ type: "abort" }, () => drain(s, { failures: [], refusal: null, aborted: true }, []))
    .exhaustive();

const drainingStep = (s: FanState, cause: DrainCause, e: FanEvent): FanStep =>
  match(e)
    .returnType<FanStep>()
    .with({ type: "start" }, () => stay(s))
    .with({ type: "slot-settled" }, (ev) => {
      if (!s.inFlight.has(ev.index)) return stay(s);
      const failures = ev.outcome.kind === "failed"
        ? [...cause.failures, { index: ev.index, error: ev.outcome.error }]
        : cause.failures;
      return drain(record(s, ev.index, ev.outcome), { ...cause, failures }, []);
    })
    .with({ type: "abort" }, () => (cause.aborted ? stay(s) : drain(s, { ...cause, aborted: true }, [])))
    .exhaustive();

/** The first event: evaluate the seed (AD-11) before anything starts. */
const start = (s: FanState, admission: Remaining): FanStep => {
  const { seed, width } = s.config;
  return seed !== null && s.saved < width && !ceilingsRaised(seed.ceilings, admission)
    ? drain(s, { failures: [], refusal: stickyRefusal(s, seed, admission), aborted: false }, [])
    : fill(s, admission, []);
};

/** Fold a settled slot into the state: free its slot, keep its value and sample. */
const record = (s: FanState, index: number, outcome: SlotOutcome): FanState => {
  const isReplay = s.config.replayedIndices.has(index);
  const inFlight = new Set(s.inFlight);
  inFlight.delete(index);
  const base = { ...s, inFlight };
  return match(outcome)
    .returnType<FanState>()
    .with({ kind: "replayed" }, { kind: "completed" }, (o) => ({
      ...base,
      values: new Map(s.values).set(index, o.value),
      samples: o.kind === "completed" ? [...s.samples, o.sample] : s.samples,
      saved: isReplay ? s.saved : s.saved + 1,
    }))
    .with({ kind: "failed" }, (o) => ({
      ...base,
      samples: o.sample === undefined ? s.samples : [...s.samples, o.sample],
      saved: isReplay ? s.saved - 1 : s.saved,
    }))
    .exhaustive();
};

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

const startSlot = (s: FanState, i: number, probe: number): FanState =>
  ({ ...s, cursor: i + 1, inFlight: new Set(s.inFlight).add(i), probe });

/**
 * Start indices in ascending order while a slot is free: replay, probe
 * dispatch, or projected dispatch. A breach refuses and drains; running out
 * of work with nothing in flight finishes the fan.
 */
const fill = (s: FanState, admission: Remaining, acc: readonly FanCommand[]): FanStep => {
  const { width, effective, replayedIndices } = s.config;
  const i = s.cursor;
  if (s.inFlight.size >= effective || i >= width) {
    return s.inFlight.size === 0 && i >= width ? finishReduce(s, acc) : stepOf(s, acc);
  }
  const index = mapIndex(i);
  if (replayedIndices.has(i)) return fill(startSlot(s, i, s.probe), admission, [...acc, { type: "replay", index }]);
  if (s.probe > 0) return fill(startSlot(s, i, s.probe - 1), admission, [...acc, { type: "dispatch", index }]);
  const est = estimate(s.samples, s.config.estimator);
  const remainingChildren = width - s.saved;
  const projection = project(admission, remainingChildren, est.perChild);
  if (projection.kind === "breach") {
    const records = [...acc, projected(s, est, remainingChildren, projection, "refuse")];
    return drain(s, { failures: [], refusal: freshRefusal(s, est, projection, admission), aborted: false }, records);
  }
  const records = projection.checks.map((c) => projected(s, est, remainingChildren, c, "admit"));
  return fill(startSlot(s, i, 0), admission, [...acc, ...records, { type: "dispatch", index }]);
};

const projected = (
  s: FanState,
  est: Estimate,
  remainingChildren: number,
  check: AxisCheck,
  verdict: ProjectionRecord["verdict"],
): FanCommand => ({
  type: "emit-projection",
  record: Object.freeze({
    effectiveConcurrency: s.config.effective,
    axis: check.axis,
    estimate: check.estimate,
    estimatorApplied: est.applied,
    remainingChildren,
    verdict,
    lowerBound: check.lowerBound || est.perChild.lowerBound,
  }),
});

const freshRefusal = (s: FanState, est: Estimate, breach: AxisCheck, admission: Remaining): RefusalDecision =>
  Object.freeze({
    refusal: fanRefusal({
      ceiling: breach.ceiling,
      perChildEstimate: breach.estimate,
      estimatorApplied: est.applied,
      effectiveConcurrency: s.config.effective,
      completed: s.saved,
      remaining: s.config.width - s.saved,
      lowerBound: breach.lowerBound || est.perChild.lowerBound,
    }),
    ceilings: ceilingsOfRemaining(admission),
    estimate: est.perChild,
    sticky: false,
  });

/** AD-11: re-refuse from the seed, against the ceiling now in force on the seeded axis. */
const stickyRefusal = (s: FanState, seed: FanRefusalSeed, admission: Remaining): RefusalDecision => {
  const current = ceilingsOfRemaining(admission);
  const axis = seed.refusal.axis;
  const perChildEstimate = match(axis)
    .with("tokens", () => seed.estimate.tokens)
    .with("calls", () => seed.estimate.calls)
    .with("usd", () => seed.estimate.usdMicros)
    .exhaustive();
  return Object.freeze({
    refusal: fanRefusal({
      ceiling: current.find((c) => c.kind === axis) ?? seed.refusal.ceiling,
      perChildEstimate,
      estimatorApplied: seed.refusal.estimatorApplied,
      effectiveConcurrency: s.config.effective,
      completed: s.saved,
      remaining: s.config.width - s.saved,
      lowerBound: seed.refusal.lowerBound,
    }),
    ceilings: current,
    estimate: seed.estimate,
    sticky: true,
  });
};

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/** Enter (or stay in) the drain; with nothing in flight the fan finishes now. */
const drain = (s: FanState, cause: DrainCause, acc: readonly FanCommand[]): FanStep => {
  const draining: FanState = { ...s, phase: Object.freeze({ phase: "fan-draining", cause: Object.freeze(cause) }) };
  return s.inFlight.size === 0 ? finishDrain(draining, cause, acc) : stepOf(draining, acc);
};

const done = (s: FanState, finish: FanFinish, acc: readonly FanCommand[]): FanStep =>
  stepOf({ ...s, phase: Object.freeze({ phase: "fan-done", finish }) }, [...acc, { type: "finish", finish }]);

const finishReduce = (s: FanState, acc: readonly FanCommand[]): FanStep =>
  done(s, Object.freeze({
    kind: "reduce",
    ordered: Object.freeze(Array.from({ length: s.config.width }, (_, i) => s.values.get(i))),
  }), acc);

/** The drain's single outcome (AD-6); a refusal is emitted and its seed persisted first. */
const finishDrain = (s: FanState, cause: DrainCause, acc: readonly FanCommand[]): FanStep => {
  const decision = cause.refusal;
  const refusal = decision === null ? null : refreshed(decision.refusal, s);
  const error = finishError(s.config.nodeId, cause.failures, refusal, cause.aborted)
    // Unreachable by construction: a drain is only ever entered with a cause.
    // Fail closed with a typed, non-retriable error rather than reducing a
    // partial fan (FR-016).
    ?? frameworkError.nodeCrash(s.config.nodeId, "fan drained without a cause", { retriability: "non-retriable" });
  const finish: FanFinish = Object.freeze({ kind: "fail", error });
  if (decision === null || refusal === null) return done(s, finish, acc);
  return done(s, finish, [
    ...acc,
    { type: "emit-refused", refusal, sticky: decision.sticky, attachedToChildFailure: cause.failures.length > 0 },
    { type: "persist-seed", seed: seedOf(s, decision, refusal) },
  ]);
};

/** The refusal as of the drain's end: drain completions are counted (FR-022). */
const refreshed = (r: FanRefusal, s: FanState): FanRefusal =>
  fanRefusal({
    ceiling: r.ceiling,
    perChildEstimate: r.perChildEstimate,
    estimatorApplied: r.estimatorApplied,
    effectiveConcurrency: r.effectiveConcurrency,
    completed: s.saved,
    remaining: s.config.width - s.saved,
    lowerBound: r.lowerBound,
  });

const seedOf = (s: FanState, decision: RefusalDecision, refusal: FanRefusal): FanRefusalSeed =>
  Object.freeze({
    version: FAN_SEED_VERSION,
    estimator: s.config.estimator,
    samples: Object.freeze([...s.samples]),
    estimate: decision.estimate,
    ceilings: decision.ceilings,
    refusal,
  });
