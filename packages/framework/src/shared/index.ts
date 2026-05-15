// shared/ — pure utilities used by both executor/ and dag-runtime/.
// Lives outside both folders so neither has to import from the other.

export { topoSort } from "./topo.js";
export { validateInput, validateOutput } from "./validate.js";
// `runNodeShared`, `withNodeSpan`, and the run-meta accumulators moved into
// `dag-runtime/` during pass 3 — they were the only `shared/` modules
// importing OTel, and they only made sense in the DAG runtime layer. They
// stay accessible via direct paths (`dag-runtime/run-node.ts` and
// `dag-runtime/node-span.ts`); they are not re-exported here because nothing
// outside `dag-runtime/` should reach for them.
export type { IncomingSources } from "./incoming.js";
export { applyJitter } from "./jitter.js";
export { validateCapabilities } from "./capabilities.js";
export { consoleLogger, noopTracer, noopObserver } from "./defaults.js";
export { makeNodeContext } from "./make-node-context.js";
export { stableHash } from "./hash.js";
