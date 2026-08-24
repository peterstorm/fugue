/**
 * Test: dagTransition non-retriable fast-fail path
 *
 * Validates that non-retriable errors bypass the retry budget entirely
 * and transition directly to terminal failed state from `dagTransition`.
 */

import { describe, it, expect } from "bun:test";
import { dagTransition } from "../dag-runtime/transition.js";
import type { DagPhase, DagMachineContextPersisted } from "../dag-runtime/types.js";
import { N } from "./_id-helpers.js";
import { FE } from "./_freshness-helpers.js";
import type { FrameworkError } from "../types/errors.js";

const makeCtx = (retryLimits: Record<string, number> = {}): DagMachineContextPersisted => ({
  waves: [[N("a")]],
  outputs: new Map(),
  initialInput: {},
  activeNodeIds: new Set([N("a")]),
  retries: new Map(),
  retryConfigs: new Map(),
  retryLimits,
  defaultRetryLimit: 3,
  confidenceByNode: new Map(),
  outputNodeId: undefined,
  edges: [],
  unconditionalAdj: new Map(),
  humanReviewNodeIds: new Set(),
  humanReviewPrompts: new Map(),
  priorWitnesses: new Map(),
  freshnessCompletedNodeIds: new Set(),
  freshnessExecutionEpoch: FE(),
});

describe("dagTransition — non-retriable fast-fail", () => {
  it("node-crash with retriability=non-retriable goes directly to failed (skips retry budget)", () => {
    const phase: DagPhase = { kind: "running", wave: 0 };
    const ctx = makeCtx({ a: 5 }); // generous budget — should NOT be used

    const error: FrameworkError = {
      kind: "node-crash",
      nodeId: N("a"),
      message: "deterministic failure: tool iteration exhausted",
      retriability: "non-retriable",
    };

    const result = dagTransition(phase, { type: "node-failed", nodeId: N("a"), error }, ctx);

    expect(result.state.kind).toBe("failed");
    // Should be the original error, NOT retry-exhausted
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "node-crash", retriability: "non-retriable" },
    });
  });

  it("validation error goes directly to failed regardless of retry budget", () => {
    const phase: DagPhase = { kind: "running", wave: 0 };
    const ctx = makeCtx({ a: 10 });

    const error: FrameworkError = {
      kind: "validation",
      nodeId: N("a"),
      message: "output schema mismatch",
    };

    const result = dagTransition(phase, { type: "node-failed", nodeId: N("a"), error }, ctx);

    expect(result.state.kind).toBe("failed");
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "validation" },
    });
  });

  it("predicate-malformed error fast-fails without retry", () => {
    const phase: DagPhase = { kind: "running", wave: 0 };
    const ctx = makeCtx({ a: 10 });

    const error: FrameworkError = {
      kind: "predicate-malformed",
      nodeId: N("a"),
      message: "predicate version changed during run",
    };

    const result = dagTransition(phase, { type: "node-failed", nodeId: N("a"), error }, ctx);

    expect(result.state.kind).toBe("failed");
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "predicate-malformed" },
    });
  });

  it("retriable node-crash with budget available goes to retrying (NOT failed)", () => {
    const phase: DagPhase = { kind: "running", wave: 0 };
    const ctx = makeCtx({ a: 3 });

    const error: FrameworkError = {
      kind: "node-crash",
      nodeId: N("a"),
      message: "transient network issue",
      retriability: "retriable",
    };

    const result = dagTransition(phase, { type: "node-failed", nodeId: N("a"), error }, ctx);

    expect(result.state.kind).toBe("retrying");
  });
});
