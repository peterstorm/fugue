import type { ExecutionScope } from "../dag-runtime/execution-scope.js";
import { freshnessExecutionEpoch } from "../types/witness.js";

/** Plain child-dispatch fake for ordinary-node executor tests. */
export const unmappedRootScope: ExecutionScope = {
  kind: "root",
  executeMappedChild: async () => { throw new Error("unexpected mapped child in ordinary-node fixture"); },
};
export const ordinaryExecution = {
  scope: unmappedRootScope,
  executionEpoch: freshnessExecutionEpoch(0),
};
