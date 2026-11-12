import type { ExecutionScope } from "../dag-runtime/execution-scope.js";
import { DEFAULT_FAN_CONCURRENCY_CAP } from "../types/fan-scheduling.js";
import { freshnessExecutionEpoch } from "../types/witness.js";

/** Plain child-dispatch fake for ordinary-node executor tests. */
export const unmappedRootScope: ExecutionScope = {
  kind: "root",
  executeMappedChild: async () => { throw new Error("unexpected mapped child in ordinary-node fixture"); },
  // Inert fan runtime: ordinary-node fixtures never dispatch a fan.
  fan: { budget: null, cap: DEFAULT_FAN_CONCURRENCY_CAP, logger: { warn: () => {}, error: () => {} }, tagSpan: () => {} },
};
export const ordinaryExecution = {
  scope: unmappedRootScope,
  executionEpoch: freshnessExecutionEpoch(0),
};
