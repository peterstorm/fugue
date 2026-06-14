import type { z } from "zod";
import type { NodeDef, Capability, NodeHumanReviewConfig } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { ok } from "../types/result.js";
import { createTransformNode } from "./transform.js";

/**
 * Human-in-the-loop authoring helpers (ADR-0060).
 *
 * A node carrying a `humanReview` config is a GATE: when the run reaches it, the
 * DAG SUSPENDS after the node completes and awaits a human decision (approve /
 * reject / approve-with-edit / reroute) delivered by the host's HITL engine.
 * Setting the field is what routes the run to the durable state-machine path —
 * the host supplies `RunOptions.onHumanReview`; the DAG author only declares the
 * gate.
 *
 * `humanReview` is deliberately NOT a field on the per-kind factory configs
 * (`createTransformNode` etc.) — gating is an ASPECT you add to a node, not a
 * node kind. These two helpers are the front door:
 *   - `withHumanReview(node, { prompt })` — gate ANY node (a fetch, an LLM draft);
 *     the reviewer sees that node's output.
 *   - `createHumanReviewNode({ id, schema, prompt })` — the common "pause to
 *     review the previous step's output" gate (a typed passthrough).
 */

/**
 * Attach a human-review gate to an existing node, preserving its input/output,
 * error, and capability types. Use when the gated node ALSO does work (e.g. an
 * LLM that drafts a message you want approved before it is sent) — the reviewer
 * reviews (and may edit, via `approve-with-edit`) that node's output.
 */
export const withHumanReview = <I, O, E extends FrameworkError, R extends readonly Capability[]>(
  node: NodeDef<I, O, E, R>,
  config: NodeHumanReviewConfig,
): NodeDef<I, O, E, R> => ({ ...node, humanReview: config });

/** Config for `createHumanReviewNode`. */
export interface HumanReviewNodeConfig<T> {
  readonly id: string;
  /**
   * Schema of the value under review. It is BOTH the input and the output: the
   * gate forwards its input unchanged, so the reviewer sees exactly the upstream
   * node's output (and `approve-with-edit` replaces a value of this same shape).
   */
  readonly schema: z.ZodType<T>;
  /** Prompt shown to the reviewer. */
  readonly prompt: string;
}

/**
 * Create a passthrough human-review gate: a node that forwards its input
 * unchanged and SUSPENDS for a human decision. The reviewer reviews (and may
 * edit) the upstream node's output. Built on `createTransformNode` +
 * `withHumanReview`, so it inherits the same `requires: []`, pure-transform
 * profile.
 *
 * For gating a node that also performs work, use `withHumanReview` instead.
 */
export const createHumanReviewNode = <T>(
  config: HumanReviewNodeConfig<T>,
): NodeDef<T, T, FrameworkError, readonly []> =>
  withHumanReview(
    createTransformNode({
      id: config.id,
      inputSchema: config.schema,
      outputSchema: config.schema,
      transform: (input) => ok(input),
    }),
    { prompt: config.prompt },
  );
