// Test fixture factories for DagMachineContextPersisted and its slice types.
//
// These factories let tests construct focused slices without assembling
// the full 13-field context object. Each factory provides sensible defaults
// that can be overridden via partial arguments.
//
// Usage:
//   import { testContext, testTopology, testRetryState } from "./_context-factories.js";
//
//   const ctx = testContext({ topology: { waves: [[nodeId("a")]] } });
//   const retry = testRetryState({ retries: new Map([[nodeId("a"), 2]]) });

import type { NodeId } from "../types/ids.js";
import type { EdgeDef } from "../types/dag.js";
import type { Confidence } from "../types/confidence.js";
import type {
  DagTopology,
  DagRetryState,
  DagHumanGateConfig,
  DagRoutingState,
  DagMachineContextPersisted,
} from "../dag-runtime/types.js";

// ---------------------------------------------------------------------------
// Per-slice factories
// ---------------------------------------------------------------------------

export const testTopology = (overrides?: Partial<DagTopology>): DagTopology => ({
  waves: [],
  edges: [],
  unconditionalAdj: new Map(),
  outputNodeId: undefined,
  ...overrides,
});

export const testRetryState = (overrides?: Partial<DagRetryState>): DagRetryState => ({
  retries: new Map(),
  retryConfigs: new Map(),
  defaultRetryLimit: undefined,
  retryLimits: undefined,
  ...overrides,
});

export const testHumanGateConfig = (overrides?: Partial<DagHumanGateConfig>): DagHumanGateConfig => ({
  humanReviewNodeIds: new Set(),
  humanReviewPrompts: new Map(),
  ...overrides,
});

export const testRoutingState = (overrides?: Partial<DagRoutingState>): DagRoutingState => ({
  activeNodeIds: new Set(),
  confidenceByNode: new Map(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Full context factory
// ---------------------------------------------------------------------------

/** Assemble a full DagMachineContextPersisted from optional slice overrides. */
export const testContext = (parts?: {
  topology?: Partial<DagTopology>;
  retry?: Partial<DagRetryState>;
  humanGate?: Partial<DagHumanGateConfig>;
  routing?: Partial<DagRoutingState>;
  outputs?: ReadonlyMap<NodeId, unknown>;
  initialInput?: unknown;
}): DagMachineContextPersisted => ({
  ...testTopology(parts?.topology),
  ...testRetryState(parts?.retry),
  ...testHumanGateConfig(parts?.humanGate),
  ...testRoutingState(parts?.routing),
  outputs: parts?.outputs ?? new Map(),
  initialInput: parts?.initialInput ?? {},
});
