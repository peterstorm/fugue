// map-fan-c1-equivalence — the FR-004 identity, pinned against a GOLDEN trace
// recorded from the pre-change sequential `runMappedFan` (AD-13, SC-001).
//
// What "identical" means here (AD-13): at effective concurrency 1, the
// observable FR-004 trace of the concurrent fan shell equals the sequential
// fan's byte for byte:
//   - dispatch order (index, execution epoch, child input),
//   - checkpoint `load` / `setMeta` / `saveNode` calls, their arguments and
//     their order relative to dispatch,
//   - the reducer's input (and whether it ran at all),
//   - the returned result, errors included verbatim.
// The fan observer events (`fan-start`, `fan-projection`, `fan-refused`) are
// additive and outside that trace. A budgeted fan whose projection breaches
// refuses EARLIER than the sequential fan did (US2 working as intended), so
// the budgeted fixtures here are within-budget ones only.
//
// The golden (`fixtures/fan-c1-golden.json`) was recorded from the pre-change
// sequential runner (`packages/framework/src/dag-runtime/run-mapped-fan.ts` at
// 53f5a578; byte-identical at the branch point bbb8e374 and at HEAD before
// the T10 rewrite). To re-record from that runner, extract it with its
// relative imports made absolute and point the recorder at it:
//
//   git show 53f5a578:packages/framework/src/dag-runtime/run-mapped-fan.ts \
//     | sed -e "s#\"\.\./#\"$PWD/packages/framework/src/#g" \
//           -e "s#\"\./#\"$PWD/packages/framework/src/dag-runtime/#g" \
//     > /tmp/fan-golden/run-mapped-fan.pre.ts
//   FAN_C1_GOLDEN_RECORD_FROM=/tmp/fan-golden/run-mapped-fan.pre.ts \
//     bun test packages/framework/src/__tests__/map-fan-c1-equivalence.test.ts
//
// Record mode writes the fixture and skips the comparisons; it is never the
// default. The recorder drives BOTH runners through the same scenario table
// and the same recording checkpointer, so a diff can only come from the
// runner under test.
//
// The second half of this file is the other side of the identity: the same
// fan at C > 1 is faster (SC-002, AS-002), measured on a fake clock.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { InMemoryCheckpointer, type Checkpointer, type SaveNodeOpts } from "../checkpoint/checkpointer.js";
import { defineDag } from "../executor/index.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createMapNode } from "../nodes/map.js";
import { compositeNodeKey } from "../shared/composite-node-key.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { runMappedFan } from "../dag-runtime/run-mapped-fan.js";
import type { ExecuteMappedChild, FanRuntime } from "../dag-runtime/execution-scope.js";
import type { MapNodeDef } from "../types/dag.js";
import { frameworkError } from "../types/error-factories.js";
import type { FrameworkError } from "../types/errors.js";
import { fanConcurrencyCap } from "../types/fan-scheduling.js";
import { DAG_INPUT, dagId, nodeId } from "../types/ids.js";
import type { TypedNodeContext } from "../types/node.js";
import { err, ok, type Result } from "../types/result.js";
import { freshnessExecutionEpoch, type FreshnessExecutionEpoch } from "../types/witness.js";
import {
  FAN,
  RUN,
  START_MS,
  callsCeiling,
  cost,
  fanHarness,
  okChild,
  quiesce,
  scriptedBudget,
  tokensCeiling,
  type ScriptedBudget,
} from "./fan-test-harness.js";

// ---------------------------------------------------------------------------
// The FR-004 trace
// ---------------------------------------------------------------------------

/** One observable step of a fan, in the order it happened. */
type TraceEntry =
  | Readonly<{ op: "load" }>
  | Readonly<{ op: "setMeta"; dagId: string; startedAt: string; nodeCount: number }>
  | Readonly<{ op: "dispatch"; index: number; epoch: number; input: unknown }>
  | Readonly<{ op: "saveNode"; key: string; output: unknown; completedAt: string }>
  | Readonly<{ op: "reduce"; input: readonly unknown[] }>;

/** A fan's whole FR-004 trace and its returned result. */
type Recording = Readonly<{ trace: readonly TraceEntry[]; result: Result<unknown, FrameworkError> }>;

type GoldenFile = Readonly<{
  recordedFrom: string;
  scenarios: Readonly<Record<string, Recording>>;
}>;

/** The sequential runner's signature: everything but the root-lent FanRuntime. */
type SequentialFanRunner = (
  node: MapNodeDef,
  input: unknown,
  ctx: TypedNodeContext<readonly ["checkpointer"]>,
  executionEpoch: FreshnessExecutionEpoch,
  executeChild: ExecuteMappedChild,
  now: () => number,
) => Promise<Result<unknown, FrameworkError>>;

// ---------------------------------------------------------------------------
// Scenarios — every path the sequential fan had
// ---------------------------------------------------------------------------

type ChildOutcome =
  | Readonly<{ kind: "ok"; value: unknown }>
  | Readonly<{ kind: "err"; error: FrameworkError }>;

type Reducer = "collect" | "reject" | "throw";

type CheckpointFault =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "fail-load" }>
  | Readonly<{ kind: "fail-set-meta" }>
  | Readonly<{ kind: "fail-save"; index: number }>
  | Readonly<{ kind: "corrupt"; nodeKey: string }>;

type Scenario = Readonly<{
  name: string;
  /** The fan's raw input; `{ items }` for every well-formed scenario. */
  input: unknown;
  epoch: number;
  /** Completions a previous run saved, as `[index, output, epoch]`. */
  presaved: readonly (readonly [number, unknown, number])[];
  child: (index: number) => ChildOutcome;
  /** Abort the run's signal while child `index` is executing. */
  abortDuring?: number;
  abortBeforeStart?: boolean;
  fault: CheckpointFault;
  reducer: Reducer;
}>;

const ITEMS = [3, 1, 4, 1, 5];
const tenfold = (i: number): ChildOutcome => ({ kind: "ok", value: i * 10 });
const failing = (at: number) => (i: number): ChildOutcome =>
  (i === at ? { kind: "err", error: frameworkError.rejected(nodeId("work"), `child ${i} refused its item`) } : tenfold(i));
const NO_FAULT: CheckpointFault = { kind: "none" };

const scenario = (s: Partial<Scenario> & Pick<Scenario, "name">): Scenario => ({
  input: { items: ITEMS }, epoch: 0, presaved: [], child: tenfold, fault: NO_FAULT, reducer: "collect", ...s,
});

const SCENARIOS: readonly Scenario[] = [
  scenario({ name: "fresh: every child succeeds and reduces in index order" }),
  scenario({ name: "fresh: a single-item fan", input: { items: [7] } }),
  scenario({ name: "fresh: an empty fan seeds metadata and reduces nothing", input: { items: [] } }),
  scenario({ name: "fresh: execution epoch 2 addresses every read and write", epoch: 2 }),
  scenario({
    name: "resume: this epoch's saved indices replay; another epoch's are ignored",
    presaved: [[1, 10, 0], [3, 30, 0], [2, 999, 1]],
  }),
  scenario({
    name: "resume: every index saved — nothing dispatches",
    presaved: [[0, 0, 0], [1, 10, 0], [2, 20, 0], [3, 30, 0], [4, 40, 0]],
  }),
  scenario({ name: "failure: a terminal child error stops the fan at that index", child: failing(2) }),
  scenario({ name: "failure: the first child fails", child: failing(0) }),
  scenario({
    name: "failure: a child output the child schema rejects is never saved",
    child: (i) => (i === 1 ? { kind: "ok", value: "not-a-number" } : tenfold(i)),
  }),
  scenario({
    name: "failure: a saved entry the child schema rejects stops the replay",
    presaved: [[1, "corrupted-shape", 0]],
  }),
  scenario({ name: "failure: a failed completion save stops the fan", fault: { kind: "fail-save", index: 1 } }),
  scenario({ name: "failure: a failed load dispatches nothing", fault: { kind: "fail-load" } }),
  scenario({ name: "failure: a failed metadata seed dispatches nothing", fault: { kind: "fail-set-meta" } }),
  scenario({ name: "failure: any corrupt entry refuses the whole fan", fault: { kind: "corrupt", nodeKey: "dag@fan@3@0" } }),
  scenario({ name: "failure: the width exceeds maxWidth", input: { items: Array.from({ length: 9 }, (_, i) => i) } }),
  scenario({ name: "failure: the input carries no width field", input: { other: [1] } }),
  scenario({ name: "abort: before the fan starts, nothing loads", abortBeforeStart: true }),
  scenario({ name: "abort: during child 1 — its save lands, nothing more starts", abortDuring: 1 }),
  scenario({ name: "abort: during the final child — the reducer never runs", abortDuring: 4 }),
  scenario({ name: "reducer: returns its own error", reducer: "reject" }),
  scenario({ name: "reducer: throws", reducer: "throw" }),
];

// ---------------------------------------------------------------------------
// One recorded run of a scenario
// ---------------------------------------------------------------------------

const childDag = defineDag({
  id: "child",
  nodes: { work: createFetchNode({ id: "work", inputSchema: z.number(), outputSchema: z.number(), fetch: async (n) => ok(n) }) },
  edges: [{ from: DAG_INPUT, to: "work" }],
  outputNodeId: "work",
});

const reducerOf = (reducer: Reducer, trace: TraceEntry[]) => (xs: readonly unknown[]): Result<unknown, FrameworkError> => {
  trace.push({ op: "reduce", input: [...xs] });
  if (reducer === "throw") throw new Error("reducer exploded");
  return reducer === "reject" ? err(frameworkError.rejected(FAN, "reducer refused the gather")) : ok([...xs]);
};

const fanNodeFor = (s: Scenario, trace: TraceEntry[], childConcurrency: number | undefined): MapNodeDef =>
  createMapNode<{ items: number[] }, unknown, unknown, "items">({
    id: "fan",
    inputSchema: z.object({ items: z.array(z.number()) }),
    outputSchema: z.unknown(),
    widthFrom: "items",
    maxWidth: 8,
    child: childDag,
    childOutputSchema: z.number(),
    reduce: reducerOf(s.reducer, trace),
    ...(childConcurrency !== undefined ? { childConcurrency } : {}),
  });

/** The port wrapped so every call lands in the trace, with the scenario's fault injected. */
const recordingCheckpointer = (delegate: Checkpointer, trace: TraceEntry[], fault: CheckpointFault): Checkpointer => ({
  load: async (id, opts) => {
    trace.push({ op: "load" });
    if (fault.kind === "fail-load") return err(frameworkError.cacheError("load", "checkpoint store unreachable"));
    const loaded = await delegate.load(id, opts);
    if (fault.kind !== "corrupt" || !loaded.ok || loaded.value === null) return loaded;
    return ok({ ...loaded.value, corruptNodeAddresses: [{ kind: "node-key", nodeKey: fault.nodeKey }] });
  },
  setMeta: async (id, meta) => {
    trace.push({ op: "setMeta", dagId: meta.dagId, startedAt: meta.startedAt.toISOString(), nodeCount: meta.nodeCount });
    return fault.kind === "fail-set-meta"
      ? err(frameworkError.cacheError("setMeta", "metadata write refused"))
      : delegate.setMeta(id, meta);
  },
  saveNode: async (id, state, opts?: SaveNodeOpts) => {
    const key = compositeNodeKey(state.nodeId, opts);
    trace.push({ op: "saveNode", key, output: state.output, completedAt: state.completedAt.toISOString() });
    const failing = fault.kind === "fail-save" && key === compositeNodeKey(FAN, { index: fault.index, attempt: opts?.attempt ?? 0 });
    return failing ? err(frameworkError.checkpointWriteFailed(RUN, FAN, "completion store full")) : delegate.saveNode(id, state, opts);
  },
});

/** Seed a store with a previous run's completions, as the sequential fan wrote them. */
const presaved = async (s: Scenario): Promise<InMemoryCheckpointer> => {
  const cp = new InMemoryCheckpointer({ now: () => START_MS });
  if (s.presaved.length === 0 && s.fault.kind !== "corrupt") return cp;
  const meta = await cp.setMeta(RUN, { dagId: dagId("outer"), startedAt: new Date(START_MS), nodeCount: 5 });
  if (!meta.ok) throw new Error("c1 equivalence: presave setMeta failed");
  for (const [index, output, epoch] of s.presaved) {
    const saved = await cp.saveNode(RUN, { nodeId: FAN, output, completedAt: new Date(START_MS) }, { index, attempt: epoch });
    if (!saved.ok) throw new Error(`c1 equivalence: presave of index ${index} failed`);
  }
  return cp;
};

/** How the runner under test is configured; the sequential runner ignores all of it. */
type Configuration = Readonly<{
  label: string;
  /** Authored `childConcurrency`; absent ⇒ the default of 1. */
  authored?: number;
  /** Host FAN_CHILD_CONCURRENCY_MAX. */
  cap: number;
  /** The run-wide budget the root lends the fan; absent ⇒ no budget capability. */
  budget?: () => ScriptedBudget;
}>;

/**
 * What `record` threads into a run besides the runner: the authored limit, the
 * charged budget, and whether each child yields a macrotask before settling
 * (so concurrent children are genuinely in flight together).
 */
type RunSetup = Readonly<{ authored?: number; budget?: ScriptedBudget; slowChildren?: boolean }>;

const record = async (runner: SequentialFanRunner, s: Scenario, setup: RunSetup): Promise<Recording> => {
  const trace: TraceEntry[] = [];
  const controller = new AbortController();
  if (s.abortBeforeStart === true) controller.abort();
  const { budget, authored, slowChildren } = setup;
  const checkpointer = recordingCheckpointer(await presaved(s), trace, s.fault);
  const ctx = makeNodeContext({
    runId: RUN, dagId: "outer", capabilities: { checkpointer }, signal: controller.signal,
  }) as unknown as TypedNodeContext<readonly ["checkpointer"]>;
  const executeChild: ExecuteMappedChild = async (input, scope) => {
    trace.push({ op: "dispatch", index: scope.index, epoch: scope.executionEpoch, input });
    if (s.abortDuring === scope.index) controller.abort();
    if (slowChildren === true) await new Promise<void>((resolve) => setImmediate(resolve));
    // Every child spends one call and ten tokens, well inside the budgeted fixtures.
    budget?.charge(cost({ calls: 1, tokens: 10 }));
    const outcome = s.child(scope.index);
    return outcome.kind === "ok" ? ok(outcome.value) : err(outcome.error);
  };
  const node = fanNodeFor(s, trace, authored);
  const result = await runner(node, s.input, ctx, freshnessExecutionEpoch(s.epoch), executeChild, () => START_MS);
  // The persisted shape: JSON is what the golden holds, and what "byte-identical" compares.
  return JSON.parse(JSON.stringify({ trace, result })) as Recording;
};

/**
 * Record the concurrent shell, configured, behind the sequential signature.
 * The budget is built ONCE and shared: the children charge the same run-wide
 * spend the root lends the fan to read.
 */
const recordConcurrent = async (s: Scenario, configuration: Configuration, slowChildren = false): Promise<Recording> => {
  const budget = configuration.budget?.();
  const fan: FanRuntime = Object.freeze({
    budget: budget?.capability ?? null,
    cap: fanConcurrencyCap(configuration.cap),
    logger: { warn: () => {}, error: () => {} },
    tagSpan: () => {},
  });
  const runner: SequentialFanRunner = (node, input, ctx, epoch, executeChild, now) =>
    runMappedFan(node, input, ctx, epoch, executeChild, fan, now);
  return record(runner, s, {
    ...(configuration.authored !== undefined ? { authored: configuration.authored } : {}),
    ...(budget !== undefined ? { budget } : {}),
    slowChildren,
  });
};

// ---------------------------------------------------------------------------
// Record mode (never the default)
// ---------------------------------------------------------------------------

const GOLDEN_PATH = join(__dirname, "fixtures", "fan-c1-golden.json");
const RECORD_FROM = process.env.FAN_C1_GOLDEN_RECORD_FROM;

describe.if(RECORD_FROM !== undefined)("record the golden from the pre-change sequential runner", () => {
  it("writes fixtures/fan-c1-golden.json", async () => {
    const pre = (await import(RECORD_FROM ?? "")) as { runMappedFan: SequentialFanRunner };
    const scenarios: Record<string, Recording> = {};
    for (const s of SCENARIOS) scenarios[s.name] = await record(pre.runMappedFan, s, {});
    const golden: GoldenFile = {
      recordedFrom: "packages/framework/src/dag-runtime/run-mapped-fan.ts @ 53f5a578 (pre-change sequential fan; byte-identical at branch point bbb8e374)",
      scenarios,
    };
    await Bun.write(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`);
  });
});

// ---------------------------------------------------------------------------
// The equivalence
// ---------------------------------------------------------------------------

const golden = (): GoldenFile => JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;

/** Every effective-concurrency-1 configuration the identity must hold for. */
const C1_CONFIGURATIONS: readonly Configuration[] = [
  { label: "no limit authored (default 1), default host cap 8", cap: 8 },
  { label: "childConcurrency 1 authored explicitly", authored: 1, cap: 8 },
  { label: "budgeted, within budget on every axis", cap: 8, budget: () => scriptedBudget([callsCeiling(1_000), tokensCeiling(1_000_000)]) },
  { label: "budget capability present but unbudgeted", cap: 8, budget: () => scriptedBudget(undefined) },
];

/** Host maximum 1 forces every fan sequential, whatever the author asked for (FR-031). */
const HOST_MAX_1: readonly Configuration[] = [
  { label: "host maximum 1, childConcurrency 4 authored", authored: 4, cap: 1 },
  { label: "host maximum 1, childConcurrency 64 authored, budgeted", authored: 64, cap: 1,
    budget: () => scriptedBudget([callsCeiling(1_000)]) },
];

describe.skipIf(RECORD_FROM !== undefined)("C=1 equivalence with the pre-change sequential fan (FR-004, SC-001)", () => {
  it("the golden covers exactly this file's scenario table", () => {
    expect(Object.keys(golden().scenarios).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  for (const configuration of C1_CONFIGURATIONS) {
    describe(configuration.label, () => {
      for (const s of SCENARIOS) {
        it(`AS-001: ${s.name}`, async () => {
          expect(await recordConcurrent(s, configuration)).toEqual(golden().scenarios[s.name] as Recording);
        });
      }
    });
  }

  for (const configuration of HOST_MAX_1) {
    describe(configuration.label, () => {
      for (const s of SCENARIOS) {
        it(`AS-028: ${s.name}`, async () => {
          expect(await recordConcurrent(s, configuration)).toEqual(golden().scenarios[s.name] as Recording);
        });
      }
    });
  }

  it("AS-001: the identity is not vacuous — at C=2 the same fan's trace differs from the sequential golden", async () => {
    const s = SCENARIOS[0] as Scenario;
    const sequential = golden().scenarios[s.name] as Recording;
    // Slow children still reproduce the golden at C=1: the comparison is timing-independent.
    expect(await recordConcurrent(s, { label: "C=1", cap: 8 }, true)).toEqual(sequential);
    const concurrent = await recordConcurrent(s, { label: "C=2", authored: 2, cap: 8 }, true);
    // Same outcome (index-ordered reduce), different dispatch/save interleaving.
    expect(concurrent.result).toEqual(sequential.result);
    expect(concurrent.trace).not.toEqual(sequential.trace);
    expect(concurrent.trace.filter((t) => t.op === "dispatch")).toEqual(sequential.trace.filter((t) => t.op === "dispatch"));
  });
});

// ---------------------------------------------------------------------------
// SC-002 / AS-002 — wall-clock on a fake clock
// ---------------------------------------------------------------------------

/** A seeded Fisher–Yates shuffle (mulberry32), so every "random" order is reproducible. */
const shuffled = <T>(xs: readonly T[], seed: number): T[] => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

/**
 * Run a fan whose every child takes exactly `latency` virtual ms. The fake
 * clock only moves when the fan is quiescent: it jumps to the earliest due
 * child, and every child due then settles (in a seeded order). The elapsed
 * virtual time is the fan's wall-clock.
 */
const runOnFakeClock = async (width: number, c: number, latency: number, seed: number) => {
  const h = fanHarness({ width, childConcurrency: c });
  const run = h.start();
  const due = new Map<number, number>();
  let clock = 0;
  for (;;) {
    await quiesce();
    if (h.returned) break;
    const open = h.openIndices();
    for (const i of open) if (!due.has(i)) due.set(i, clock + latency);
    clock = Math.min(...open.map((i) => due.get(i) ?? Number.POSITIVE_INFINITY));
    for (const i of shuffled(open.filter((i) => due.get(i) === clock), seed)) h.settle(i, okChild(i * 10));
  }
  return { result: await run, elapsed: clock, maxInFlight: h.maxInFlight, pendingAtReturn: h.pendingAtReturn };
};

describe("AS-002 / SC-002: concurrency C finishes in ceil(N/C) latencies (fake clock)", () => {
  const LATENCY = 1_000;
  for (const c of [2, 3, 8]) {
    for (const n of [1, c - 1, c, c + 1, 5 * c]) {
      it(`AS-002: N=${n}, C=${c} — wall-clock ≤ ceil(N/C) × L × 1.10 in every run`, async () => {
        const bound = Math.ceil(n / c) * LATENCY * 1.1;
        for (const seed of [1, 2, 3, 4, 5]) {
          const { result, elapsed, maxInFlight, pendingAtReturn } = await runOnFakeClock(n, c, LATENCY, seed);
          expect(result).toEqual(ok(Array.from({ length: n }, (_, i) => i * 10)));
          expect(elapsed).toBeLessThanOrEqual(bound);
          expect(maxInFlight).toBe(Math.min(n, c));
          expect(pendingAtReturn).toBe(0);
        }
      });
    }
  }

  it("AS-002: the sequential baseline is N × L — the speedup is real, not a clock artefact", async () => {
    const { elapsed } = await runOnFakeClock(10, 1, LATENCY, 1);
    expect(elapsed).toBe(10 * LATENCY);
    const concurrent = await runOnFakeClock(10, 4, LATENCY, 1);
    expect(concurrent.elapsed).toBe(3 * LATENCY);
  });
});
