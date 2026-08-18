import { describe, test, expect } from "bun:test";
import type { RunId, DagId } from "../types/ids.js";
import { createGuardrailNode } from "../../src/index.js";
import type { GuardrailResult } from "../../src/index.js";
import { z } from "zod";
import { NoopObserver, RecordingObserver } from "../../src/observer/observer.js";
import { N } from "./_id-helpers.js";

const InputSchema = z.object({ value: z.number() });
const OutputSchema: z.ZodType<GuardrailResult<number>> = z.any();

const makeCtx = (observer = new NoopObserver()) => ({
  runId: "test" as RunId,
  dagId: "test" as DagId,
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  logger: { warn: () => {}, error: () => {} },
  prompts: null,
  llm: null, http: null,
  clock: null,
});

describe("createGuardrailNode", () => {
  test("passes data through when validation succeeds", async () => {
    const node = createGuardrailNode({
      id: N("test-guardrail"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      validate: (input) => ({
        kind: "validated",
        value: input.value,
        passed: true,
        warnings: [],
        checks: [{ dimension: "range", passed: true, detail: "Value in range" }],
      }),
    });

    expect(node.kind).toBe("guardrail");

    const result = await node.run({ value: 42 }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "validated") {
      expect(result.value.value).toBe(42);
      expect(result.value.passed).toBe(true);
      expect(result.value.warnings).toHaveLength(0);
    } else {
      throw new Error("expected validated guardrail result");
    }
  });

  test("passes data through with warnings when validation fails", async () => {
    const node = createGuardrailNode({
      id: N("test-guardrail"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      validate: (input) => ({
        kind: "validated",
        value: input.value,
        passed: false,
        warnings: ["Value too high"],
        checks: [{ dimension: "range", passed: false, detail: "Value exceeds maximum" }],
      }),
    });

    const result = await node.run({ value: 9999 }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "validated") {
      expect(result.value.value).toBe(9999);
      expect(result.value.passed).toBe(false);
      expect(result.value.warnings).toContain("Value too high");
    } else {
      throw new Error("expected validated guardrail result");
    }
  });

  test("emits sub-span event on failure", async () => {
    const observer = new RecordingObserver();
    const node = createGuardrailNode({
      id: N("test-guardrail"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      validate: (input) => ({
        kind: "validated",
        value: input.value,
        passed: false,
        warnings: ["bad"],
        checks: [{ dimension: "test", passed: false, detail: "failed" }],
      }),
    });

    await node.run({ value: 1 }, makeCtx(observer));
    const subSpans = observer.events.filter((e) => e.type === "sub-span");
    expect(subSpans).toHaveLength(1);
    expect((subSpans[0] as any).kind).toBe("GUARDRAIL");
  });

  test("does not emit sub-span on success", async () => {
    const observer = new RecordingObserver();
    const node = createGuardrailNode({
      id: N("test-guardrail"),
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      validate: (input) => ({
        kind: "validated",
        value: input.value,
        passed: true,
        warnings: [],
        checks: [{ dimension: "test", passed: true, detail: "ok" }],
      }),
    });

    await node.run({ value: 1 }, makeCtx(observer));
    const subSpans = observer.events.filter((e) => e.type === "sub-span");
    expect(subSpans).toHaveLength(0);
  });
});
