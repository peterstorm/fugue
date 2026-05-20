import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { assertValidToolName, ensureToolNames, tool, toolName } from "../llm/tools.js";
import type { ToolDef } from "../types/llm.js";

const makeTool = (name: string): ToolDef<unknown, unknown> => ({
  name: name as any, // raw string for testing validation
  description: "",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async () => "",
});

describe("assertValidToolName", () => {
  it("accepts valid names", () => {
    expect(() => assertValidToolName("my_tool")).not.toThrow();
    expect(() => assertValidToolName("search-web")).not.toThrow();
    expect(() => assertValidToolName("a")).not.toThrow();
    expect(() => assertValidToolName("A1_b2-c3")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => assertValidToolName("")).toThrow(/Invalid tool name/);
  });

  it("rejects names with spaces", () => {
    expect(() => assertValidToolName("my tool")).toThrow(/Invalid tool name/);
  });

  it("rejects names with special characters", () => {
    expect(() => assertValidToolName("tool@v2")).toThrow(/Invalid tool name/);
    expect(() => assertValidToolName("tool.name")).toThrow(/Invalid tool name/);
  });

  it("rejects names exceeding 64 characters", () => {
    const longName = "a".repeat(65);
    expect(() => assertValidToolName(longName)).toThrow(/Invalid tool name/);
  });

  it("accepts names at the 64-character boundary", () => {
    const maxName = "a".repeat(64);
    expect(() => assertValidToolName(maxName)).not.toThrow();
  });
});

describe("toolName", () => {
  it("returns a branded ToolName for valid input", () => {
    const name = toolName("search");
    expect(name as string).toBe("search");
  });

  it("throws for invalid input", () => {
    expect(() => toolName("bad name")).toThrow();
  });
});

describe("ensureToolNames", () => {
  it("passes for valid unique names", () => {
    expect(() => ensureToolNames([makeTool("tool_a"), makeTool("tool_b")])).not.toThrow();
  });

  it("throws for duplicate names", () => {
    expect(() => ensureToolNames([makeTool("dup"), makeTool("dup")])).toThrow(/Duplicate tool name/);
  });

  it("throws for invalid names in the array", () => {
    expect(() => ensureToolNames([makeTool("bad name")])).toThrow(/Invalid tool name/);
  });
});

describe("tool() smart constructor", () => {
  it("brands a valid name and returns the full ToolDef", () => {
    const def = tool({
      name: "my_tool",
      description: "A tool",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.string(),
      run: async (input) => `result: ${input.query}`,
    });
    expect(def.name as string).toBe("my_tool");
    expect(def.description).toBe("A tool");
  });

  it("throws for an invalid name", () => {
    expect(() =>
      tool({
        name: "bad name!",
        description: "",
        inputSchema: z.object({}),
        outputSchema: z.string(),
        run: async () => "",
      }),
    ).toThrow(/Invalid tool name/);
  });
});
