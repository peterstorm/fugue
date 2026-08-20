// runNodeShared — single implementation of per-node execution.
// The only production caller is `dag-runtime/wave-execution.ts`; focused tests
// invoke this seam directly to pin pre-span behavior.
//
// Behavioral options:
//
//   - `checkpoint` — when provided and contains `node.id`, the node skips
//     execution, validates the cached value against `outputSchema`, emits
//     `node-skipped`, and returns the cached value.
//
// Checkpoint write: after a successful run + output validation, the node calls
// `ctx.checkpointWriter.write(runId, nodeId, output)` whenever a
// `checkpointWriter` is wired on the context. A write failure emits
// `node-error` with a `checkpoint-write-failed:` prefix and returns
// `Err({ kind: "checkpoint-write-failed" })`. No writer wired → no write;
// checkpointing is driven solely by the presence of the writer.
//
// Event shape follows the execution path: checkpoint hits emit `node-skipped`;
// input assembly/validation can fail before `node-start`; dispatched execution
// emits `node-start` followed by `node-end` or `node-error`.

import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError, messageOf } from "../types/errors.js";
import { safeErrorMessage } from "../types/safe-error.js";
import type { NodeContext, NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { MintingAuthority, ScopedCapabilityHandle } from "../types/capability-broker.js";
import { invocationFor } from "../types/capability-broker.js";
import { mergeScopedCapabilities } from "../shared/make-node-context.js";
import type { NodeId, DagId } from "../types/ids.js";
import { emit } from "./emit.js";
import { validateInput, validateOutput } from "../shared/validate.js";
import { buildNodeInput } from "../shared/build-input.js";
import { withTracedNodeSpan, EMPTY_OUTCOME, type NodeSpanOutcome } from "./node-span.js";
import { resolveContentFilter } from "../tracing/content-filter.js";
import type { IncomingSources } from "../shared/incoming.js";

interface RunNodeOpts {
  /**
   * When provided and contains the node's id, the node skips execution.
   * The cached value is validated against `outputSchema` before being
   * returned (a deploy may have tightened the schema since the checkpoint
   * was written).
   */
  readonly checkpoint?: Map<string, unknown>;
  /**
   * Wall-clock source for observer-event `timestamp` fields and node duration
   * measurement. Threaded through from `DagRunOpts.now` / `RunOptions.now`;
   * defaults to `Date.now` when omitted. Tests pass a synthetic clock to make
   * event ordering deterministic.
   */
  readonly now?: () => number;
  /**
   * Per-invocation minting authority (broker + origin as one value — the
   * half-wired broker-without-origin state is unrepresentable). When wired,
   * the node's declared `requires` are resolved through `broker.mintFor` AT
   * DISPATCH — after `node-start`, only when the node actually runs (a
   * checkpoint-skipped node mints nothing) — and the minted narrowed handles
   * are merged over the base context for THIS node only. A mint refusal fails
   * the node fail-closed with the broker's error (no `run` is called).
   * Omitted ⇒ no per-node minting: the node runs against the shared base
   * context exactly as before.
   */
  readonly minting?: MintingAuthority;
}

export const runNodeShared = async (
  node: NodeDef<unknown, unknown>,
  ctx: ValidatedNodeContext,
  dagId: DagId,
  outputs: ReadonlyMap<NodeId, unknown>,
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
        error: `checkpoint replay rejected: ${messageOf(validated.error)}`,
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

  const nodeInputResult = buildNodeInput(outputs, incoming, nodeId);
  if (!nodeInputResult.ok) {
    return { result: nodeInputResult, outcome: EMPTY_OUTCOME };
  }
  const nodeInput = nodeInputResult.value;

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
      error: `input validation failed: ${messageOf(inputResult.error)}`,
      frameworkError: inputResult.error,
    });
    return { result: inputResult, outcome: EMPTY_OUTCOME };
  }

  return withTracedNodeSpan(nodeId, node.kind, inputResult.value, resolveContentFilter(ctx), node.sideEffects, async () => {
    const nodeStart = nowFn();
    emit(ctx, { type: "node-start", runId: ctx.runId, dagId, nodeId, sideEffects: node.sideEffects, timestamp: stamp() });

    // Per-invocation authority resolution (the per-node minting seam). When a
    // broker is wired, the node's declared `requires` are resolved into narrowly
    // scoped handles for THIS node only, minted against an `Invocation` carrying
    // the real `nodeId` (so each mint/refusal audit is per-node, not run-global).
    // The minted handles are merged over the base context; broker-resolvable
    // scope names get their narrowed handle, plain capabilities keep their static
    // client. A refusal fails the node fail-closed before `run` is ever called.
    let runCtx: NodeContext = ctx;
    if (opts.minting) {
      // Derive the Invocation's origin from the authority (single construction
      // site) so the node is always minted AS the origin the authority gates
      // against — the half-consistent "origin Y on an authority-X mint" state
      // is unrepresentable here.
      const inv = invocationFor(opts.minting, { runId: ctx.runId, dagId, nodeId });
      // The port contract says errors flow on the Result channel, never thrown
      // — but the broker is a public extension seam, so the contract is
      // enforced here rather than assumed. An unfenced throw would escape to
      // the wave-level catch-all and be reclassified as a RETRIABLE
      // `node-crash`, re-firing the broker (token-endpoint egress) on every
      // retry and losing the 403/503 taxonomy.
      let minted: Result<ScopedCapabilityHandle, FrameworkError>;
      try {
        minted = await opts.minting.broker.mintFor(inv, node.requires);
      } catch (e) {
        minted = err({
          kind: "infra-unreachable" as const,
          operation: "mint" as const,
          hop: "capability-broker",
          message: `broker.mintFor threw across the port boundary (contract violation): ${safeErrorMessage(e)}`,
        });
      }
      if (!minted.ok) {
        emit(ctx, {
          type: "node-error",
          runId: ctx.runId,
          dagId,
          nodeId,
          sideEffects: node.sideEffects,
          timestamp: stamp(),
          error: `capability minting refused: ${messageOf(minted.error)}`,
          frameworkError: minted.error,
        });
        return err(minted.error);
      }
      runCtx = mergeScopedCapabilities(ctx, minted.value);

      // Seam-contract enforcement (claims-without-delivery): run-start
      // validation exempted every `provides()`-claimed capability from the
      // base-context check on the promise it would be minted here. A broker
      // that claims a capability but omits it from its `ok()` record would
      // otherwise put an `undefined` handle behind the validated-context cast
      // below and crash inside `node.run`. Fail closed with the same error
      // vocabulary run-start validation uses.
      const undelivered = node.requires.filter(
        (cap) =>
          opts.minting?.broker.provides?.(cap) === true &&
          (runCtx as unknown as Record<string, unknown>)[cap] == null,
      );
      const [firstUndelivered, ...restUndelivered] = undelivered;
      if (firstUndelivered !== undefined) {
        const missingErr: FrameworkError = {
          kind: "missing-capability" as const,
          missing: [
            { nodeId, capability: firstUndelivered },
            ...restUndelivered.map((capability) => ({ nodeId, capability })),
          ],
        };
        emit(ctx, {
          type: "node-error",
          runId: ctx.runId,
          dagId,
          nodeId,
          sideEffects: node.sideEffects,
          timestamp: stamp(),
          error: `broker claimed but did not deliver capabilities: ${messageOf(missingErr)}`,
          frameworkError: missingErr,
        });
        return err(missingErr);
      }
    }

    // Built-in nodes can emit sub-spans while executing. Bind those timestamps
    // to the same runtime clock as node-start/node-end; do not reuse the
    // node-visible ClockCapability, which is a separate domain-time seam.
    runCtx = { ...runCtx, eventTimestamp: stamp };

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
      runResult = await runFn(inputResult.value, runCtx);
    } catch (caught) {
      const frameworkError: FrameworkError = isFrameworkError(caught)
        ? caught
        : {
            kind: "node-crash",
            nodeId,
            retriability: "non-retriable",
            message: safeErrorMessage(caught),
          };
      const message = messageOf(frameworkError);
      const stack = frameworkError.kind === "node-crash" ? frameworkError.stack : undefined;
      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        sideEffects: node.sideEffects,
        timestamp: stamp(),
        error: message,
        ...(stack !== undefined ? { stack } : {}),
        frameworkError,
      });
      return err(frameworkError);
    }

    if (!runResult.ok) {
      const frameworkError: FrameworkError = isFrameworkError(runResult.error)
        ? runResult.error
        : {
            kind: "node-crash",
            nodeId,
            retriability: "non-retriable",
            message: safeErrorMessage(runResult.error),
          };

      const errorMsg = messageOf(frameworkError);

      emit(ctx, {
        type: "node-error",
        runId: ctx.runId,
        dagId,
        nodeId,
        sideEffects: node.sideEffects,
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
        sideEffects: node.sideEffects,
        timestamp: stamp(),
        error: `output validation failed: ${messageOf(outputResult.error)}`,
        frameworkError: outputResult.error,
      });
      return outputResult;
    }

    if (ctx.checkpointWriter) {
      try {
        await ctx.checkpointWriter.write(ctx.runId, nodeId, outputResult.value);
      } catch (e) {
        const message = safeErrorMessage(e);
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
          sideEffects: node.sideEffects,
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
      sideEffects: node.sideEffects,
      timestamp: stamp(),
      duration,
      output: outputResult.value,
    });

    return ok(outputResult.value);
  });
};
