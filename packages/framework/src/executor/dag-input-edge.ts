// Shared helper for the shape constructors (C0 / 0.2.0).
//
// Under 0.2.0 no node implicitly receives the DAG input — the request flows
// only over `DAG_INPUT` edges. Each single-entry shape helper (linear, fan-out,
// diamond, router) therefore wires the request to its entry node automatically,
// preserving the pre-0.2.0 behaviour where the first/source/classifier node saw
// the request. A *source* entry node (built via `createFetchNode` without
// `inputSchema`) consumes no input, so it gets no `$input` edge.

import { DAG_INPUT } from "../types/ids.js";
import type { NodeDef } from "../types/node.js";

/**
 * The `{ from: DAG_INPUT, to: node }` edge feeding the request to a shape
 * helper's entry node — empty when the node is a source (it consumes no input).
 */
export const dagInputEdgeFor = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  node: NodeDef<any, any, any>,
): readonly { readonly from: string; readonly to: string }[] =>
  node.isSource === true
    ? []
    : [{ from: DAG_INPUT as string, to: node.id as string }];
