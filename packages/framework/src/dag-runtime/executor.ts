// buildDagExecutor — DAG executor closure
// Orchestrates wave execution, retry backoff with jitter, and human-review hook dispatch.
// Returns an Executor<DagPhase, DagEvent, DagMachineContext> that runs one wave per call.
//
// Requirement → ADR cross-reference:
//   FR-005  → ADR-0003 (event sourcing, checkpoint after every transition)
//   FR-006  → ADR-0005 (retry layering, classify executor errors)
//   FR-007  → ADR-0005 (throw on terminal-failed for queue retry)
//   FR-011  → ADR-0005 (per-invocation retry counters)
//   FR-012  → ADR-0006 (joblike minimal write side, beforeExecute hook)
//   FR-021  → ADR-0021 (single-path runtime, pure transitions)
//   FR-026–033 → ADR-0013, ADR-0015, ADR-0029 (HITL, conditional edges, routing)
//   FR-027  → ADR-0005 (retry backoff with jitter)
//   FR-029a → ADR-0013 (onHumanReview hook crash retry)

import { match } from "ts-pattern";
import type { Executor } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef, NodeContext, ValidatedNodeContext } from "../types/node.js";
import type { MintingAuthority } from "../types/capability-broker.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, DagId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { emit } from "./emit.js";
import { applyJitter } from "../shared/jitter.js";
import { fwLogger } from "../logger.js";
import { emitHumanIntervention } from "./human-emission.js";
import { executeWave, type WaveConfig } from "./wave-execution.js";
import { enrichHumanRespondedEvent, type UnenrichedDagEvent } from "./reroute.js";
import type { Witness } from "../types/freshness.js";
import { type FreshnessIndex, InMemoryFreshnessIndex } from "./freshness-check.js";
import { type NodeSpanOutcome } from "./node-span.js";

// ---------------------------------------------------------------------------
// Backoff + jitter
// ---------------------------------------------------------------------------

const DEFAULT_JITTER_RATIO = 0.2;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// ---------------------------------------------------------------------------
// approve-with-edit validation
//
// Returns `null` on success, an error message on failure. Validation runs in
// the imperative shell because the pure transition layer can't depend on a
// live Zod schema (on resume, deserialized schemas are inert).
// ---------------------------------------------------------------------------

const validateApproveEdit = (
  action: import("./types.js").HumanAction,
  nodeId: NodeId,
  nodeMap: Map<NodeId, NodeDef<unknown, unknown>>,
): string | null => {
  if (action.kind !== "approve-with-edit") return null;
  const nodeDef = nodeMap.get(nodeId);
  if (!nodeDef) {
    return `approve-with-edit: node '${nodeId}' not found in DAG`;
  }
  const parsed = nodeDef.outputSchema.safeParse(action.newOutput);
  if (!parsed.success) {
    return `approve-with-edit output failed schema for node '${nodeId}': ${parsed.error.message}`;
  }
  return null;
};

/**
 * Shared body of the `awaiting-human` and `retrying-hook` executor branches.
 * Both paths: check for a wired hook, invoke it, catch exceptions into a
 * `node-failed`, validate `approve-with-edit` output against the node schema,
 * and finally emit `human-responded`. Only the retrying-hook branch prepends
 * a sleep — that lives at the call site.
 */
const callHumanReviewHook = async (
  phaseKind: "awaiting-human" | "retrying-hook" | "suspended",
  nodeId: NodeId,
  output: unknown,
  prompt: string,
  hooks: {
    onHumanReview?: (req: {
      nodeId: NodeId;
      output: unknown;
      prompt: string;
    }) => Promise<import("./types.js").HumanReviewOutcome>;
  } | undefined,
  nodeMap: Map<NodeId, NodeDef<unknown, unknown>>,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
): Promise<UnenrichedDagEvent> => {
  const stamp = (): Date => new Date(nowFn());
  if (!hooks?.onHumanReview) {
    return {
      type: "node-failed",
      nodeId,
      error: {
        kind: "node-crash",
        retriability: "retriable",
        nodeId,
        message: `${phaseKind}: no onHumanReview hook supplied`,
      },
    } satisfies DagEvent;
  }

  let outcome: import("./types.js").HumanReviewOutcome;
  try {
    outcome = await hooks.onHumanReview({ nodeId, output, prompt });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    const crash: FrameworkError = { kind: "node-crash", nodeId, retriability: "retriable", message, stack };
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: stamp(),
      error: message,
      stack,
      frameworkError: crash,
    });
    return {
      type: "node-failed",
      nodeId,
      error: crash,
    } satisfies DagEvent;
  }

  // ADR-0060: hook declined to decide → park the run. `human-suspend` drives
  // `awaiting-human/suspended/retrying-hook → suspended` in the transition
  // layer. No telemetry is emitted (no decision was made).
  if (outcome.kind === "pending") {
    return { type: "human-suspend", nodeId } satisfies DagEvent;
  }
  const action = outcome;

  // approve-with-edit goes through the live Zod schema here in the shell —
  // the pure transition can't validate (deserialized schemas are inert).
  const validationFailure = validateApproveEdit(action, nodeId, nodeMap);
  if (validationFailure !== null) {
    const valErr: FrameworkError = {
      kind: "validation",
      nodeId,
      message: validationFailure,
    };
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: stamp(),
      error: validationFailure,
      frameworkError: valErr,
    });
    return {
      type: "node-failed",
      nodeId,
      error: valErr,
    } satisfies DagEvent;
  }

  return { type: "human-responded", nodeId, action } satisfies UnenrichedDagEvent;
};


// ---------------------------------------------------------------------------
// buildDagExecutor — FR-027 applied when state.kind === "retrying"
// ---------------------------------------------------------------------------

/**
 * Builds an Executor closure for a DAG. The executor:
 * 1. If state is `retrying`: sleeps for `nextDelayMs * jitter` then re-runs the
 *    failed node. Returns `wave-done` (if all nodes in the wave now pass) or
 *    `node-failed`.
 * 2. If state is `pending`: returns a `start` event (drives first transition).
 * 3. If state is `running`: runs the full wave via Promise.all, returns
 *    `wave-done` or `node-failed` for the first failure.
 * 4. If state is `awaiting-human` and `onHumanReview` is supplied: dispatches
 *    the hook, returns `human-responded`.
 *
 * The executor never performs state transitions — it only produces DagEvents.
 * Observer events (node-start, node-end, node-error, run-start, run-end) are
 * emitted here so consumers see the full run-start / node-start / node-end /
 * run-end stream regardless of the execution path.
 */
export const buildDagExecutor = (
  dag: DagDef,
  nodeCtx: ValidatedNodeContext,
  hooks?: {
    onHumanReview?: (req: {
      nodeId: NodeId;
      output: unknown;
      prompt: string;
    }) => Promise<import("./types.js").HumanReviewOutcome>;
    /** Called once per wave with the per-node outcomes; the caller folds them into run-level meta. */
    recordOutcomes?: (outcomes: readonly NodeSpanOutcome[]) => void;
    /**
     * Crash-resume checkpoint. When provided, nodes whose ids
     * appear in this Map are skipped via `runNodeShared`'s checkpoint path
     * (validated against `outputSchema`, observer sees `node-skipped` with
     * `reason: "checkpoint"`).
     */
    resumeCheckpoint?: Map<string, unknown>;
    /**
     * RNG seam for retry-backoff jitter. Defaults to
     * `Math.random`; tests pass a seeded deterministic source.
     */
    random?: () => number;
    /**
     * Wall-clock source for observer-event `timestamp` fields. Threaded into
     * `runWave`, `callHumanReviewHook`, and `runNodeShared`. Defaults to
     * `Date.now`; tests pass a deterministic clock so event ordering is
     * checkable via property tests.
     */
    now?: () => number;
    /**
     * In-memory freshness index for single-process witness tracking. When
     * omitted, a private instance is created per executor. Pass a shared
     * instance to enable cross-DAG freshness detection within a process.
     */
    freshnessIndex?: FreshnessIndex;
    /**
     * Per-invocation minting authority (broker + origin as one value). When
     * wired, every node's declared `requires` are resolved through
     * `broker.mintFor` at dispatch and the minted handles are merged over
     * `nodeCtx` for that node. Omitted ⇒ the shared validated context is used
     * unchanged (the zero-regression path).
     */
    minting?: MintingAuthority;
  },
): Executor<DagPhase, DagEvent, DagMachineContext> => {
  const nodeMap = new Map<NodeId, NodeDef<unknown, unknown>>(
    dag.nodes.map((n) => [n.id, n]),
  );
  const recordOutcomes = hooks?.recordOutcomes;
  const resumeCheckpoint = hooks?.resumeCheckpoint;
  const random = hooks?.random ?? Math.random;
  const nowFn = hooks?.now ?? Date.now;
  const freshnessIndex = hooks?.freshnessIndex ?? new InMemoryFreshnessIndex();

  // Track captured witnesses for HumanInterventionEvent context.
  // Keyed by resource so only the latest witness per resource is retained—
  // prevents unbounded growth for long-running DAGs with many reads nodes.
  // Witnesses accumulate across all waves for the lifetime of the executor,
  // so a human gate in a later wave sees all prior reads.
  //
  // Concurrent reads within the same wave: when multiple nodes in one wave
  // read the same resource, the last to complete wins (Map.set semantics).
  // This is safe because same-wave nodes execute at the same logical instant;
  // the latest witness value is the freshest. For deterministic ordering in
  // tests, sort witnesses by capturedAtMs.
  const capturedWitnesses = new Map<string, Witness>();

  const waveConfig: WaveConfig = {
    dag, nodeMap, nodeCtx, resumeCheckpoint, nowFn, freshnessIndex,
    witnessAccumulator: capturedWitnesses,
    minting: hooks?.minting,
  };

  // ---------------------------------------------------------------------------
  // sleepWithAbortCheck — shared sleep + signal abort pattern
  // ---------------------------------------------------------------------------

  const sleepWithAbortCheck = async (delayMs: number, nodeId: NodeId): Promise<DagEvent | null> => {
    const nodeDef = nodeMap.get(nodeId);
    const jitterRatio = nodeDef?.retry?.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const delayWithJitter = applyJitter(delayMs, jitterRatio, random);
    await sleep(delayWithJitter, nodeCtx.signal);
    if (nodeCtx.signal?.aborted) {
      return { type: "abort", reason: "signal" } satisfies DagEvent;
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // handleHumanGate — unified human-review handler for awaiting-human + retrying-hook.
  // Owns: optional sleep → hook call → enrich → emit telemetry → return event.
  // ---------------------------------------------------------------------------

  const handleHumanGate = async (
    phaseKind: "awaiting-human" | "retrying-hook" | "suspended",
    nodeId: NodeId,
    output: unknown,
    prompt: string,
    machineCtx: DagMachineContext,
    delayMs?: number,
  ): Promise<DagEvent> => {
    // Optional sleep (retrying-hook only)
    if (delayMs !== undefined) {
      const abortEvent = await sleepWithAbortCheck(delayMs, nodeId);
      if (abortEvent) return abortEvent;
    }

    const awaitStartMs = nowFn();
    const rawEvent = await callHumanReviewHook(phaseKind, nodeId, output, prompt, hooks, nodeMap, nodeCtx, dag.id, nowFn);
    const enrichResult = enrichHumanRespondedEvent(rawEvent, machineCtx);
    if (enrichResult.kind === "err") {
      return { type: "node-failed", nodeId: enrichResult.nodeId, error: enrichResult.error } satisfies DagEvent;
    }
    const event = enrichResult.event;
    if (event.type === "human-responded") {
      const emitResult = emitHumanIntervention(
        { nodeId, output },
        event.action,
        nodeMap,
        nodeCtx,
        dag.id,
        nowFn,
        awaitStartMs,
        [...capturedWitnesses.values()],
      );
      if (!emitResult.ok) {
        return { type: "node-failed", nodeId, error: emitResult.error } satisfies DagEvent;
      }
    }
    return event;
  };

  // ---------------------------------------------------------------------------
  // Executor closure
  // ---------------------------------------------------------------------------

  return async (phase: DagPhase, machineCtx: DagMachineContext): Promise<DagEvent> =>
    match(phase)
      // -----------------------------------------------------------------------
      // pending: just need to fire the first transition
      // -----------------------------------------------------------------------
      .with({ kind: "pending" }, () => ({ type: "start" } as DagEvent))

      // -----------------------------------------------------------------------
      // retrying: sleep with jitter then re-run the failing node in its wave
      // FR-027: delay = nextDelayMs * (1 ± jitterRatio) — symmetric jitter via applyJitter
      // -----------------------------------------------------------------------
      .with({ kind: "retrying" }, async (p) => {
        const abortEvent = await sleepWithAbortCheck(p.nextDelayMs, p.nodeId);
        if (abortEvent) return abortEvent;

        const { event, outcomes } = await executeWave(p.wave, machineCtx, waveConfig);
        recordOutcomes?.(outcomes);
        return event;
      })

      // -----------------------------------------------------------------------
      // running: run the current wave
      // -----------------------------------------------------------------------
      .with({ kind: "running" }, async (p) => {
        const { event, outcomes } = await executeWave(p.wave, machineCtx, waveConfig);
        recordOutcomes?.(outcomes);
        return event;
      })

      // -----------------------------------------------------------------------
      // awaiting-human: dispatch the review hook
      // -----------------------------------------------------------------------
      .with({ kind: "awaiting-human" }, (p) =>
        handleHumanGate("awaiting-human", p.nodeId, p.output, p.prompt, machineCtx))

      // -----------------------------------------------------------------------
      // suspended (ADR-0060): a resumed parked gate. Re-dispatch the hook — it
      // either finds a decision now (→ human-responded → proceed) or returns
      // `pending` again (→ human-suspend → re-park). Identical handling to
      // awaiting-human; the kernel's `isHalted` break is what parked it.
      // -----------------------------------------------------------------------
      .with({ kind: "suspended" }, (p) =>
        handleHumanGate("suspended", p.nodeId, p.output, p.prompt, machineCtx))

      // -----------------------------------------------------------------------
      // retrying-hook: sleep with jitter then re-call the onHumanReview hook.
      // The node is NOT re-run — only the hook is retried (FR-029a).
      // -----------------------------------------------------------------------
      .with({ kind: "retrying-hook" }, (p) =>
        handleHumanGate("retrying-hook", p.nodeId, p.output, p.prompt, machineCtx, p.nextDelayMs))

      // -----------------------------------------------------------------------
      // Terminal states — unreachable per runner's isTerminal guard.
      // Throw to surface the invariant violation.
      // -----------------------------------------------------------------------
      .with({ kind: "succeeded" }, () => {
        throw new Error("buildDagExecutor: unreachable — terminal succeeded");
      })
      .with({ kind: "failed" }, () => {
        throw new Error("buildDagExecutor: unreachable — terminal failed");
      })
      .exhaustive();
};

