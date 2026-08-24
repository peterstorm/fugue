import { afterEach, describe, it, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema, objectSchemaKeys, objectSchemaRequiredKeys } from "../llm/zod-schema.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";

afterEach(() => __resetFrameworkLogger());

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

describe("object schema introspection failure", () => {
  it("returns null even when the diagnostic logger throws", () => {
    setFrameworkLogger({
      debug() { throw new Error("logger transport failed"); },
      info() {},
      warn() {},
      error() {},
    });
    const schemaLike = { parse() {} };

    expect(objectSchemaKeys(schemaLike)).toBeNull();
    expect(objectSchemaRequiredKeys(schemaLike)).toBeNull();
  });
});

describe("zodToJsonSchema — unrepresentable types (peterstorm/fugue#36, related)", () => {
  it("z.date() renders as an open schema instead of throwing — at ANY nesting depth", () => {
    const schema = z.object({ d: z.date(), rows: z.array(z.object({ at: z.date() })) });
    const result = zodToJsonSchema(schema); // used to throw "Date cannot be represented in JSON Schema"
    expect((result.properties as any).d).toEqual({});
    const items = (result.properties as any).rows.items as { properties: Record<string, unknown> };
    expect(items.properties.at).toEqual({});
  });

  it("objectSchemaKeys still introspects schemas with z.date() columns (no more 'unverifiable')", () => {
    const schema = z.object({ a: z.string(), d: z.date() });
    expect(objectSchemaKeys(schema)).toEqual(["a", "d"]);
    expect(objectSchemaRequiredKeys(schema)).toEqual(["a", "d"]);
  });

  it("schemas without unrepresentable types are rendered exactly as before", () => {
    const schema = z.object({ name: z.string(), n: z.number(), b: z.boolean() });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect((result.properties as any).name).toEqual({ type: "string" });
    expect((result.properties as any).n).toEqual({ type: "number" });
    expect((result.properties as any).b).toEqual({ type: "boolean" });
  });
});
