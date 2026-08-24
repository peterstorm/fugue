import { describe, it, expect } from "bun:test";
import { handleNodeFailed, handleHookCrash, computeBackoffMs, getRetryLimit, type RetryConfigs } from "../dag-runtime/retry-policy.js";
import type { DagMachineContext } from "../dag-runtime/types.js";
import type { FrameworkError } from "../types/errors.js";
import type { DagDef } from "../types/dag.js";
import { N, D, nodeMap } from "./_id-helpers.js";

// ---------------------------------------------------------------------------
// Minimal context factory
// ---------------------------------------------------------------------------

const mkCtx = (overrides: Partial<DagMachineContext> = {}): DagMachineContext => {
  const dag = overrides.dag ?? ({ id: D("test"), nodes: [], edges: [], retryLimits: {}, defaultRetryLimit: 0 } as unknown as DagDef);
  return {
    waves: [],
    outputs: new Map(),
    retries: overrides.retries ?? new Map(),
    initialInput: null,
    activeNodeIds: new Set(),
    dag,
    incomingByNode: new Map(),
    outgoingByNode: new Map(),
    unconditionalAdj: new Map(),
    nodeById: new Map(),
    retryConfigs: new Map(),
    outputNodeId: dag.outputNodeId,
    defaultRetryLimit: dag.defaultRetryLimit,
    retryLimits: dag.retryLimits,
    humanReviewNodeIds: new Set(),
    humanReviewPrompts: new Map(),
    edges: dag.edges ?? [],
    confidenceByNode: new Map(),
    ...overrides,
    priorWitnesses: overrides.priorWitnesses ?? new Map(),
    freshnessCompletedNodeIds: overrides.freshnessCompletedNodeIds ?? new Set(),
  };
};

// ---------------------------------------------------------------------------
// Fast-fail error kinds
// ---------------------------------------------------------------------------

const FAST_FAIL_ERRORS: FrameworkError[] = [
  { kind: "predicate-malformed", nodeId: N("n"), message: "bad pred" },
  { kind: "validation", nodeId: N("n"), message: "schema mismatch" },
  { kind: "checkpoint-write-failed", runId: "r" as any, nodeId: N("n"), message: "write failed" },
  { kind: "aborted", reason: "user cancelled" },
  { kind: "missing-capability", missing: [{ nodeId: N("n"), capability: "llm" }] },
  { kind: "node-crash", nodeId: N("n"), message: "permanent", retriability: "non-retriable" },
];

describe("handleNodeFailed — fast-fail kinds", () => {
  for (const error of FAST_FAIL_ERRORS) {
    it(`${error.kind}${error.kind === "node-crash" ? " (non-retriable)" : ""} → terminal failed, no retry`, () => {
      const ctx = mkCtx({
        dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 5 }, defaultRetryLimit: 3 } as unknown as DagDef,
      });
      const result = handleNodeFailed(0, N("n"), error, ctx);
      expect(result.state.kind).toBe("failed");
      if (result.state.kind === "failed") {
        expect(result.state.error).toBe(error); // exact same error object — not wrapped
      }
    });
  }
});

describe("handleNodeFailed — missing-capability fast-fail (claims-without-delivery)", () => {
  // The dispatch-time claims-without-delivery emission from run-node is
  // deterministic: the broker's `provides()` / `ok()` mismatch reproduces on
  // every attempt, and each retry re-fires `mintFor` (duplicate audit records,
  // real egress once the cache window lapses). It must transition straight to
  // terminal `failed` with the ORIGINAL error — never `retrying`, never
  // rewrapped as `retry-exhausted` — even when retry budget remains.
  it("fast-fails to terminal failed with the original error, despite remaining budget", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 5 }, defaultRetryLimit: 3 } as unknown as DagDef,
    });
    const error: FrameworkError = {
      kind: "missing-capability",
      missing: [{ nodeId: N("n"), capability: "llm" }],
    };
    const result = handleNodeFailed(0, N("n"), error, ctx);

    expect(result.state.kind).toBe("failed");
    expect(result.state.kind).not.toBe("retrying");
    if (result.state.kind === "failed") {
      // Exact same error object — not rewrapped as retry-exhausted.
      expect(result.state.error).toBe(error);
      expect(result.state.error.kind).toBe("missing-capability");
    }
    // No retry slot consumed — the budget map is untouched.
    expect(result.context.retries.get(N("n"))).toBeUndefined();
  });
});

describe("handleNodeFailed — retriable errors", () => {
  it("retries within budget → retrying state", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 2 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "transient", nodeId: N("n"), message: "timeout" };
    const result = handleNodeFailed(0, N("n"), error, ctx);
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.attempt).toBe(1);
    }
    expect(result.context.retries.get(N("n"))).toBe(1);
  });

  it("exhausted → retry-exhausted with incremented retries", () => {
    const ctx = mkCtx({
      retries: nodeMap([["n", 1]]),
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 1 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "transient", nodeId: N("n"), message: "timeout" };
    const result = handleNodeFailed(0, N("n"), error, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed" && result.state.error.kind === "retry-exhausted") {
      expect(result.state.error.attempts).toBe(2);
      expect(result.state.error.rootErrorKind).toBe("transient");
    }
    // Context retries map matches attempts count
    expect(result.context.retries.get(N("n"))).toBe(2);
  });

  it("retriable node-crash retries normally", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 1 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "node-crash", nodeId: N("n"), message: "oops", retriability: "retriable" };
    const result = handleNodeFailed(0, N("n"), error, ctx);
    expect(result.state.kind).toBe("retrying");
  });
});

describe("handleNodeFailed — co-failed siblings", () => {
  it("pre-increments co-failed siblings to prevent limit+1 executions", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("a")]: 2, [N("b")]: 2 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "transient", nodeId: N("a"), message: "fail" };
    const result = handleNodeFailed(0, N("a"), error, ctx, new Map(), [N("b")]);
    expect(result.context.retries.get(N("b"))).toBe(1);
    expect(result.context.retries.get(N("a"))).toBe(1);
  });

  it("co-failed sibling capped at its own retry limit", () => {
    const ctx = mkCtx({
      retries: nodeMap([["b", 2]]),
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("a")]: 3, [N("b")]: 2 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "transient", nodeId: N("a"), message: "fail" };
    const result = handleNodeFailed(0, N("a"), error, ctx, new Map(), [N("b")]);
    // b was at 2 (its limit), should be capped at min(2+1, 2) = 2
    expect(result.context.retries.get(N("b"))).toBe(2);
  });
});

describe("handleHookCrash", () => {
  it("retries within budget → retrying-hook state", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 2 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "node-crash", nodeId: N("n"), message: "hook threw", retriability: "retriable" };
    const result = handleHookCrash(N("n"), "output", "prompt", error, ctx);
    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.attempt).toBe(1);
      expect(result.state.output).toBe("output");
      expect(result.state.prompt).toBe("prompt");
    }
    expect(result.context.retries.get(N("n"))).toBe(1);
  });

  it("exhausted → retry-exhausted with incremented retries", () => {
    const ctx = mkCtx({
      retries: nodeMap([["n", 1]]),
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("n")]: 1 }, defaultRetryLimit: 0 } as unknown as DagDef,
    });
    const error: FrameworkError = { kind: "node-crash", nodeId: N("n"), message: "hook threw", retriability: "retriable" };
    const result = handleHookCrash(N("n"), "output", "prompt", error, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed" && result.state.error.kind === "retry-exhausted") {
      expect(result.state.error.attempts).toBe(2);
    }
    // Context retries map matches attempts count
    expect(result.context.retries.get(N("n"))).toBe(2);
  });
});

describe("computeBackoffMs", () => {
  it("returns default backoff schedule", () => {
    const configs: RetryConfigs = new Map();
    expect(computeBackoffMs(N("n"), 0, configs)).toBe(1000);
    expect(computeBackoffMs(N("n"), 1, configs)).toBe(2000);
    expect(computeBackoffMs(N("n"), 2, configs)).toBe(4000);
    // Clamps to last entry
    expect(computeBackoffMs(N("n"), 10, configs)).toBe(4000);
  });
});

describe("getRetryLimit", () => {
  it("uses per-node override when present", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: { [N("a")]: 5 }, defaultRetryLimit: 2 } as unknown as DagDef,
    });
    expect(getRetryLimit(N("a"), ctx)).toBe(5);
  });

  it("falls back to DAG default", () => {
    const ctx = mkCtx({
      dag: { id: D("test"), nodes: [], edges: [], retryLimits: {}, defaultRetryLimit: 3 } as unknown as DagDef,
    });
    expect(getRetryLimit(N("x"), ctx)).toBe(3);
  });

  it("returns 0 when no limits configured", () => {
    const ctx = mkCtx();
    expect(getRetryLimit(N("x"), ctx)).toBe(0);
  });
});
