// shared/ — pure utilities used by both executor/ and dag-runtime/.
// Lives outside both folders so neither has to import from the other.

export { topoSort } from "./topo.js";
export { validateInput, validateOutput } from "./validate.js";
// `runNodeShared`, `withTracedNodeSpan`, and the run-meta accumulators live in
// `dag-runtime/` — they import OTel and only make sense in the runtime layer.
// They are accessible via direct paths (`dag-runtime/run-node.ts` and
// `dag-runtime/node-span.ts`) and intentionally NOT re-exported here.
export type { IncomingSources } from "./incoming.js";
export { applyJitter } from "./jitter.js";
export { validateCapabilities } from "./capabilities.js";
export { consoleLogger, noopTracer, noopObserver } from "./defaults.js";
export { makeNodeContext } from "./make-node-context.js";
export { stableHash } from "./hash.js";
export { createPassthroughBroker } from "./passthrough-broker.js";
