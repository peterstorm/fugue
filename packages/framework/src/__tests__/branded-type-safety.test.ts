// Negative type-level tests — compile-time assertions that branded types
// reject invalid inputs. Each @ts-expect-error is a positive assertion that
// the code DOES NOT compile — if it compiled, the brand would be leaking.

import { describe, test, expect } from "bun:test";
import type { NodeId, RunId, DagId } from "../types/ids.js";
import { nodeId, runId, dagId } from "../types/ids.js";
import type { DagDef } from "../types/dag.js";
import type { Confidence } from "../types/confidence.js";
import { confidence } from "../types/confidence.js";
import {
  buildCheckpointWriteFailed,
  CHECKPOINT_INVALID_RUN_ID,
} from "../types/checkpoint-address.js";
import type { CheckpointWriteFailedError } from "../types/checkpoint-address.js";

describe("Branded type compile-time safety", () => {
  test("plain string does not satisfy NodeId", () => {
    // @ts-expect-error — string literal doesn't satisfy NodeId brand
    const _n: NodeId = "some-node";
    void _n;
  });

  test("plain string does not satisfy RunId", () => {
    // @ts-expect-error — string literal doesn't satisfy RunId brand
    const _r: RunId = "some-run";
    void _r;
  });

  test("plain string does not satisfy DagId", () => {
    // @ts-expect-error — string literal doesn't satisfy DagId brand
    const _d: DagId = "some-dag";
    void _d;
  });

  test("NodeId does not satisfy RunId (brands are incompatible)", () => {
    const nid = nodeId("my-node");
    // @ts-expect-error — NodeId is not interchangeable with RunId
    const _r: RunId = nid;
    void _r;
  });

  test("RunId does not satisfy NodeId", () => {
    const rid = runId("my-run");
    // @ts-expect-error — RunId is not interchangeable with NodeId
    const _n: NodeId = rid;
    void _n;
  });

  test("DagDef cannot be forged via spread", () => {
    // @ts-expect-error — plain object doesn't carry the __dagValidated brand
    const _d: DagDef = {
      id: dagId("test"),
      nodes: [],
      edges: [],
      outputNodeId: nodeId("x"),
      retryLimits: {},
      defaultRetryLimit: 3,
    };
    void _d;
  });

  test("Confidence cannot be constructed without smart constructor", () => {
    // @ts-expect-error — plain object doesn't satisfy branded Confidence
    const _c: Confidence = { bucket: "high", source: "logprob" };
    void _c;
  });

  test("confidence() produces a valid Confidence", () => {
    // This should compile — confidence() is the smart constructor
    // logprob source requires a numeric raw value
    const c: Confidence = confidence("high", "logprob", 0.95);
    expect(c.bucket).toBe("high");
    expect(c.source).toBe("logprob");
    expect(c.raw).toBe(0.95);
  });

  test("smart constructors produce valid branded types", () => {
    // These should all compile — smart constructors are the sanctioned path
    const n: NodeId = nodeId("test-node");
    const r: RunId = runId("test-run");
    const d: DagId = dagId("test-dag");
    expect(typeof n).toBe("string");
    expect(typeof r).toBe("string");
    expect(typeof d).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// SC-2 / type-design-analyzer-3 — `checkpoint-write-failed` address ADTs
//
// The variant used to carry the "inspect `invalidRunId` FIRST" obligation in a
// doc comment while typing the field as a real `RunId`. These are the pins that
// the obligation is now the compiler's job: the placeholder is unreadable as a
// run/node address until the consumer narrows, and the half-correlated shapes
// (a placeholder with no diagnostic, a real id carrying one) do not typecheck.
// ---------------------------------------------------------------------------

describe("checkpoint-write-failed address ADTs", () => {
  test("an unnarrowed address is not usable as a RunId or NodeId", () => {
    const takesRunId = (_r: RunId): void => {};
    const takesNodeId = (_n: NodeId): void => {};
    const e = buildCheckpointWriteFailed("run-1", "node-1", "boom");

    // @ts-expect-error — could be CheckpointPlaceholderRunId; narrow first
    takesRunId(e.runId);
    // @ts-expect-error — could be CheckpointPlaceholderNodeId; narrow first
    takesNodeId(e.nodeId);

    // …and narrowing on the additive diagnostic makes it usable again.
    if (e.invalidRunId === undefined) takesRunId(e.runId);
    if (e.invalidNodeId === undefined) takesNodeId(e.nodeId);
    expect(e.kind).toBe("checkpoint-write-failed");
  });

  test("a real branded id cannot carry an invalid* diagnostic", () => {
    // @ts-expect-error — the branded arm excludes `invalidRunId`
    const _bad: CheckpointWriteFailedError = {
      kind: "checkpoint-write-failed",
      runId: runId("run-1"),
      invalidRunId: "../escape",
      nodeId: nodeId("node-1"),
      message: "boom",
    };
    void _bad;
  });

  test("a placeholder cannot appear without its diagnostic", () => {
    // @ts-expect-error — the placeholder arm REQUIRES `invalidRunId`
    const _bad: CheckpointWriteFailedError = {
      kind: "checkpoint-write-failed",
      runId: CHECKPOINT_INVALID_RUN_ID,
      nodeId: nodeId("node-1"),
      message: "boom",
    };
    void _bad;
  });

  test("the builder round-trips both arms with the wire shape unchanged", () => {
    const valid = buildCheckpointWriteFailed("run-1", "node-1", "boom");
    expect(String(valid.runId)).toBe("run-1");
    expect(valid.invalidRunId).toBeUndefined();

    const rejected = buildCheckpointWriteFailed("../escape", "bad/node", "boom");
    expect(String(rejected.runId)).toBe("checkpoint_invalid_run");
    expect(rejected.invalidRunId).toBe("../escape");
    expect(String(rejected.nodeId)).toBe("checkpoint_invalid_node");
    expect(rejected.invalidNodeId).toBe("bad/node");

    // `nodeIdRaw === undefined` is the meta record, NOT a rejected value.
    const meta = buildCheckpointWriteFailed("run-1", undefined, "boom");
    expect(String(meta.nodeId)).toBe("checkpoint_meta");
    expect(meta.invalidNodeId).toBeUndefined();
  });
});
