export {
  type Checkpointer,
  type CorruptCheckpointAddress,
  type RunMeta,
  type NodeState,
  type RunState,
  type SaveNodeOpts,
  type InMemoryStoredMeta,
  corruptCheckpointAddressValue,
  InMemoryCheckpointer,
} from "./checkpointer.js";
// Re-exported for its SIDE EFFECT as much as its value: the module carries the
// `checkpointer` CapabilityRegistry augmentation, and a type-only module would
// be elided by the bundler, silently taking the augmentation with it.
export { CHECKPOINTER_CAPABILITY } from "./capability.js";
export { dagFingerprint, FRAMEWORK_VERSION } from "./fingerprint.js";
export {
  compositeNodeKey,
  parseCompositeNodeKey,
  DEFAULT_NODE_NAMESPACE,
  type CompositeNodeKeyOpts,
  type ParsedCompositeNodeKey,
} from "./composite-node-key.js";
// RedisCheckpointer and RedisFreshnessIndex are exported from
// `@fuguejs/framework/redis` — importing them here would pull ioredis into
// every consumer's bundle.
