// shared/ — pure utilities used by both executor/ and dag-runtime/.
//
// Lives outside both folders so neither needs to import from the other,
// breaking the executor/ ↔ dag-runtime/ cycle that previously forced one
// to import from the other to call validation/topo-sort/run-node helpers.

export { topoSort } from "./topo.js";
export { validateInput, validateOutput } from "./validate.js";
export {
  withNodeSpan,
  createDagRunMeta,
  foldOutcomes,
  type DagRunMeta,
  type NodeSpanOutcome,
} from "./node-span.js";
export { runNodeShared, type RunNodeOpts } from "./run-node.js";
export type { IncomingSources } from "./incoming.js";
export { applyJitter } from "./jitter.js";
export { validateCapabilities } from "./capabilities.js";
export { consoleLogger, noopTracer, noopObserver } from "./defaults.js";
export { makeNodeContext } from "./make-node-context.js";
