/**
 * Property test: dagTransition never throws for any (DagPhase, DagEvent) pair.
 *
 * ts-pattern's .exhaustive() guarantees compile-time coverage, but runtime
 * shape violations (from event-log replay, hand-crafted events, or `as` casts)
 * could slip past. This property test generates random phase/event combinations
 * and asserts the function always returns a valid { state, context } pair
 * without throwing.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { dagTransition } from "../dag-runtime/transition.js";
import type { DagPhase, DagEvent, DagMachineContext } from "../dag-runtime/types.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { DagDef } from "../types/dag.js";
import { N, D } from "./_id-helpers.js";
import { FE } from "./_freshness-helpers.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Minimal DagDef + DagMachineContext fixture for transitions
// ---------------------------------------------------------------------------

const minimalNodeDef = (id: string) => ({
  id: N(id),
  kind: "transform" as const,
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async () => ({ ok: true as const, value: undefined }),
  requires: [] as const,
  sideEffects: { kind: "none" as const },
  confidence: { mode: "none" as const },
});

const minimalDag: DagDef = {
  id: D("test"),
  nodes: [minimalNodeDef("a"), minimalNodeDef("b")],
  edges: [{ kind: "unconditional" as const, from: N("a"), to: N("b") }],
  outputNodeId: N("b"),
} as unknown as DagDef;

const minimalCtx: DagMachineContext = {
  dag: minimalDag,
  waves: [[N("a")], [N("b")]],
  outputs: new Map(),
  retries: new Map(),
  initialInput: null,
  activeNodeIds: new Set([N("a"), N("b")]),
  incomingByNode: new Map([[N("a"), { required: [], optional: [] }], [N("b"), { required: ["a"], optional: [] }]]),
  outgoingByNode: new Map([[N("a"), minimalDag.edges], [N("b"), []]]),
  unconditionalAdj: new Map([[N("a"), [N("b")]]]),
  nodeById: new Map([
    [N("a"), minimalNodeDef("a") as any],
    [N("b"), minimalNodeDef("b") as any],
  ]),
  retryConfigs: new Map(),
  outputNodeId: N("b"),
  defaultRetryLimit: undefined,
  retryLimits: undefined,
  humanReviewNodeIds: new Set(),
  humanReviewPrompts: new Map(),
  edges: minimalDag.edges,
  confidenceByNode: new Map(),
  priorWitnesses: new Map(),
  freshnessCompletedNodeIds: new Set(),
  freshnessExecutionEpoch: FE(),
};

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbNodeId = fc.constantFrom(N("a"), N("b"), N("unknown"));

const arbFrameworkError: fc.Arbitrary<FrameworkError> = fc.oneof(
  fc.record({
    kind: fc.constant("node-crash" as const),
    nodeId: arbNodeId,
    message: fc.string({ maxLength: 20 }),
    retriability: fc.constantFrom("retriable" as const, "non-retriable" as const),
  }),
  fc.record({
    kind: fc.constant("transient" as const),
    nodeId: arbNodeId,
    message: fc.string({ maxLength: 20 }),
  }),
  fc.record({
    kind: fc.constant("validation" as const),
    nodeId: arbNodeId,
    message: fc.string({ maxLength: 20 }),
  }),
);

const arbDagPhase: fc.Arbitrary<DagPhase> = fc.oneof(
  fc.constant({ kind: "pending" as const }),
  fc.record({ kind: fc.constant("running" as const), wave: fc.nat(5) }),
  fc.record({
    kind: fc.constant("retrying" as const),
    wave: fc.nat(5),
    nodeId: arbNodeId,
    attempt: fc.integer({ min: 1, max: 5 }),
    nextDelayMs: fc.integer({ min: 100, max: 5000 }),
  }),
  fc.record({
    kind: fc.constant("awaiting-human" as const),
    nodeId: arbNodeId,
    output: fc.oneof(fc.constant(null), fc.string(), fc.integer()),
    prompt: fc.string({ maxLength: 20 }),
    pendingReviews: fc.array(arbNodeId, { maxLength: 3 }),
    wave: fc.nat(5),
  }),
  // ADR-0060: the durable parked phase — the one serialized to Redis and replayed
  // across restarts, exactly the event-log-replay scenario this property guards.
  fc.record({
    kind: fc.constant("suspended" as const),
    nodeId: arbNodeId,
    output: fc.oneof(fc.constant(null), fc.string(), fc.integer()),
    prompt: fc.string({ maxLength: 20 }),
    pendingReviews: fc.array(arbNodeId, { maxLength: 3 }),
    wave: fc.nat(5),
  }),
  fc.record({
    kind: fc.constant("retrying-hook" as const),
    nodeId: arbNodeId,
    output: fc.oneof(fc.constant(null), fc.string()),
    prompt: fc.string({ maxLength: 20 }),
    attempt: fc.integer({ min: 1, max: 5 }),
    nextDelayMs: fc.integer({ min: 100, max: 5000 }),
    pendingReviews: fc.array(arbNodeId, { maxLength: 3 }),
    wave: fc.nat(5),
  }),
  fc.record({
    kind: fc.constant("succeeded" as const),
    output: fc.oneof(fc.constant(null), fc.string()),
  }),
  fc.record({
    kind: fc.constant("failed" as const),
    error: arbFrameworkError,
  }),
);

const arbDagEvent: fc.Arbitrary<DagEvent> = fc.oneof(
  fc.constant({ type: "start" as const }),
  fc.record({
    type: fc.constant("wave-done" as const),
    wave: fc.nat(5),
    outputs: fc.constant(new Map<NodeId, unknown>()),
    routingDecisions: fc.constant(new Map()),
    priorWitnesses: fc.constant(new Map()),
    freshnessCompletedNodeIds: fc.constant(new Set<NodeId>()),
  }),
  fc.record({
    type: fc.constant("node-failed" as const),
    nodeId: arbNodeId,
    error: arbFrameworkError,
  }),
  fc.oneof(
    fc.record({
      type: fc.constant("human-responded" as const),
      nodeId: arbNodeId,
      action: fc.oneof(
        fc.constant({ kind: "approve" as const }),
        fc.record({ kind: fc.constant("approve-with-edit" as const), newOutput: fc.string() }),
        fc.record({ kind: fc.constant("reject" as const), reason: fc.string({ maxLength: 20 }) }),
      ),
    }),
    fc.record({
      type: fc.constant("human-responded" as const),
      nodeId: arbNodeId,
      action: fc.record({ kind: fc.constant("reroute" as const), targetNodeId: arbNodeId }),
      rerouteActiveSet: fc.constant(new Set<NodeId>()),
    }),
  ),
  // ADR-0060: hook returned `pending` → park durably (awaiting-human → suspended,
  // suspended → suspended, retrying-hook → suspended).
  fc.record({
    type: fc.constant("human-suspend" as const),
    nodeId: arbNodeId,
  }),
  fc.record({
    type: fc.constant("abort" as const),
    reason: fc.string({ maxLength: 20 }),
  }),
  fc.record({
    type: fc.constant("executor-error" as const),
    retriable: fc.boolean(),
    error: fc.string({ maxLength: 20 }),
  }),
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("dagTransition — property: never throws", () => {
  it("returns { state, context } for any (phase, event) combination", () => {
    fc.assert(
      fc.property(arbDagPhase, arbDagEvent, (phase, event) => {
        const result = dagTransition(phase, event, minimalCtx);
        return (
          result !== null &&
          result !== undefined &&
          "state" in result &&
          "context" in result &&
          typeof result.state === "object" &&
          result.state !== null &&
          "kind" in result.state
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("terminal states are absorbing: any event produces the same state", () => {
    fc.assert(
      fc.property(arbDagEvent, (event) => {
        const succeeded: DagPhase = { kind: "succeeded", output: "done" };
        const failed: DagPhase = { kind: "failed", error: { kind: "aborted", reason: "x" } };

        const r1 = dagTransition(succeeded, event, minimalCtx);
        const r2 = dagTransition(failed, event, minimalCtx);

        // abort on terminal is a no-op (stays in same state)
        return r1.state.kind === "succeeded" && r2.state.kind === "failed";
      }),
      { numRuns: 500 },
    );
  });

  it("abort from any non-terminal phase yields failed+aborted", () => {
    const arbNonTerminalPhase = arbDagPhase.filter(
      (p) => p.kind !== "succeeded" && p.kind !== "failed",
    );
    fc.assert(
      fc.property(arbNonTerminalPhase, (phase) => {
        const abortEvent: DagEvent = { type: "abort", reason: "test-abort" };
        const result = dagTransition(phase, abortEvent, minimalCtx);
        return (
          result.state.kind === "failed" &&
          result.state.error.kind === "aborted" &&
          (result.state.error as { reason: string }).reason === "test-abort"
        );
      }),
      { numRuns: 1000 },
    );
  });
});
