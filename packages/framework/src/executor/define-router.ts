// defineRouter — classifier-driven conditional routing with a *required*
// default branch. The required `default` field is the type-level safety
// belt: `defineRouter` cannot produce a DAG that violates else-totality,
// because the constructor mandates the fallback edge.
//
//             ┌─ when caseA ─→ to[caseA]
//   classifier ─ when caseB ─→ to[caseB]
//             └─ default     ─→ default
//
// Each case accepts two mutually-exclusive shapes:
//   - { when: (out) => boolean, to } — ergonomic; helper synthesizes a
//     `Predicate<unknown>` using the case key as the label and version 1.
//   - { whenPredicate: Predicate<T>, to } — full control over label,
//     version, and `minConfidence`. Use this when the routing logic
//     changes meaningfully and you need a fingerprint bump.
//
// Sugar over `defineDagFromArray`. Same module-load validation, same brand.

import type { DagDef, Predicate } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { DagDefinitionError, defineDagFromArray } from "./define-dag.js";
import { nodeId } from "../types/ids.js";

/**
 * One case in a router. Provides either the ergonomic `when` callback (which
 * the helper wraps as `Predicate<unknown>` with the case key as label and
 * `version: 1`), or the full `whenPredicate` for callers that need explicit
 * control over label, version, or `minConfidence`. The `?: never` fences
 * enforce mutual exclusion at the type level.
 */
export type RouterCase =
  | {
      readonly when: (output: unknown) => boolean;
      readonly whenPredicate?: never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
      readonly to: NodeDef<any, any, any>;
    }
  | {
      readonly whenPredicate: Predicate<unknown>;
      readonly when?: never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
      readonly to: NodeDef<any, any, any>;
    };

export interface RouterDagConfig {
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly classifier: NodeDef<any, any, any>;
  readonly cases: Readonly<Record<string, RouterCase>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly default: NodeDef<any, any, any>;
  /**
   * Explicit output node. If omitted, the runtime uses the last-active-node
   * fallback — the node that produced output last in the executed waves.
   */
  readonly outputNodeId?: string;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly defaultRetryLimit?: number;
  readonly retryLimits?: Readonly<Record<string, number>>;
}

const isErgonomicCase = (
  c: RouterCase,
): c is Extract<RouterCase, { readonly when: (output: unknown) => boolean }> =>
  typeof (c as { readonly when?: unknown }).when === "function";

const isFullPredicateCase = (
  c: RouterCase,
): c is Extract<RouterCase, { readonly whenPredicate: Predicate<unknown> }> => {
  const wp = (c as { readonly whenPredicate?: unknown }).whenPredicate;
  return wp !== undefined && wp !== null && typeof wp === "object";
};

/**
 * Define a router DAG: a classifier node whose output is routed to one of
 * several case branches via predicates, with a required default fallback.
 *
 * ```ts
 * const dag = defineRouter({
 *   id: "intent-router",
 *   classifier: classifyIntent,
 *   cases: {
 *     "billing-question": {
 *       when: (out) => out.intent === "billing",
 *       to: billingHandler,
 *     },
 *     "support-question": {
 *       whenPredicate: {
 *         label: "support-route",
 *         version: 2,
 *         check: (out) => out.intent === "support",
 *         minConfidence: "medium",
 *       },
 *       to: supportHandler,
 *     },
 *   },
 *   default: fallbackHandler,
 * });
 * ```
 *
 * The case key serves as the predicate label in the ergonomic form. If you
 * change routing semantics, either switch the case to `whenPredicate` with
 * a bumped `version`, or change the case key — either approach reflects in
 * the DAG fingerprint.
 */
export const defineRouter = (config: RouterDagConfig): DagDef => {
  const caseEntries = Object.entries(config.cases);
  if (caseEntries.length === 0) {
    // Surface as a structured DagDefinitionError so the CLI / lint surface
    // categorizes this as `kind: "dag-definition-error"` rather than a
    // generic `import-failed` prose throw.
    throw new DagDefinitionError(config.id, {
      kind: "validation",
      nodeId: nodeId(config.classifier.id as string),
      message: "defineRouter requires at least one case",
    });
  }

  const classifierId = config.classifier.id as string;
  const defaultId = config.default.id as string;

  // Conditional edges: classifier → each case's target with its predicate.
  const conditionalEdges = caseEntries.map(([caseKey, c]) => {
    let predicate: Predicate<unknown>;
    if (isErgonomicCase(c)) {
      const check = c.when;
      predicate = { label: caseKey, version: 1, check: (value) => check(value) };
    } else if (isFullPredicateCase(c)) {
      predicate = c.whenPredicate;
    } else {
      // The `?: never` mutual-exclusion guard makes this unreachable at the
      // type level, but cast-based escape hatches could still land a case
      // with neither field set. Refuse to silently emit a malformed edge.
      throw new DagDefinitionError(config.id, {
        kind: "validation",
        nodeId: nodeId(classifierId),
        message: `defineRouter case '${caseKey}' has neither 'when' nor 'whenPredicate'`,
      });
    }
    return {
      from: classifierId,
      to: c.to.id as string,
      when: predicate,
    };
  });

  // The required else-totality edge.
  const defaultEdge = {
    from: classifierId,
    to: defaultId,
    kind: "default" as const,
  };

  const caseTargets = caseEntries.map(([, c]) => c.to);
  const nodes = [config.classifier, ...caseTargets, config.default];

  return defineDagFromArray({
    id: config.id,
    nodes,
    edges: [...conditionalEdges, defaultEdge],
    outputNodeId: config.outputNodeId,
    evalJudges: config.evalJudges,
    defaultRetryLimit: config.defaultRetryLimit,
    retryLimits: config.retryLimits,
  });
};
