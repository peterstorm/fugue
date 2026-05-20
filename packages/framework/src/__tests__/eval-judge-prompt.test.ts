import { describe, test, expect } from "bun:test";
import {
  JUDGE_SYSTEM_FRAME,
  generateDefaultRubric,
  resolveRubric,
  assembleJudgeUserMessage,
} from "../../src/nodes/eval-judge-prompt.js";

describe("eval-judge-prompt", () => {
  describe("JUDGE_SYSTEM_FRAME", () => {
    test("contains JSON schema instructions", () => {
      expect(JUDGE_SYSTEM_FRAME).toContain("score");
      expect(JUDGE_SYSTEM_FRAME).toContain("criteria_scores");
      expect(JUDGE_SYSTEM_FRAME).toContain("failed_criteria");
      expect(JUDGE_SYSTEM_FRAME).toContain("reason");
    });

    test("instructs 0.0 to 1.0 scoring", () => {
      expect(JUDGE_SYSTEM_FRAME).toContain("0.0");
      expect(JUDGE_SYSTEM_FRAME).toContain("1.0");
    });
  });

  describe("generateDefaultRubric", () => {
    test("generates bullet points for each criterion", () => {
      const rubric = generateDefaultRubric(["factuality", "relevance"], 0.8);
      expect(rubric).toContain("- factuality:");
      expect(rubric).toContain("- relevance:");
    });

    test("includes threshold in output", () => {
      const rubric = generateDefaultRubric(["clarity"], 0.7);
      expect(rubric).toContain("0.7");
    });

    test("handles empty criteria list", () => {
      const rubric = generateDefaultRubric([], 0.8);
      expect(rubric).toContain("threshold: 0.8");
    });

    test("handles single criterion", () => {
      const rubric = generateDefaultRubric(["tone"], 0.9);
      expect(rubric).toContain("- tone:");
      expect(rubric).toContain("0.9");
    });
  });

  describe("resolveRubric", () => {
    test("uses template source from prompts when available", () => {
      const promptsGet = (name: string) => name === "my-rubric" ? "Custom rubric content" : null;
      const result = resolveRubric(
        { criteria: ["a"], threshold: 0.8, rubric: { source: "template", templateId: "my-rubric" } },
        promptsGet,
      );
      expect(result).toBe("Custom rubric content");
    });

    test("falls back to auto-generated rubric when template not found", () => {
      const promptsGet = (_name: string) => null;
      const result = resolveRubric(
        { criteria: ["a"], threshold: 0.8, rubric: { source: "template", templateId: "missing" } },
        promptsGet,
      );
      expect(result).toContain("- a:");
    });

    test("uses inline source directly", () => {
      const result = resolveRubric(
        { criteria: ["a"], threshold: 0.8, rubric: { source: "inline", text: "My inline" } },
        null,
      );
      expect(result).toBe("My inline");
    });

    test("falls back to auto-generated rubric when rubric is omitted", () => {
      const result = resolveRubric(
        { criteria: ["factuality", "relevance"], threshold: 0.75 },
        null,
      );
      expect(result).toContain("- factuality:");
      expect(result).toContain("- relevance:");
      expect(result).toContain("0.75");
    });

    test("falls back to auto-generated when prompts is null and template requested", () => {
      const result = resolveRubric(
        { criteria: ["x"], threshold: 0.8, rubric: { source: "template", templateId: "something" } },
        null,
      );
      expect(result).toContain("- x:");
    });
  });

  describe("assembleJudgeUserMessage", () => {
    test("includes rubric, input, and output sections", () => {
      const msg = assembleJudgeUserMessage("My rubric", "hello input", "hello output");
      expect(msg).toContain("## Rubric");
      expect(msg).toContain("My rubric");
      expect(msg).toContain("## Input");
      expect(msg).toContain("hello input");
      expect(msg).toContain("## Output");
      expect(msg).toContain("hello output");
    });

    test("serializes object input/output to JSON", () => {
      const msg = assembleJudgeUserMessage("rubric", { key: "val" }, { result: 42 });
      expect(msg).toContain('"key": "val"');
      expect(msg).toContain('"result": 42');
    });

    test("handles string input/output directly", () => {
      const msg = assembleJudgeUserMessage("rubric", "raw string in", "raw string out");
      expect(msg).toContain("raw string in");
      expect(msg).toContain("raw string out");
      // Should NOT be double-quoted as JSON
      expect(msg).not.toContain('"raw string in"');
    });

    test("handles null/undefined values", () => {
      const msg = assembleJudgeUserMessage("rubric", null, undefined);
      expect(msg).toContain("null");
      // undefined serializes to undefined in JSON.stringify
      expect(msg).toBeDefined();
    });

    test("handles deeply nested objects", () => {
      const input = { nested: { deep: { value: [1, 2, 3] } } };
      const msg = assembleJudgeUserMessage("rubric", input, "out");
      expect(msg).toContain("1,");
      expect(msg).toContain("deep");
    });
  });
});
