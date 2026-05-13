// runNodeShared — single implementation of per-node execution shared by
// `executor/executor.ts` (the public `runDag` entry point) and
// `dag-runtime/executor.ts` (the state-machine path).
//
// Behavioral differences between the two callers are expressed as `opts`:
//
//   - `checkpoint` — when provided and contains `node.id`, the node skips
//     execution, validates the cached value against `outputSchema`, emits
//     `node-skipped`, and returns the cached value.
//
//   - `writeCheckpoint` — when true, after successful run + output validation,
//     calls `ctx.cache.writeCheckpoint(runId, nodeId, output)`. On failure,
//     emits `node-error` with a `checkpoint-write-failed:` prefix and returns
//     `Err({ kind: "checkpoint-write-failed" })`.
//
// Both callers always emit the same `node-start | node-end | node-error` event
// sequence — there is no caller-specific event suppression.

import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeContext, NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import { dispatchEvent } from "../observer/buffered.js";
import { validateInput, validateOutput } from "../shared/validate.js";
import { withNodeSpan, type NodeSpanOutcome } from "./node-span.js";
import { resolveContentFilter } from "../tracing/content-filter.js";
import type { IncomingSources } from "../shared/incoming.js";

const EMPTY_OUTCOME: NodeSpanOutcome = { guardrailFailed: false, guardrailWarnings: [] };

const emit = (ctx: NodeContext, event: ObserverEvent): void => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};

/**
 * Build a node's input value from its incoming sources.
 *
 * - `optional.length > 0`: input is an object keyed by `required ∪ optional`;
 *   absent optional sources surface as `undefined`.
 * - `required.length === 0`: input is the DAG-level `dagInput`.
 * - `required.length === 1`: input is the bare upstream value.
 * - `required.length >= 2`: input is an object keyed by `required`.
 *
 * Why the 0/1/≥2 split rather than always passing a keyed object: with no or
 * exactly one required source the keyed form is pure overhead — the node's
 * `run(input)` would always destructure a one-key envelope or ignore an empty
 * one. The bare-value forms make trivial transforms readable. With ≥2 sources
 * a bare value is ambiguous, so we switch to the keyed object. Optional
 * sources always force the keyed shape because their presence isn't known
 * statically — a node can't branch on whether `input` is bare-or-keyed at
 * runtime.
 */
const buildNodeInput = (
  dagInput: unknown,
  outputs: ReadonlyMap<string, unknown>,
  incoming: IncomingSources,
): unknown => {
  const { required, optional } = incoming;
  if (optional.length > 0) {
    return Object.fromEntries(
      [...required, ...optional].map((d) => [d, outputs.get(d)]),
    );
  }
  if (required.length === 0) return dagInput;
  if (required.length === 1) return outputs.get(required[0]!);
  return Object.fromEntries(required.map((d) => [d, outputs.get(d)]));
};

export interface RunNodeOpts {
  /**
   * When provided and contains the node's id, the node skips execution.
   * The cached value is validated against `outputSchema` before being
   * returned (a deploy may have tightened the schema since the checkpoint
   * was written).
   */
  readonly checkpoint?: Map<string, unknown>;
  /**
   * When true, after successful run + output validation, the runtime calls
   * `ctx.cache.writeCheckpoint(runId, nodeId, output)`. A write failure
   * surfaces as a `checkpoint-write-failed` error.
   */
  readonly writeCheckpoint?: boolean;
  /**
   * Wall-clock source for observer-event `timestamp` fields and node duration
   * measurement. Threaded through from `DagRunOpts.now` / `RunOptions.now`;
   * defaults to `Date.now` when omitted. Tests pass a synthetic clock to make
   * event ordering deterministic.
   */
  readonly now?: () => number;
}

export const runNodeShared = async (
  node: NodeDef<unknown, unknown>,
  dagInput: unknown,
  ctx: ValidatedNodeContext,
  dagId: string,
  outputs: ReadonlyMap<string, unknown>,
  incoming: IncomingSources,
  opts: RunNodeOpts = {},
): Promise<{ result: Result<unknown, FrameworkError>; outcome: NodeSpanOutcome }> => {
  const nodeId = node.id;
  const nowFn = opts.now ?? Date.now;
  const stamp = (): Date => new Date(nowFn());

  // Checkpoint resume hit — validate against the current output schema and
  // return the cached value without entering a span.
  if (opts.checkpoint?.has(nodeId)) {
    const cached = opts.checkpoint.get(nodeId);
    const validated = validateOutput(node.outputSchema, cached, nodeId);
    if (!validated.ok) {
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: stamp(),
        error: `checkpoint replay rejected: ${String(validated.error)}`,
        frameworkError: validated.error,
      });
      return { result: validated, outcome: EMPTY_OUTCOME };
    }
    emit(ctx, {
      type: "node-skipped",
      runId: ctx.runId,
      dagId,
      nodeId,
      timestamp: stamp(),
      reason: "checkpoint",
    });
    return { result: ok(validated.value), outcome: EMPTY_OUTCOME };
  }

  const nodeInput = buildNodeInput(dagInput, outputs, incoming);

  const inputResult = validateInput(node.inputSchema, nodeInput, nodeId);
  if (!inputResult.ok) {
    // Emit node-error so buffered observers don't see the node simply disappear
    // — without this, a node that fails input validation produces no event at
    // all, making post-mortems on a buffered run impossible.
    emit(ctx, {
      type: "node-error",
      runId: ctx.runId,
      dagId,
      nodeId,
      timestamp: stamp(),
      error: `input validation failed: ${JSON.stringify(inputResult.error as FrameworkError)}`,
      frameworkError: inputResult.error,
    });
    return { result: inputResult, outcome: EMPTY_OUTCOME };
  }

  return withNodeSpan(nodeId, node.kind, inputResult.value, resolveContentFilter(ctx), async () => {
    const nodeStart = nowFn();
    emit(ctx, { type: "node-start", runId: ctx.runId, dagId, nodeId, timestamp: stamp() });

    let runResult: Result<unknown, FrameworkError>;
    try {
      // Capability erasure boundary: the node's `run` is typed against the
      // narrow `TypedNodeContext<R>` derived from its `requires`, but the
      // runtime carries the wide `BaseNodeContext`. Capability presence was
      // validated at run start (`validateCapabilities`), so this cast is
      // sound — the runtime is the oracle for which fields are non-null.
      const runFn = node.run as (
        input: unknown,
        ctx: NodeContext,
      ) => Promise<Result<unknown, FrameworkError>>;
      runResult = await runFn(inputResult.value, ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      const crash: FrameworkError = {
        kind: "node-crash" as const,
        nodeId,
        retriability: "retriable" as const,
        message,
        stack,
      };
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: stamp(),
        error: message,
        stack,
        frameworkError: crash,
      });
      return err(crash);
    }

    if (!runResult.ok) {
      const frameworkError: FrameworkError =
        runResult.error !== null &&
        typeof runResult.error === "object" &&
        "kind" in (runResult.error as object)
          ? (runResult.error as FrameworkError)
          : { kind: "node-crash" as const, nodeId, retriability: "retriable" as const, message: String(runResult.error) };

      const errorMsg =
        frameworkError.kind === "node-crash"
          ? frameworkError.message
          : JSON.stringify(frameworkError);

      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: stamp(),
        error: errorMsg,
        frameworkError,
      });
      return err(frameworkError);
    }

    const outputResult = validateOutput(node.outputSchema, runResult.value, nodeId);
    if (!outputResult.ok) {
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        timestamp: stamp(),
        error: `output validation failed: ${JSON.stringify(outputResult.error as FrameworkError)}`,
        frameworkError: outputResult.error,
      });
      return outputResult;
    }

    if (opts.writeCheckpoint && ctx.cache?.writeCheckpoint) {
      try {
        await ctx.cache.writeCheckpoint(ctx.runId, nodeId, outputResult.value);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const cpwError: FrameworkError = {
          kind: "checkpoint-write-failed" as const,
          runId: ctx.runId,
          nodeId,
          message,
        };
        emit(ctx, {
          type: "node-error",
          runId: ctx.runId,
          dagId,
          nodeId,
          timestamp: stamp(),
          error: `checkpoint-write-failed: ${message}`,
          frameworkError: cpwError,
        });
        return err(cpwError);
      }
    }

    const duration = nowFn() - nodeStart;
    emit(ctx, {
      type: "node-end",
      runId: ctx.runId,
      dagId,
      nodeId,
      timestamp: stamp(),
      duration,
      output: outputResult.value,
    });

    return ok(outputResult.value);
  });
};
