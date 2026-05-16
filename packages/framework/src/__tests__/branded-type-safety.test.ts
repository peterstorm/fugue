// Negative type-level tests — compile-time assertions that branded types
// reject invalid inputs. Each @ts-expect-error is a positive assertion that
// the code DOES NOT compile — if it compiled, the brand would be leaking.

import { describe, test, expect } from "bun:test";
import type { NodeId, RunId, DagId } from "../types/ids.js";
import { nodeId, runId, dagId } from "../types/ids.js";
import type { DagDef } from "../types/dag.js";
import type { Confidence } from "../types/confidence.js";
import { confidence } from "../types/confidence.js";

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
    const c: Confidence = confidence("high", "logprob");
    expect(c.bucket).toBe("high");
    expect(c.source).toBe("logprob");
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
