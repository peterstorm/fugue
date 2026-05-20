// classify-guardrail-outcome.test.ts — pure unit tests for classifyGuardrailOutcome.
// No OTel dependency, no async, no mocks — plain data in/out.

import { describe, it, expect } from "bun:test";
import { classifyGuardrailOutcome } from "../dag-runtime/node-span.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { __brandNodeId } from "../types/ids.js";

describe("classifyGuardrailOutcome", () => {
  it("returns empty outcome for non-guardrail node (kind = 'transform')", () => {
    const result = classifyGuardrailOutcome("transform", ok({ passed: false }));
    expect(result.guardrailFailed).toBe(false);
    expect(result.guardrailWarnings).toEqual([]);
  });

  it("returns empty outcome for non-guardrail node (kind = 'llm')", () => {
    const result = classifyGuardrailOutcome("llm", ok({ something: "else" }));
    expect(result.guardrailFailed).toBe(false);
  });

  it("returns empty outcome for error result (even for guardrail kind)", () => {
    const error: FrameworkError = {
      kind: "node-crash",
      nodeId: __brandNodeId("g1"),
      message: "boom",
      retriability: "retriable",
    };
    const result = classifyGuardrailOutcome("guardrail", err(error));
    expect(result.guardrailFailed).toBe(false);
    expect(result.guardrailWarnings).toEqual([]);
  });

  it("returns empty outcome for guardrail node that passed", () => {
    const result = classifyGuardrailOutcome("guardrail", ok({ passed: true, warnings: [] }));
    expect(result.guardrailFailed).toBe(false);
    expect(result.guardrailWarnings).toEqual([]);
  });

  it("returns failure outcome for guardrail node that failed with warnings", () => {
    const result = classifyGuardrailOutcome("guardrail", ok({
      passed: false,
      warnings: ["hallucination detected", "unsupported claim"],
    }));
    expect(result.guardrailFailed).toBe(true);
    expect(result.guardrailWarnings).toEqual(["hallucination detected", "unsupported claim"]);
  });

  it("returns failure outcome for guardrail node that failed without warnings", () => {
    const result = classifyGuardrailOutcome("guardrail", ok({ passed: false }));
    expect(result.guardrailFailed).toBe(true);
    expect(result.guardrailWarnings).toEqual([]);
  });

  it("returns empty outcome for guardrail node with non-object result", () => {
    const result = classifyGuardrailOutcome("guardrail", ok("string-value"));
    expect(result.guardrailFailed).toBe(false);
  });

  it("returns empty outcome for guardrail node with null result value", () => {
    const result = classifyGuardrailOutcome("guardrail", ok(null));
    expect(result.guardrailFailed).toBe(false);
  });
});
