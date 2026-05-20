import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "../llm/zod-schema.js";

describe("zodToJsonSchema", () => {
  it("strips $schema key from output", () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema);
    expect(result).not.toHaveProperty("$schema");
  });

  it("preserves basic object schema structure", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect((result.properties as any).name).toEqual({ type: "string" });
    expect((result.properties as any).age).toEqual({ type: "number" });
  });

  it("handles nested object schemas", () => {
    const schema = z.object({
      user: z.object({ id: z.number(), email: z.string() }),
    });
    const result = zodToJsonSchema(schema);
    const user = (result.properties as any).user;
    expect(user.type).toBe("object");
    expect(user.properties.id).toEqual({ type: "number" });
  });

  it("handles enum schemas", () => {
    const schema = z.object({ status: z.enum(["active", "inactive"]) });
    const result = zodToJsonSchema(schema);
    const status = (result.properties as any).status;
    expect(status.enum ?? status.anyOf).toBeDefined();
  });

  it("handles optional fields", () => {
    const schema = z.object({ name: z.string(), bio: z.string().optional() });
    const result = zodToJsonSchema(schema);
    // required should include name but not bio
    const required = result.required as string[] | undefined;
    if (required) {
      expect(required).toContain("name");
      expect(required).not.toContain("bio");
    }
  });

  it("handles array schemas", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = zodToJsonSchema(schema);
    const tags = (result.properties as any).tags;
    expect(tags.type).toBe("array");
  });
});
