// Public executor-surface re-export of the pure DagDef parser.
// The implementation lives in shared/ so dag-runtime retry derivation can
// re-enter the same soundness gate without reversing the layer dependency.
export {
  recordFromNodeArray,
  validateDagShape,
  withRetryLimits,
} from "../shared/validate-dag.js";
