import type { NodeId } from "./ids.js";
import type { MapIndex } from "./map-index.js";
import type { FreshnessExecutionEpoch } from "./witness.js";

/** Address of a child sub-execution within the root Run, not a new Run identity. */
export type MappedChildScope = Readonly<{
  mapNodeId: NodeId;
  index: MapIndex;
  executionEpoch: FreshnessExecutionEpoch;
}>;
