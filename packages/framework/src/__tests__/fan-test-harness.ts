// fan-test-harness — a deterministic, timer-free driver for the fan shell
// (`runMappedFan`, F1 PR-D T10).
//
// What it controls, and why:
//   - CHILDREN are manually resolved deferreds. A test decides exactly which
//     in-flight child settles next (`settle`), so any completion order — and
//     any interleaving with the shell's own checkpoint I/O — is reproducible.
//     `auto` resolves each child as soon as it is dispatched, for backends
//     whose I/O is not microtask-only (the file checkpointer).
//   - SPEND is a scripted run-wide `Spend` with MUTABLE ceilings: a child's
//     plan charges its spend to the run just before it resolves, exactly as
//     the host meter settles a call, and `redeploy` swaps the ceilings to
//     simulate a budget-raising redeploy between runs. `meter: true` puts the
//     host per-call meter in front of every child's spend (FR-019): a call
//     that would cross a ceiling is refused with `llm-budget-exceeded` and
//     charges nothing.
//   - SLOTS are tracked from dispatch until the shell is done with them
//     (child failure, output the child schema rejects, or the save of its
//     completion settling). `maxInFlight` is therefore a lower bound of the
//     machine's in-flight count, and `pendingAtReturn` counts slots still
//     outstanding when `runMappedFan` resolved — the INV-6 witness: it must
//     be 0 on every return path.
//   - `quiesce` yields macrotasks, so every microtask the shell queued has
//     run. The in-memory checkpointer is microtask-only, so a quiesced fan is
//     waiting on nothing but the children the test has not yet settled.

import { z } from "zod";
import { InMemoryCheckpointer, type Checkpointer, type SaveNodeOpts } from "../checkpoint/checkpointer.js";
import { defineDag } from "../executor/index.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createMapNode } from "../nodes/map.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { compositeNodeKey } from "../shared/composite-node-key.js";
import { runMappedFan } from "../dag-runtime/run-mapped-fan.js";
import type { ExecuteMappedChild, FanRuntime } from "../dag-runtime/execution-scope.js";
import { remainingFor, type BudgetCapability } from "../types/budget-capability.js";
import { ceilings, type Breach, type Ceiling } from "../types/budget.js";
import type { FrameworkError } from "../types/errors.js";
import type { ObserverEvent } from "../types/events.js";
import { fanConcurrencyCap, type FanEstimator, type FanRefusal } from "../types/fan-scheduling.js";
import { DAG_INPUT, dagId, nodeId, runId as toRunId } from "../types/ids.js";
import type { MappedChildScope } from "../types/mapped-child-scope.js";
import type { MapNodeDef } from "../types/dag.js";
import type { TypedNodeContext } from "../types/node.js";
import { err, ok, type Result } from "../types/result.js";
import { addSpend, costFloor, makeSpend, microUsd, NO_SPEND, type Spend } from "../types/spend.js";
import { freshnessExecutionEpoch } from "../types/witness.js";

export const FAN = nodeId("fan");
export const WORK = nodeId("work");
export const RUN = toRunId("fan-harness");
export const START_MS = Date.UTC(2026, 0, 1);

// ---------------------------------------------------------------------------
// Spend and ceilings
// ---------------------------------------------------------------------------

/** One child's spend on the axes a test cares about; everything else is zero. */
export const cost = (c: Readonly<{ calls?: number; tokens?: number; micros?: number }>): Spend =>
  makeSpend({
    usage: "known",
    tokens: c.tokens ?? 0,
    calls: c.calls ?? 0,
    usd: { kind: "priced", micros: microUsd(c.micros ?? 0) },
  });

export const callsCeiling = (limit: number): Ceiling => ({ kind: "calls", limit });
export const tokensCeiling = (limit: number): Ceiling => ({ kind: "tokens", limit });

const axisOf = (s: Spend, c: Ceiling): number =>
  c.kind === "tokens" ? s.tokens : c.kind === "calls" ? s.calls : costFloor(s.usd);

const breachAt = (c: Ceiling, observed: number): Breach =>
  c.kind === "usd"
    ? { kind: "reached", ceiling: c, basis: "projected", observed: microUsd(observed) }
    : { kind: "reached", ceiling: c, basis: "projected", observed };

/** A run-wide spend authority with a scripted timeline and mutable ceilings. */
export type ScriptedBudget = Readonly<{
  capability: BudgetCapability;
  spent: () => Spend;
  charge: (s: Spend) => void;
  /** Swap the ceilings in force — a redeploy (`undefined` ⇒ unbudgeted). */
  redeploy: (next: readonly Ceiling[] | undefined) => void;
  /** The host per-call meter (FR-019): the ceiling `s` would cross, if any. */
  meter: (s: Spend) => Breach | undefined;
}>;

export const scriptedBudget = (initial: readonly Ceiling[] | undefined, start: Spend = NO_SPEND): ScriptedBudget => {
  let limits = initial === undefined ? undefined : ceilings(initial);
  let spent = start;
  return Object.freeze({
    capability: Object.freeze({ spent: () => spent, remaining: () => remainingFor(limits, spent) }),
    spent: () => spent,
    charge: (s: Spend) => { spent = addSpend(spent, s); },
    redeploy: (next: readonly Ceiling[] | undefined) => { limits = next === undefined ? undefined : ceilings(next); },
    meter: (s: Spend) => {
      const after = addSpend(spent, s);
      const crossed = (limits ?? []).find((c) => axisOf(after, c) > c.limit);
      return crossed === undefined ? undefined : breachAt(crossed, axisOf(after, crossed));
    },
  });
};

// ---------------------------------------------------------------------------
// Child plans
// ---------------------------------------------------------------------------

/** How one dispatched child settles. */
export type ChildPlan =
  | Readonly<{ kind: "ok"; value: unknown; spend?: Spend }>
  | Readonly<{ kind: "err"; error: FrameworkError; spend?: Spend }>
  | Readonly<{ kind: "crash"; cause: unknown }>;

export const okChild = (value: unknown, spend?: Spend): ChildPlan =>
  spend === undefined ? { kind: "ok", value } : { kind: "ok", value, spend };
export const failChild = (error: FrameworkError, spend?: Spend): ChildPlan =>
  spend === undefined ? { kind: "err", error } : { kind: "err", error, spend };
export const crashChild = (cause: unknown): ChildPlan => ({ kind: "crash", cause });

/** A typed terminal child failure, attributable by its message. */
export const childError = (index: number): FrameworkError =>
  ({ kind: "rejected", nodeId: WORK, reason: `child ${index} failed` });

/** Child `i` succeeds with `i × 10`: the plan whose reduce is `range(width)`. */
export const tenfold = (i: number): ChildPlan => okChild(i * 10);

// ---------------------------------------------------------------------------
// Expected results
// ---------------------------------------------------------------------------

/** `[f(0), …, f(n − 1)]`; by default the reduce of a fan whose children are all `tenfold`. */
export const range = (n: number, f: (i: number) => number = (i) => i * 10): number[] =>
  Array.from({ length: n }, (_, i) => f(i));

/** The error a fan returned; a success fails the test, naming the value. */
export const errorOf = (r: Result<unknown, FrameworkError>): FrameworkError => {
  if (r.ok) throw new Error(`expected an error, got ok(${JSON.stringify(r.value)})`);
  return r.error;
};

/** The refusal a fan returned; any other outcome fails the test, naming its kind. */
export const refusalOf = (r: Result<unknown, FrameworkError>): FanRefusal => {
  const error = errorOf(r);
  if (error.kind !== "fan-budget-refused") throw new Error(`expected fan-budget-refused, got ${error.kind}`);
  return error.refusal;
};

// ---------------------------------------------------------------------------
// The fan under test
// ---------------------------------------------------------------------------

/** The one child every harness fan maps: `work` echoes its numeric item. */
export const childDag = defineDag({
  id: "child",
  nodes: { work: createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), fetch: async (n) => ok(n) }) },
  edges: [{ from: DAG_INPUT, to: "work" }],
  outputNodeId: "work",
});

/** A map node whose reducer records every input it is handed. */
export const fanNode = (
  reductions: unknown[][],
  scheduling: Readonly<{ childConcurrency?: number; estimator?: FanEstimator }> = {},
): MapNodeDef =>
  createMapNode<{ items: number[] }, unknown, unknown, "items">({
    id: "fan",
    inputSchema: z.object({ items: z.array(z.number()) }),
    outputSchema: z.array(z.number()),
    widthFrom: "items",
    maxWidth: 64,
    child: childDag,
    childOutputSchema: z.number(),
    reduce: (xs: readonly unknown[]) => { reductions.push([...xs]); return ok([...xs]); },
    ...scheduling,
  });

export type FanHarnessOptions = Readonly<{
  width: number;
  childConcurrency?: number;
  estimator?: FanEstimator;
  /** Host FAN_CHILD_CONCURRENCY_MAX; default 8. */
  cap?: number;
  /** Absent ⇒ no budget capability at all (`null`). */
  budget?: ScriptedBudget;
  /** Gate every child's spend through the host per-call meter. */
  meter?: boolean;
  checkpointer?: Checkpointer;
  epoch?: number;
  /** Resolve each child as soon as it is dispatched. */
  auto?: (index: number) => ChildPlan;
  /** Fail a save the predicate selects, with the returned error. */
  failSave?: (key: string) => FrameworkError | undefined;
}>;

/** Yield macrotasks: every microtask the shell queued has run afterwards. */
export const quiesce = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Wrap a checkpointer so every port call lands in `trace`, optionally failing chosen saves. */
const recordingCheckpointer = (
  delegate: Checkpointer,
  trace: string[],
  onSaved: (key: string) => void,
  failSave: FanHarnessOptions["failSave"],
): Checkpointer => ({
  load: (id, opts) => { trace.push("load"); return delegate.load(id, opts); },
  setMeta: (id, meta) => { trace.push("setMeta"); return delegate.setMeta(id, meta); },
  saveNode: async (id, state, opts?: SaveNodeOpts) => {
    const key = compositeNodeKey(state.nodeId, opts);
    trace.push(`save:${key}`);
    const injected = failSave?.(key);
    const result = injected === undefined ? await delegate.saveNode(id, state, opts) : err(injected);
    onSaved(key);
    return result;
  },
});

type Deferred = Readonly<{
  promise: Promise<Result<unknown, FrameworkError>>;
  resolve: (r: Result<unknown, FrameworkError>) => void;
  reject: (cause: unknown) => void;
}>;

const deferredChild = (): Deferred => {
  let resolve: Deferred["resolve"] = () => {};
  let reject: Deferred["reject"] = () => {};
  const promise = new Promise<Result<unknown, FrameworkError>>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// The children of one fan: manually resolved deferreds plus the slot
// occupancy the INV-6 witness and the FR-003 bound are read from.
const childControl = (o: FanHarnessOptions, trace: string[]) => {
  const open = new Map<number, Deferred>();
  const occupied = new Set<number>();
  const dispatched: number[] = [];
  const scopes: MappedChildScope[] = [];
  const stats = { maxInFlight: 0, meterChecks: 0 };
  const release = (i: number): void => { occupied.delete(i); };

  // The host per-call meter's verdict on a child's spend, when the harness meters (FR-019).
  const metered = (spend: Spend): Breach | undefined => {
    if (o.meter !== true || o.budget === undefined) return undefined;
    stats.meterChecks += 1;
    return o.budget.meter(spend);
  };

  const settle = (i: number, plan: ChildPlan): void => {
    const deferred = open.get(i);
    if (deferred === undefined) throw new Error(`fan harness: child ${i} is not in flight`);
    open.delete(i);
    trace.push(`settle:${i}`);
    if (plan.kind === "crash") { release(i); deferred.reject(plan.cause); return; }
    const breach = plan.spend === undefined ? undefined : metered(plan.spend);
    if (breach !== undefined) {
      release(i);
      deferred.resolve(err({ kind: "llm-budget-exceeded", runId: RUN, nodeId: WORK, cause: breach }));
      return;
    }
    if (plan.spend !== undefined) o.budget?.charge(plan.spend);
    if (plan.kind === "err") { release(i); deferred.resolve(err(plan.error)); return; }
    // An output the child schema rejects is never saved: the slot ends at the child.
    if (typeof plan.value !== "number") release(i);
    deferred.resolve(ok(plan.value));
  };

  const executeChild: ExecuteMappedChild = (_input, scope) => {
    const i = scope.index;
    trace.push(`dispatch:${i}`);
    dispatched.push(i);
    scopes.push(scope);
    occupied.add(i);
    stats.maxInFlight = Math.max(stats.maxInFlight, occupied.size);
    const deferred = deferredChild();
    open.set(i, deferred);
    const auto = o.auto;
    if (auto !== undefined) queueMicrotask(() => settle(i, auto(i)));
    return deferred.promise;
  };

  return { open, occupied, dispatched, scopes, stats, release, settle, executeChild };
};

export type FanHarness = ReturnType<typeof fanHarness>;

type FanSinks = Readonly<{
  warnings: string[];
  errors: string[];
  spanAttributes: Record<string, number | boolean>;
}>;

const fanRuntimeFor = (o: FanHarnessOptions, sinks: FanSinks): FanRuntime =>
  Object.freeze({
    budget: o.budget?.capability ?? null,
    cap: fanConcurrencyCap(o.cap ?? 8),
    logger: {
      warn: (m: string) => { sinks.warnings.push(m); },
      error: (m: string) => { sinks.errors.push(m); },
    },
    tagSpan: (attributes) => { Object.assign(sinks.spanAttributes, attributes); },
  });

const harnessContext = (
  checkpointer: Checkpointer,
  events: ObserverEvent[],
  signal: AbortSignal,
): TypedNodeContext<readonly ["checkpointer"]> =>
  makeNodeContext({
    runId: RUN,
    dagId: dagId("outer"),
    capabilities: { checkpointer },
    observer: { observe: (e) => { events.push(e); } },
    signal,
  }) as unknown as TypedNodeContext<readonly ["checkpointer"]>;

export const fanHarness = (o: FanHarnessOptions) => {
  const checkpointer = o.checkpointer ?? new InMemoryCheckpointer();
  const epoch = freshnessExecutionEpoch(o.epoch ?? 0);
  const trace: string[] = [];
  const events: ObserverEvent[] = [];
  const sinks: FanSinks = { warnings: [], errors: [], spanAttributes: {} };
  const reductions: unknown[][] = [];
  const children = childControl(o, trace);
  const outcome = { pendingAtReturn: -1, returned: false };
  const controller = new AbortController();
  const slotKey = (i: number): string => compositeNodeKey(FAN, { index: i, attempt: epoch });
  // A completion's slot ends when its save settles (success or failure).
  const recorded = recordingCheckpointer(checkpointer, trace, (key) => {
    for (const i of children.occupied) if (slotKey(i) === key) children.release(i);
  }, o.failSave);
  const ctx = harnessContext(recorded, events, controller.signal);
  const fan = fanRuntimeFor(o, sinks);
  const node = fanNode(reductions, {
    ...(o.childConcurrency !== undefined ? { childConcurrency: o.childConcurrency } : {}),
    ...(o.estimator !== undefined ? { estimator: o.estimator } : {}),
  });

  /** Start the fan over items `0..width-1`; the promise resolves when `runMappedFan` returns. */
  const start = (items: readonly number[] = Array.from({ length: o.width }, (_, i) => i)) =>
    runMappedFan(node, { items }, ctx, epoch, children.executeChild, fan, () => START_MS).then((result) => {
      outcome.returned = true;
      outcome.pendingAtReturn = children.occupied.size + children.open.size;
      trace.push("return");
      return result;
    });

  return {
    checkpointer, trace, events, reductions, start,
    warnings: sinks.warnings,
    errors: sinks.errors,
    spanAttributes: sinks.spanAttributes,
    dispatched: children.dispatched,
    scopes: children.scopes,
    settle: children.settle,
    abort: () => controller.abort(),
    /** Indices dispatched whose child the test has not yet settled, ascending. */
    openIndices: (): number[] => [...children.open.keys()].sort((a, b) => a - b),
    get maxInFlight(): number { return children.stats.maxInFlight; },
    get meterChecks(): number { return children.stats.meterChecks; },
    get pendingAtReturn(): number { return outcome.pendingAtReturn; },
    get returned(): boolean { return outcome.returned; },
    eventsOf: <T extends ObserverEvent["type"]>(type: T): Extract<ObserverEvent, { type: T }>[] =>
      events.filter((e): e is Extract<ObserverEvent, { type: T }> => e.type === type),
  };
};

/**
 * Drive a started fan to completion: whenever it is quiescent, settle the
 * in-flight child `choose` picks with the plan `planOf` gives it.
 */
export const drive = async (
  h: FanHarness,
  run: Promise<Result<unknown, FrameworkError>>,
  planOf: (index: number) => ChildPlan,
  choose: (open: readonly number[]) => number = (open) => open[0] ?? -1,
): Promise<Result<unknown, FrameworkError>> => {
  for (;;) {
    await quiesce();
    if (h.returned) return run;
    const open = h.openIndices();
    if (open.length === 0) throw new Error("fan harness: fan is stalled with no child in flight");
    const i = choose(open);
    h.settle(i, planOf(i));
  }
};

/**
 * Pre-save completions for `indices` under `epoch`, as a previous run of the
 * fan would have — run metadata first, since a run without it loads as null.
 */
export const presave = async (
  cp: Checkpointer,
  indices: readonly number[],
  value: (i: number) => unknown,
  epoch = 0,
): Promise<void> => {
  const meta = await cp.setMeta(RUN, { dagId: dagId("outer"), startedAt: new Date(START_MS), nodeCount: indices.length });
  if (!meta.ok) throw new Error("fan harness: presave setMeta failed");
  for (const i of indices) {
    const saved = await cp.saveNode(RUN, { nodeId: FAN, output: value(i), completedAt: new Date(START_MS) },
      { index: i, attempt: epoch });
    if (!saved.ok) throw new Error(`fan harness: presave of index ${i} failed`);
  }
};
