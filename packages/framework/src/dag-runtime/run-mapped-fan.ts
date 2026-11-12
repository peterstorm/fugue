// run-mapped-fan — the durable map fan SHELL: a thin interpreter over the
// LC-1 fan machine (F1 PR-D, ADR-0090; supersedes ADR-0086's sequential
// "bounded v1" loop).
//
// The machine (`fan/fan-machine.ts`) DECIDES: which index starts next, the
// unprojected probe batch, projection before every later dispatch, the drain
// on failure / refusal / abort, the refusal seed, and the single outcome
// (index-ordered reduce, or one error by AD-6 precedence). This module only
// does the I/O around those decisions, in this order:
//   1. resolve the width; load the checkpoint ONCE and refuse the whole fan
//      on any corrupt entry before anything starts (FR-008);
//   2. read this epoch's refusal seed `fan-seed@<map>@0@<epoch>` from that
//      same load and parse it (a schema failure refuses the fan, naming it;
//      a reroute advances the epoch, so a prior epoch's seed is never read);
//   3. seed run metadata on a fresh run; collect this epoch's saved
//      completions `dag@<map>@<i>@<epoch>` as replays (FR-007);
//   4. resolve effective concurrency `min(authored, host cap)`, warn once on a
//      clamp, emit `fan-start`, tag the node span through the root-lent
//      `tagSpan` sink (FR-033, FR-060) — this module stays OTel-free;
//   5. interpret: execute every command, run ≤ C slot tasks as a bounded pool
//      over `Promise.race` (never `Promise.all`), and feed each settle back
//      with a fresh headroom snapshot. Abort is checked before the first start
//      decision and after every settle, and is fed to the machine BEFORE the
//      settle so a cancelled fan starts nothing more (FR-023);
//   6. on `persist-seed`, save the seed before returning — a failed seed save
//      returns its typed error (fail closed, like a child save) and logs the
//      fan's own error it displaces, child failures included; on `finish`,
//      reduce (only if the signal is still clear: today's final abort gate)
//      or return the error.
//
// A slot (`dispatchSlot`) is today's per-index body UNCHANGED — execute the
// child, parse with `childOutputSchema`, save under the index/epoch address —
// wrapped in the AD-3 spend window: `budget.spent()` before the child and
// after its save; the delta is the child's spend sample (an over-estimate
// under concurrency, exact at C = 1). Replayed indices spend nothing and
// produce no sample. A slot never rejects: a thrown child becomes a
// non-retriable `node-crash` for that index. Children keep their own node
// retry policy inside the same epoch (FR-009); the fan adds no retry.
//
// Shell invariants:
//   - INV-6: the fan never returns with a slot in flight. The machine reaches
//     done only at in-flight = 0, the shell asserts it, and a defect fence
//     drains every outstanding slot before turning any thrown error into a
//     `node-crash`. Paid-for work is never orphaned (AD-10).
//   - The shell mirrors the machine's in-flight set exactly: a slot starting
//     twice, a settle for an index the machine has not started, a finish with
//     slots outstanding, or a stall with nothing in flight is a contract
//     violation surfaced as a non-retriable `node-crash` — never ignored.
//   - At effective concurrency 1 the FR-004 trace — dispatch order,
//     checkpoint load / setMeta / saveNode calls and their order, reducer
//     input, and returned errors — is the sequential fan's (AD-13). The fan
//     observer events are additive and outside that trace.
//   - Budget is READ only, through the root-lent `FanRuntime` (FR-012). The
//     host per-call meter remains the independent hard stop (FR-019).

import { match } from "ts-pattern";
import type { Remaining } from "../types/budget-capability.js";
import type { MapNodeDef } from "../types/dag.js";
import { formatFrameworkError, type FrameworkError } from "../types/errors.js";
import { frameworkError } from "../types/error-factories.js";
import type { ObserverEvent } from "../types/events.js";
import {
  FAN_SEED_NAMESPACE,
  FanRefusalSeedSchema,
  type FanRefusalSeed,
  type FanScheduling,
} from "../types/fan-scheduling.js";
import type { NodeId } from "../types/ids.js";
import { resolveMappedItems } from "../types/map-width.js";
import { mapIndex, type MapIndex } from "../types/map-index.js";
import type { TypedNodeContext } from "../types/node.js";
import { err, ok, type Result } from "../types/result.js";
import { safeErrorMessage } from "../types/safe-error.js";
import { NO_SPEND, type Spend } from "../types/spend.js";
import type { FreshnessExecutionEpoch } from "../types/witness.js";
import { compositeNodeKey } from "../shared/composite-node-key.js";
import { bestEffort } from "./best-effort.js";
import { emit } from "./emit.js";
import type { ExecuteMappedChild, FanRuntime } from "./execution-scope.js";
import { effectiveConcurrency } from "./fan/effective-concurrency.js";
import {
  fanStep,
  initFan,
  type FanCommand,
  type FanEvent,
  type FanFinish,
  type FanState,
  type SlotOutcome,
} from "./fan/fan-machine.js";
import { spendDelta } from "./fan/spend-window.js";

/** Node-span attributes a fan sets at start (FR-060). */
export const FAN_SPAN_EFFECTIVE_CONCURRENCY = "fugue.fan.effective_concurrency";
export const FAN_SPAN_CLAMPED = "fugue.fan.clamped";
export const FAN_SPAN_SEEDED = "fugue.fan.seeded";

type FanContext = TypedNodeContext<readonly ["checkpointer"]>;
type FanResult = Result<unknown, FrameworkError>;
type StoredNodes = Readonly<Record<string, Readonly<{ output: unknown }>>>;
type Settled = Readonly<{ index: MapIndex; outcome: SlotOutcome }>;
type SlotPool = Map<number, Promise<Settled>>;

/** Everything one fan's slots and commands need, resolved once before the first start. */
type FanShell = Readonly<{
  node: MapNodeDef;
  ctx: FanContext;
  epoch: FreshnessExecutionEpoch;
  executeChild: ExecuteMappedChild;
  fan: FanRuntime;
  now: () => number;
  items: readonly unknown[];
  /** This epoch's saved completions, by index: the slots that replay. */
  replays: ReadonlyMap<number, unknown>;
}>;

const UNBUDGETED: Remaining = Object.freeze({ kind: "unbudgeted" });
const ABORT: FanEvent = Object.freeze({ type: "abort" });

const isAborted = (shell: FanShell): boolean => shell.ctx.signal?.aborted === true;
const spentNow = (shell: FanShell): Spend => shell.fan.budget?.spent() ?? NO_SPEND;
const admissionNow = (shell: FanShell): Remaining => shell.fan.budget?.remaining() ?? UNBUDGETED;

/** The address of index `index`'s completion in the current epoch (FR-007). */
const slotAddress = (index: MapIndex, epoch: FreshnessExecutionEpoch) => ({ index, attempt: epoch });
/** The address of the current epoch's refusal seed (AD-9, AD-11). */
const seedAddress = (epoch: FreshnessExecutionEpoch) => ({ namespace: FAN_SEED_NAMESPACE, index: 0, attempt: epoch });

/** A defect is never retried: the same code would fail the same way. */
const crash = (id: NodeId, what: string, cause: unknown): FrameworkError =>
  frameworkError.nodeCrash(id, `${what}: ${safeErrorMessage(cause)}`, { retriability: "non-retriable" });

const crashed = (id: NodeId, index: MapIndex, cause: unknown): FrameworkError =>
  crash(id, `fan index ${index} crashed`, cause);

/** A broken shell/machine contract: thrown, and turned into a typed crash by the defect fence. */
const contractViolation = (detail: string): never => {
  throw new Error(`fan shell contract violated: ${detail}`);
};

/** Emit a fan observer event; a hostile clock or observer never disturbs the fan. */
const emitFan = (shell: FanShell, build: (timestamp: Date) => ObserverEvent): void =>
  bestEffort("runMappedFan", "fan event emission", () => emit(shell.ctx, build(new Date(shell.now()))));

const fanIds = (shell: FanShell) => ({ runId: shell.ctx.runId, dagId: shell.ctx.dagId, nodeId: shell.node.id });

/** Concurrent durable fan shell. Child retry/finalization stays in the one kernel. */
export const runMappedFan = async (
  node: MapNodeDef,
  input: unknown,
  ctx: FanContext,
  executionEpoch: FreshnessExecutionEpoch,
  executeChild: ExecuteMappedChild,
  fan: FanRuntime,
  now: () => number,
): Promise<FanResult> => {
  if (ctx.signal?.aborted) return err(frameworkError.aborted("signal"));
  const { id, mapping } = node;
  const resolved = resolveMappedItems(id, input, mapping.widthFrom, mapping.maxWidth);
  if (!resolved.ok) return resolved;
  const { items, width } = resolved.value;
  // A failed load never means an empty checkpoint: that would repeat effects.
  const loaded = await ctx.checkpointer.load(ctx.runId);
  if (!loaded.ok) return loaded;
  // Refuse all corruption: an opaque digest cannot prove a dropped completion
  // belongs to another map/epoch. Backend warning-and-drop is not a safe miss.
  // A corrupt refusal SEED lands here too: the whole fan, 0 dispatches.
  if (loaded.value !== null && loaded.value.corruptNodeAddresses.length > 0) {
    return err(frameworkError.checkpointCorrupt(ctx.runId,
      `mapped fan cannot safely replay a checkpoint with corrupt entries: ${JSON.stringify(loaded.value.corruptNodeAddresses)}`, id));
  }
  const stored: StoredNodes = loaded.value?.nodes ?? {};
  const seed = seedOf(id, stored, executionEpoch);
  if (!seed.ok) return seed;
  if (loaded.value === null) {
    const seeded = await ctx.checkpointer.setMeta(ctx.runId, {
      dagId: ctx.dagId, startedAt: new Date(now()), nodeCount: width,
    });
    if (!seeded.ok) return seeded;
  }
  const shell: FanShell = Object.freeze({
    node, ctx, epoch: executionEpoch, executeChild, fan, now, items,
    replays: replaysOf(id, stored, width, executionEpoch),
  });
  return interpret(shell, announce(shell, mapping.scheduling, seed.value));
};

// ---------------------------------------------------------------------------
// Before the first start: seed, replays, fan-start
// ---------------------------------------------------------------------------

/** This epoch's refusal seed, if one was persisted. Unparseable ⇒ fail closed, naming the fan. */
const seedOf = (
  id: NodeId,
  stored: StoredNodes,
  epoch: FreshnessExecutionEpoch,
): Result<FanRefusalSeed | null, FrameworkError> => {
  const key = compositeNodeKey(id, seedAddress(epoch));
  const entry = Object.hasOwn(stored, key) ? stored[key] : undefined;
  if (entry === undefined) return ok(null);
  const parsed = FanRefusalSeedSchema.safeParse(entry.output);
  return parsed.success
    ? ok(parsed.data)
    : err(frameworkError.validation(id,
      `map '${id}' refusal seed for execution epoch ${epoch} is unreadable: ${parsed.error.message}`));
};

/** Saved completions of the CURRENT epoch, by index. Reads and writes share one epoch. */
const replaysOf = (
  id: NodeId,
  stored: StoredNodes,
  width: number,
  epoch: FreshnessExecutionEpoch,
): ReadonlyMap<number, unknown> => {
  const hits = new Map<number, unknown>();
  for (let i = 0; i < width; i += 1) {
    const key = compositeNodeKey(id, slotAddress(mapIndex(i), epoch));
    const hit = Object.hasOwn(stored, key) ? stored[key] : undefined;
    if (hit !== undefined) hits.set(i, hit.output);
  }
  return hits;
};

/** Resolve effective concurrency, report it (warn on clamp, event, span), and build the machine. */
const announce = (shell: FanShell, scheduling: FanScheduling, seed: FanRefusalSeed | null): FanState => {
  const { childConcurrency: authored, estimator } = scheduling;
  const { cap, logger } = shell.fan;
  const { effective, clamped } = effectiveConcurrency(authored, cap);
  const id = shell.node.id;
  if (clamped) {
    bestEffort("runMappedFan", "clamp warning", () => logger.warn(
      `map '${id}': childConcurrency ${authored} exceeds the host maximum FAN_CHILD_CONCURRENCY_MAX=${cap}; clamped to ${effective}`));
  }
  bestEffort("runMappedFan", "fan span attributes", () => shell.fan.tagSpan({
    [FAN_SPAN_EFFECTIVE_CONCURRENCY]: effective,
    [FAN_SPAN_CLAMPED]: clamped,
    [FAN_SPAN_SEEDED]: seed !== null,
  }));
  emitFan(shell, (timestamp) => ({
    type: "fan-start", ...fanIds(shell), width: shell.items.length, replayed: shell.replays.size,
    seeded: seed !== null, authored, cap, effective, clamped, estimator, timestamp,
  }));
  return initFan({
    nodeId: id, width: shell.items.length, replayedIndices: new Set(shell.replays.keys()),
    effective, estimator, seed,
  });
};

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

/** Await every outstanding slot. Slots never reject, so this always completes. */
const drainPool = async (pool: SlotPool): Promise<void> => {
  while (pool.size > 0) {
    const settled = await Promise.race(pool.values());
    pool.delete(settled.index);
  }
};

/** Run the machine to its finish behind a defect fence that never orphans a slot (INV-6). */
const interpret = async (shell: FanShell, init: FanState): Promise<FanResult> => {
  const pool: SlotPool = new Map();
  try {
    return await loop(shell, init, pool);
  } catch (cause) {
    await drainPool(pool);
    return err(crash(shell.node.id, "fan interpreter failed", cause));
  }
};

const loop = async (shell: FanShell, init: FanState, pool: SlotPool): Promise<FanResult> => {
  let state = init;
  let events: readonly FanEvent[] = [isAborted(shell) ? ABORT : { type: "start", admission: admissionNow(shell) }];
  for (;;) {
    for (const event of events) {
      const step = fanStep(state, event);
      state = step.state;
      const finished = await perform(shell, step.commands, pool);
      if (finished !== null) {
        if (pool.size > 0) contractViolation(`fan finished with ${pool.size} slot(s) in flight`);
        return finished;
      }
    }
    if (pool.size === 0) contractViolation("fan stalled: nothing in flight and no finish");
    const settled = await Promise.race(pool.values());
    pool.delete(settled.index);
    if (!state.inFlight.has(settled.index)) contractViolation(`settle for index ${settled.index}, which is not in flight`);
    // Abort first: a cancelled fan must not refill the slot this settle frees.
    const settle: FanEvent = { type: "slot-settled", index: settled.index, outcome: settled.outcome, admission: admissionNow(shell) };
    events = isAborted(shell) ? [ABORT, settle] : [settle];
  }
};

/** Execute one step's commands in order; a non-null result is the fan's final result. */
const perform = async (shell: FanShell, step: readonly FanCommand[], pool: SlotPool): Promise<FanResult | null> => {
  for (const command of step) {
    const finished = await performOne(shell, command, step, pool);
    if (finished !== null) return finished;
  }
  return null;
};

/**
 * The error this step's `finish` returns: what a failed seed save displaces.
 * The machine emits `persist-seed` only in a step that ends with a failing
 * `finish` (FR-026); anything else is a broken contract.
 */
const displacedBy = (step: readonly FanCommand[]): FrameworkError => {
  const last = step.at(-1);
  return last?.type === "finish" && last.finish.kind === "fail"
    ? last.finish.error
    : contractViolation("persist-seed in a step that does not finish with an error");
};

const performOne = (
  shell: FanShell,
  command: FanCommand,
  step: readonly FanCommand[],
  pool: SlotPool,
): Promise<FanResult | null> =>
  match(command)
    .returnType<Promise<FanResult | null>>()
    .with({ type: "replay" }, async ({ index }) => occupy(shell, pool, index, () => replaySlot(shell, index)))
    .with({ type: "dispatch" }, async ({ index }) => occupy(shell, pool, index, () => dispatchSlot(shell, index)))
    .with({ type: "emit-projection" }, async ({ record }) => {
      emitFan(shell, (timestamp) => ({ type: "fan-projection", ...fanIds(shell), ...record, timestamp }));
      return null;
    })
    .with({ type: "emit-refused" }, async ({ refusal, sticky, attachedToChildFailure }) => {
      emitFan(shell, (timestamp) => ({
        type: "fan-refused", ...fanIds(shell), refusal, sticky, attachedToChildFailure, timestamp,
      }));
      return null;
    })
    .with({ type: "persist-seed" }, ({ seed }) => persistSeed(shell, seed, displacedBy(step)))
    .with({ type: "finish" }, async ({ finish }) => conclude(shell, finish))
    .exhaustive();

/** Start a slot task for `index`; the pool mirrors the machine's in-flight set exactly. */
const occupy = (shell: FanShell, pool: SlotPool, index: MapIndex, slot: () => Promise<SlotOutcome>): null => {
  if (pool.has(index)) contractViolation(`index ${index} started while already in flight`);
  pool.set(index, slot()
    .catch((cause: unknown): SlotOutcome => ({ kind: "failed", error: crashed(shell.node.id, index, cause) }))
    .then((outcome) => Object.freeze({ index, outcome })));
  return null;
};

/**
 * Save the refusal seed before the fan returns; a failed save is the fan's
 * error (fail closed), and `displaced` — the fan's own error — is logged whole.
 */
const persistSeed = async (shell: FanShell, seed: FanRefusalSeed, displaced: FrameworkError): Promise<FanResult | null> => {
  const { node, ctx } = shell;
  const saved = await ctx.checkpointer.saveNode(ctx.runId,
    { nodeId: node.id, output: seed, completedAt: new Date(shell.now()) }, seedAddress(shell.epoch));
  if (saved.ok) return null;
  // The write error replaces the fan's own outcome: the refusal AND every
  // child failure drained with it (FR-025). Without this line the operator
  // would see only a checkpoint failure, and the child failures nowhere.
  bestEffort("runMappedFan", "seed-save failure log", () => shell.fan.logger.error(
    `map fan "${node.id}": refusal seed save failed; returning the checkpoint write error in place of the ` +
    `fan's own error, which it displaces: ${formatFrameworkError(displaced)}`,
  ));
  return saved;
};

const conclude = (shell: FanShell, finish: FanFinish): FanResult =>
  match(finish)
    .returnType<FanResult>()
    .with({ kind: "fail" }, ({ error }) => err(error))
    // An operation may complete while its signal is being cancelled: its save
    // is kept, but a cancelled fan never reports a new success (final gate).
    .with({ kind: "reduce" }, ({ ordered }) => (isAborted(shell) ? err(frameworkError.aborted("signal")) : reduce(shell.node, ordered)))
    .exhaustive();

const reduce = (node: MapNodeDef, ordered: readonly unknown[]): FanResult => {
  try {
    return node.mapping.reduce(ordered);
  } catch (cause) {
    return err(crash(node.id, "map reducer threw", cause));
  }
};

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** A saved completion of this epoch, re-adapted through the map schema exactly once. */
const replaySlot = async (shell: FanShell, index: MapIndex): Promise<SlotOutcome> => {
  const { id, mapping } = shell.node;
  const replayed = mapping.childOutputSchema.safeParse(shell.replays.get(index));
  return replayed.success
    ? { kind: "replayed", value: replayed.data }
    : { kind: "failed", error: frameworkError.validation(id,
      `checkpoint replay rejected for fan index ${index}: ${replayed.error.message}`) };
};

/** Today's per-index body inside the AD-3 spend window. */
const dispatchSlot = async (shell: FanShell, index: MapIndex): Promise<SlotOutcome> => {
  const before = spentNow(shell);
  const result = await childBody(shell, index)
    .catch((cause: unknown): FanResult => err(crashed(shell.node.id, index, cause)));
  const sample = spendDelta(before, spentNow(shell));
  return result.ok
    ? { kind: "completed", value: result.value, sample }
    : { kind: "failed", error: result.error, sample };
};

const childBody = async (shell: FanShell, index: MapIndex): Promise<FanResult> => {
  const { node: { id, mapping }, ctx } = shell;
  const scope = Object.freeze({ mapNodeId: id, index, executionEpoch: shell.epoch });
  const child = await shell.executeChild(shell.items[index], scope);
  if (!child.ok) return child;
  const parsed = mapping.childOutputSchema.safeParse(child.value);
  if (!parsed.success) return err(frameworkError.validation(id,
    `fan index ${index} produced an output the child schema rejects: ${parsed.error.message}`));
  // Persist the child DAG result, not the map-level adapted value. Replay
  // passes this same domain through childOutputSchema exactly once.
  const saved = await ctx.checkpointer.saveNode(ctx.runId,
    { nodeId: id, output: child.value, completedAt: new Date(shell.now()) },
    slotAddress(scope.index, scope.executionEpoch));
  if (!saved.ok) return saved;
  return ok(parsed.data);
};
