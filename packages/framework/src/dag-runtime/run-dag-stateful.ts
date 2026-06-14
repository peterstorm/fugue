// runDagStateful — orchestrates the DAG executor with the state-machine runner.
// Stateful DAG lifecycle, input/output validation, retry with backoff.
//
// This file is intentionally orchestration-only. It composes helpers from
// sibling modules; add new behaviour to the matching helper, not here.
//
// Internal decomposition:
//   prepareDagRun     — pre-flight: retry merge, telemetry, capability check
//   resolveJob        — job handle: caller-supplied or fresh in-memory
//   handleTerminalState — match terminal state: judges, error, invariant violation
//   handleKernelError — catch block: abort vs terminal-failed

import { match } from "ts-pattern";
import type { Span } from "@opentelemetry/api";
import type { JobLike, KernelRunOpts } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanReviewOutcome } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import type { DagDef } from "../types/dag.js";
import { withRetryLimits } from "../types/dag.js";
import type { NodeContext, ValidatedNodeContext } from "../types/node.js";
import type { MintingAuthority } from "../types/capability-broker.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { runStateMachine } from "../state-machine/runner.js";
import { compileDagToMachine } from "./machine.js";
import { buildDagExecutor } from "./executor.js";
import { finalizeRunWithJudges, runFinalizeInBackground } from "./eval-judges.js";
import { createDagRunMeta, foldOutcomes, type DagRunMeta, type NodeSpanOutcome } from "./node-span.js";
import { validateCapabilities } from "../shared/capabilities.js";
import { wrapDagJobLike } from "./persistence.js";
import { beginRunTelemetry, closeRootSpan, startRunSpan } from "./run-telemetry.js";
import type { FreshnessIndex } from "./freshness-check.js";
import { sha256DedupKey } from "../shared/dedup-key.js";
import { fwLogger } from "../logger.js";
import type { CompiledDagMachine } from "./machine.js";

// ---------------------------------------------------------------------------
// DagRunOpts — caller-supplied options for runDagStateful
// ---------------------------------------------------------------------------

/**
 * Outcome of a stateful run (ADR-0060). A run that reaches `succeeded` is
 * `completed` with its output; a run parked at a human gate (`suspended`) is
 * surfaced as `suspended` so a durable worker can ack-and-park rather than
 * treating the pause as success or failure. A `failed` run is the `err` channel
 * of the enclosing `Result`, not a variant here.
 */
export type StatefulOutcome<O> =
  | { readonly kind: "completed"; readonly output: O }
  | {
      readonly kind: "suspended";
      readonly nodeId: NodeId;
      readonly prompt: string;
      readonly output: unknown;
    };

/** Result of background judge finalization, surfaced via `onBackground`. */
export interface BackgroundResult {
  /** True when all judges returned `passed: true`. */
  readonly judgesPassed: boolean;
  /** True when any judge crashed (threw unexpectedly). */
  readonly judgesCrashed: boolean;
  /** Full run meta including eval-judge results and guardrail state. */
  readonly meta: DagRunMeta;
}

export interface DagRunOpts
  extends Omit<KernelRunOpts<DagPhase, DagEvent, DagMachineContext>, "errorEventOf" | "computeDedupKey" | "logger" | "onCommitted"> {
  /** Provide a durable job backend (BullMQ, etc.). Falls back to in-memory when omitted.
   * Typed against `DagMachineContextPersisted` — the serialization-safe subset.
   * The runtime re-injects live DAG-derived fields (closures, schemas) on read.
   */
  readonly jobLike?: JobLike<DagPhase, unknown, DagMachineContextPersisted>;
  /**
   * Human-review hook. Called when the DAG enters `awaiting-human`.
   * The resolved action is delivered to the machine as `human-responded`.
   */
  readonly onHumanReview?: (req: {
    nodeId: NodeId;
    output: unknown;
    prompt: string;
  }) => Promise<HumanReviewOutcome>;
  /**
   * ADR-0060: effectively-once decision consumption. Called with the gate's
   * `nodeId` AFTER the post-gate transition (the one driven by the consumed
   * `human-responded` decision) is durably checkpointed. The host wires this to
   * clear the decision from its store, so a worker crash BEFORE the checkpoint
   * re-reads the decision on resume instead of losing the approval. Implemented
   * via the kernel's `onCommitted` hook, filtered to `human-responded` events.
   */
  readonly onDecisionConsumed?: (nodeId: NodeId) => void | Promise<void>;
  /**
   * Per-node retry limits passed at call time — merged with (and takes precedence over)
   * DagDef.retryLimits. Allows callers to override retry budgets without mutating the DAG.
   */
  readonly retryLimits?: Readonly<Record<string, number>>;
  /**
   * When supplied, eval-judges run in the background after the run resolves
   * `ok`. The hook receives a promise that resolves with a typed result
   * indicating whether judges passed, crashed, or failed quality gates.
   * When omitted, judges still run before resolution.
   */
  readonly onBackground?: (p: Promise<BackgroundResult>) => void;
  /**
   * Checkpoint replay for crash-resume scenarios. When provided, nodes whose
   * ids appear in this Map are skipped on first encounter: their cached
   * output is validated against the node's current `outputSchema` and a
   * `node-skipped` observer event is emitted. On validation failure the
   * runtime emits `node-error` and aborts the run with `Err({kind: "validation"})`,
   * matching `resumeRun(...)` semantics.
   */
  readonly resumeCheckpoint?: Map<string, unknown>;
  /**
   * RNG seam for retry-backoff jitter. Defaults to `Math.random`; tests pass
   * a seeded deterministic source.
   */
  readonly random?: () => number;
  /**
   * In-memory freshness index for single-process witness tracking. When
   * omitted, a private instance is created per executor. Pass a shared
   * instance to enable cross-DAG freshness detection within a process.
   */
  readonly freshnessIndex?: FreshnessIndex;
  /**
   * Per-invocation minting authority (broker + origin as one value). When
   * wired, each node's declared `requires` are resolved through
   * `broker.mintFor` at dispatch and the minted narrowed handles are merged
   * over the validated context for that node only. Run-start validation treats
   * `broker.provides()` capabilities as satisfied (they are minted per node,
   * not present on the base context) — pairing the broker with `origin` in one
   * type guarantees the dispatch-time mint that exemption relies on can
   * actually happen. Omitted ⇒ no per-node minting; the shared context is used
   * unchanged.
   */
  readonly minting?: MintingAuthority;
}

// ---------------------------------------------------------------------------
// prepareDagRun — pre-flight: merge retry limits, emit run-start, validate capabilities
// ---------------------------------------------------------------------------

interface PreparedRun {
  readonly effectiveDag: DagDef;
  readonly validatedCtx: ValidatedNodeContext;
  readonly emitRunEnd: (status: "ok" | "error") => void;
}

const prepareDagRun = (
  dag: DagDef,
  nodeCtx: NodeContext,
  opts?: Pick<DagRunOpts, "retryLimits" | "now" | "minting">,
): Result<PreparedRun, FrameworkError> => {
  const effectiveDag: DagDef =
    opts?.retryLimits !== undefined ? withRetryLimits(dag, opts.retryLimits) : dag;

  // Emit run-start BEFORE compile so a malformed DAG still produces a balanced
  // run-start/run-end pair.
  const { emitRunEnd } = beginRunTelemetry(nodeCtx, dag, { now: opts?.now });

  // Capability validation. On success, hands back a phantom-branded token.
  // A minting broker's `provides()` capabilities are resolved at dispatch, so
  // the run-start check treats them as satisfied rather than demanding them on
  // the boot-scoped base context.
  const capCheck = validateCapabilities(effectiveDag, nodeCtx, opts?.minting?.broker);
  if (!capCheck.ok) {
    emitRunEnd("error");
    return err(capCheck.error);
  }

  return ok({ effectiveDag, validatedCtx: capCheck.value, emitRunEnd });
};

// ---------------------------------------------------------------------------
// resolveJob — resolve the durable job handle (caller-supplied or in-memory)
// ---------------------------------------------------------------------------

const resolveJob = (
  compiled: CompiledDagMachine,
  effectiveDag: DagDef,
  nodeCtx: NodeContext,
  opts?: Pick<DagRunOpts, "jobLike">,
): Result<JobLike<DagPhase, unknown, DagMachineContext>, FrameworkError> => {
  if (opts?.jobLike) {
    const wrapped = wrapDagJobLike(opts.jobLike, effectiveDag, nodeCtx.runId);
    const fingerprintCheck = wrapped.verifyDagFingerprint();
    if (!fingerprintCheck.ok) return err(fingerprintCheck.error);
    return ok(wrapped.job);
  }
  return ok(
    createInMemoryJob<DagPhase, DagMachineContext>({
      state: compiled.initialState,
      context: compiled.initialContext,
    }),
  );
};

// ---------------------------------------------------------------------------
// handleTerminalState — match on terminal phase: success→judges, failure→error
// ---------------------------------------------------------------------------

interface TerminalDeps {
  readonly rootSpan: Span;
  readonly dag: DagDef;
  readonly input: unknown;
  readonly nodeCtx: NodeContext;
  readonly meta: DagRunMeta;
  readonly emitRunEnd: (status: "ok" | "error") => void;
  readonly opts?: DagRunOpts;
}

const handleTerminalState = <O>(
  state: DagPhase,
  context: DagMachineContext,
  deps: TerminalDeps,
): Promise<Result<StatefulOutcome<O>, FrameworkError>> =>
  match(state)
    .returnType<Promise<Result<StatefulOutcome<O>, FrameworkError>>>()
    .with({ kind: "succeeded" }, async (s) => {
      const finalize = (): Promise<DagRunMeta> =>
        finalizeRunWithJudges(
          deps.rootSpan, deps.dag, deps.input, s.output,
          context.outputs, deps.nodeCtx, deps.meta, deps.emitRunEnd,
        );

      if (deps.opts?.onBackground) {
        deps.opts.onBackground(runFinalizeInBackground(finalize, deps.rootSpan, deps.emitRunEnd));
      } else {
        await finalize();
      }
      return ok({ kind: "completed", output: s.output as O });
    })
    .with({ kind: "failed" }, async (s) => {
      closeRootSpan(deps.rootSpan, { kind: "error", error: s.error });
      deps.emitRunEnd("error");
      return err(s.error);
    })
    // ADR-0060: the run parked at a human gate. Close the root span cleanly (not
    // an error — the run is paused, not finished) and surface `suspended` so a
    // durable worker acks the job and waits for an out-of-band decision. The
    // run-end telemetry is intentionally NOT emitted here: the run has not
    // ended; the matching run-end fires on the resume that reaches a terminal.
    .with({ kind: "suspended" }, async (s) => {
      closeRootSpan(deps.rootSpan, { kind: "ok" });
      return ok({ kind: "suspended", nodeId: s.nodeId, prompt: s.prompt, output: s.output });
    })
    .with({ kind: "pending" }, async (s) =>
      unexpectedNonTerminal(deps.rootSpan, deps.emitRunEnd, s.kind, EXECUTOR_NODE_ID))
    .with({ kind: "running" }, async (s) =>
      unexpectedNonTerminal(deps.rootSpan, deps.emitRunEnd, s.kind, EXECUTOR_NODE_ID))
    .with({ kind: "retrying" }, async (s) =>
      unexpectedNonTerminal(deps.rootSpan, deps.emitRunEnd, s.kind, EXECUTOR_NODE_ID))
    .with({ kind: "retrying-hook" }, async (s) =>
      unexpectedNonTerminal(deps.rootSpan, deps.emitRunEnd, s.kind, s.nodeId))
    .with({ kind: "awaiting-human" }, async (s) =>
      unexpectedNonTerminal(deps.rootSpan, deps.emitRunEnd, s.kind, EXECUTOR_NODE_ID))
    .exhaustive();

// ---------------------------------------------------------------------------
// handleKernelError — catch block: abort vs terminal-failed
// ---------------------------------------------------------------------------

const handleKernelError = <O>(
  e: unknown,
  rootSpan: Span,
  emitRunEnd: (status: "ok" | "error") => void,
): Result<StatefulOutcome<O>, FrameworkError> => {
  const isAbort = e instanceof Error && e.message.includes("aborted by beforeExecute");
  if (isAbort) {
    const error: FrameworkError = { kind: "aborted", reason: "beforeExecute hook returned false" };
    closeRootSpan(rootSpan, { kind: "error", error });
    emitRunEnd("error");
    return err(error);
  }
  // Terminal-failed: the kernel attaches { state, context } to Error.cause.
  const cause = (e as Error)?.cause as { state?: DagPhase } | undefined;
  const failedState = cause?.state?.kind === "failed"
    ? (cause.state as Extract<DagPhase, { kind: "failed" }>)
    : undefined;
  const error: FrameworkError = failedState?.error ?? {
    kind: "node-crash",
    nodeId: EXECUTOR_NODE_ID,
    retriability: "retriable",
    message: e instanceof Error ? e.message : String(e),
  };
  closeRootSpan(rootSpan, { kind: "error", error });
  emitRunEnd("error");
  return err(error);
};

// ---------------------------------------------------------------------------
// runDagStateful — the orchestrator pipeline
// ---------------------------------------------------------------------------

/**
 * Run a DAG through the state-machine kernel, using a durable `JobLike` for
 * checkpointing. Falls back to an in-memory `JobLike` when `opts.jobLike` is
 * not supplied.
 *
 * Returns `ok(StatefulOutcome<O>)` — `{ kind: "completed"; output }` when the
 * DAG reaches `succeeded`, or `{ kind: "suspended"; nodeId; prompt; output }`
 * when it halts at a human gate (ADR-0060) — and `err(error)` when the machine
 * ends in a `failed` terminal state. (The flat-`Result<O>` back-compat entry is
 * `runDagStateful` below, which unwraps `completed` and maps `suspended` to an
 * invariant `err`.)
 *
 * Pipeline:
 *   1. prepareDagRun — merge retries, emit run-start, validate capabilities
 *   2. startRunSpan  — OTel root span
 *   3. compile       — topo sort, build initial context
 *   4. resolveJob    — caller-supplied or in-memory JobLike
 *   5. execute       — build executor, run state machine kernel
 *   6. terminal      — handle completed/suspended/failed/unexpected
 */
export const runDagStatefulOutcome = async <I, O>(
  dag: DagDef,
  input: I,
  nodeCtx: NodeContext,
  opts?: DagRunOpts,
): Promise<Result<StatefulOutcome<O>, FrameworkError>> => {
  // 1. Pre-flight
  const prepared = prepareDagRun(dag, nodeCtx, opts);
  if (!prepared.ok) return prepared;
  const { effectiveDag, validatedCtx, emitRunEnd } = prepared.value;

  // 2. OTel root span wraps compilation + execution
  return startRunSpan(dag, nodeCtx, async (rootSpan): Promise<Result<StatefulOutcome<O>, FrameworkError>> => {
    // 3. Compile
    const compiled = compileDagToMachine(effectiveDag, input);
    if (!compiled.ok) {
      closeRootSpan(rootSpan, { kind: "error", error: compiled.error });
      emitRunEnd("error");
      return err(compiled.error);
    }

    // 4. Resolve job
    const jobResult = resolveJob(compiled.value, effectiveDag, nodeCtx, opts);
    if (!jobResult.ok) {
      closeRootSpan(rootSpan, { kind: "error", error: jobResult.error });
      emitRunEnd("error");
      return err(jobResult.error);
    }
    const job = jobResult.value;

    // 5. Build executor + run kernel
    let meta: DagRunMeta = createDagRunMeta();
    const recordOutcomes = (outcomes: readonly NodeSpanOutcome[]): void => {
      meta = foldOutcomes(meta, outcomes);
    };

    const executor = buildDagExecutor(effectiveDag, validatedCtx, {
      onHumanReview: opts?.onHumanReview,
      recordOutcomes,
      resumeCheckpoint: opts?.resumeCheckpoint,
      random: opts?.random,
      now: opts?.now,
      freshnessIndex: opts?.freshnessIndex,
      minting: opts?.minting,
    });

    const errorEventOf = (classified: { retriable: boolean; message: string }): DagEvent => ({
      type: "executor-error",
      retriable: classified.retriable,
      error: classified.message,
    });

    const onDecisionConsumed = opts?.onDecisionConsumed;
    const runOpts: KernelRunOpts<DagPhase, DagEvent, DagMachineContext> = {
      beforeExecute: opts?.beforeExecute,
      classifyError: opts?.classifyError,
      onTrace: opts?.onTrace,
      errorEventOf,
      now: opts?.now,
      computeDedupKey: sha256DedupKey,
      logger: fwLogger(),
      // ADR-0060: translate the generic post-commit hook into the DAG-semantic
      // "a decision was consumed" signal. `human-responded` is the only event
      // produced by consuming a decision; its `nodeId` is the resolved gate.
      ...(onDecisionConsumed !== undefined
        ? {
            onCommitted: async ({ event }: { event: DagEvent }): Promise<void> => {
              if (event.type === "human-responded") {
                await onDecisionConsumed(event.nodeId);
              }
            },
          }
        : {}),
    };

    try {
      const { state, context } = await runStateMachine(job, compiled.value.machine, executor, runOpts);

      // 6. Handle terminal state
      return handleTerminalState<O>(state, context, {
        rootSpan, dag, input, nodeCtx, meta, emitRunEnd, opts,
      });
    } catch (e) {
      return handleKernelError<O>(e, rootSpan, emitRunEnd);
    }
  });
};

// ---------------------------------------------------------------------------
// runDagStateful — back-compat flat Result<O> entry point (ADR-0021)
// ---------------------------------------------------------------------------

/**
 * Back-compat kernel entry returning the flat `Result<O>` (ADR-0021). Unwraps a
 * `completed` outcome to its output. A `suspended` outcome (ADR-0060) cannot be
 * represented in `Result<O>`, so it surfaces as an invariant `err` — callers
 * that want durable suspend must use `runDagStatefulOutcome` /
 * `runResumableDagJob`. Existing non-HITL (and block-until-decided) callers are
 * unaffected: they never produce `suspended`.
 */
export const runDagStateful = async <I, O>(
  dag: DagDef,
  input: I,
  nodeCtx: NodeContext,
  opts?: DagRunOpts,
): Promise<Result<O, FrameworkError>> => {
  const outcome = await runDagStatefulOutcome<I, O>(dag, input, nodeCtx, opts);
  if (!outcome.ok) return outcome;
  if (outcome.value.kind === "suspended") {
    return err({
      kind: "node-crash",
      retriability: "non-retriable",
      nodeId: EXECUTOR_NODE_ID,
      message: `runDagStateful: DAG '${dag.id}' suspended at human gate '${outcome.value.nodeId}' — use runDagStatefulOutcome / runResumableDagJob for suspendable runs`,
    });
  }
  return ok(outcome.value.output);
};

// ---------------------------------------------------------------------------
// unexpectedNonTerminal — invariant violation: runStateMachine returned without a terminal state
// ---------------------------------------------------------------------------

const unexpectedNonTerminal = <O>(
  rootSpan: Span,
  emitRunEnd: (status: "ok" | "error") => void,
  kind: string,
  nodeId: NodeId,
): Result<StatefulOutcome<O>, FrameworkError> => {
  const message = `runDagStateful: unexpected non-terminal state ${kind}`;
  const error: FrameworkError = {
    kind: "node-crash",
    nodeId,
    retriability: "retriable",
    message,
  };
  closeRootSpan(rootSpan, { kind: "error", error });
  emitRunEnd("error");
  return err(error);
};

