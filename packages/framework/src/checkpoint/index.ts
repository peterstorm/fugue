export {
  type Checkpointer,
  type CheckpointerLoadOpts,
  type CorruptCheckpointAddress,
  type RunMeta,
  type NodeState,
  type RunState,
  type SaveNodeOpts,
  type InMemoryStoredMeta,
  corruptCheckpointAddressValue,
  InMemoryCheckpointer,
  // ── The checkpoint core's shared decision/grammar surface ────────────────
  //
  // Exported for OUT-OF-PACKAGE backends, and for one reason: a `Checkpointer`
  // implemented anywhere else — the host's tenant-namespaced Redis adapter is
  // the first — must make the SAME decisions as the three in this package, and
  // the only way to guarantee that is to hand it the same functions rather than
  // a specification to re-encode. Re-encoding is what produced round-23's
  // atl-1 (Redis accepted any `Date`-parseable timestamp where the file codec
  // demanded canonical ISO) between two backends that live side by side in
  // this directory; a backend in another package has strictly worse odds.
  //
  // What each one owns, so a new backend knows which to reach for:
  //   evaluateCheckpointLoadGates — gate ORDER and verdict construction
  //   parseRunMetaRecord / parseNodeStateRecord — the persisted record grammar
  //   parseCanonicalIsoDate — the timestamp grammar those two are built on
  //   snapshotExpectedDagFingerprint — the hostile load-options seam
  //   standardCheckpointClockRead — the injected-clock guard
  //   encodeStoredNodeKey — the composite address, failing WITHOUT a write
  //   reportCorruptCheckpointEntry — the drop-and-surface observability policy
  //   TTL_SECONDS — the FR-027 expiry contract
  type CorruptCheckpointReportInput,
  TTL_SECONDS,
  encodeStoredNodeKey,
  evaluateCheckpointLoadGates,
  parseCanonicalIsoDate,
  parseNodeStateRecord,
  parseRunMetaRecord,
  reportCorruptCheckpointEntry,
  snapshotExpectedDagFingerprint,
  standardCheckpointClockRead,
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
} from "../shared/composite-node-key.js";
// RedisCheckpointer and RedisFreshnessIndex are exported from
// `@fuguejs/framework/redis` — importing them here would pull ioredis into
// every consumer's bundle.
