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
import type {
  DagTopology,
  DagRetryState,
  DagHumanGateConfig,
  DagRoutingState,
  DagMachineContextPersisted,
  DagMachineContext,
} from "../dag-runtime/types.js";
import type { DagDef } from "../types/dag.js";
import { dagId } from "../types/ids.js";
import type { RunId } from "../types/ids.js";
import type { DagId } from "../types/ids.js";
import type { NodeContext } from "../types/node.js";
import { NoopObserver } from "../types/observer.js";
import { freshnessExecutionEpoch } from "../types/witness.js";

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
  priorWitnesses?: DagMachineContextPersisted["priorWitnesses"];
  freshnessCompletedNodeIds?: DagMachineContextPersisted["freshnessCompletedNodeIds"];
  freshnessExecutionEpoch?: DagMachineContextPersisted["freshnessExecutionEpoch"];
}): DagMachineContextPersisted => ({
  ...testTopology(parts?.topology),
  ...testRetryState(parts?.retry),
  ...testHumanGateConfig(parts?.humanGate),
  ...testRoutingState(parts?.routing),
  outputs: parts?.outputs ?? new Map(),
  initialInput: parts?.initialInput ?? {},
  priorWitnesses: parts?.priorWitnesses ?? new Map(),
  freshnessCompletedNodeIds: parts?.freshnessCompletedNodeIds ?? new Set(),
  freshnessExecutionEpoch: parts?.freshnessExecutionEpoch ?? freshnessExecutionEpoch(0),
});

/** Runtime context fixture: persisted state plus compiled DAG lookup tables. */
export const testRuntimeContext = (
  overrides: Partial<DagMachineContext> = {},
): DagMachineContext => {
  const dag = overrides.dag ?? ({
    id: dagId("test"),
    nodes: [],
    edges: [],
    outputNodeId: undefined,
  } as unknown as DagDef);

  return {
    waves: overrides.waves ?? [],
    outputs: overrides.outputs ?? new Map(),
    retries: overrides.retries ?? new Map(),
    initialInput: null,
    activeNodeIds: overrides.activeNodeIds ?? new Set(),
    dag,
    incomingByNode: overrides.incomingByNode ?? new Map(),
    outgoingByNode: overrides.outgoingByNode ?? new Map(),
    unconditionalAdj: overrides.unconditionalAdj ?? new Map(),
    nodeById: overrides.nodeById ?? new Map(),
    retryConfigs: overrides.retryConfigs ?? new Map(),
    outputNodeId: dag.outputNodeId,
    defaultRetryLimit: dag.defaultRetryLimit,
    retryLimits: dag.retryLimits,
    humanReviewNodeIds: overrides.humanReviewNodeIds ?? new Set(
      dag.nodes.filter((node) => node.humanReview !== undefined).map((node) => node.id),
    ),
    humanReviewPrompts: overrides.humanReviewPrompts ?? new Map(
      dag.nodes
        .filter((node) => node.humanReview !== undefined)
        .map((node) => [node.id, node.humanReview!.prompt] as const),
    ),
    edges: dag.edges,
    confidenceByNode: overrides.confidenceByNode ?? new Map(),
    ...overrides,
    priorWitnesses: overrides.priorWitnesses ?? new Map(),
    freshnessCompletedNodeIds: overrides.freshnessCompletedNodeIds ?? new Set(),
    freshnessExecutionEpoch: overrides.freshnessExecutionEpoch ?? freshnessExecutionEpoch(0),
  };
};

// ---------------------------------------------------------------------------
// NodeContext fixture
// ---------------------------------------------------------------------------

/**
 * A minimal, fully-null `NodeContext`: no LLM, no cache, no prompts, no clock,
 * a no-op observer/tracer and a silent logger.
 *
 * The same 11-field literal was written out in seven test files, differing only
 * in the run/dag id strings. Every field added to `NodeContext` had to be
 * remembered in all seven — and a file that forgot one simply stopped compiling
 * for reasons unrelated to what it was testing. Callers override exactly the
 * seam they exercise.
 */
export const testNodeContext = (
  overrides: Partial<NodeContext> = {},
): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  http: null,
  clock: null,
  budget: null,
  logger: { warn: () => {}, error: () => {} },
  ...overrides,
});
