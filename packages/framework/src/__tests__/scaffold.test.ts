import { describe, test, expect } from "bun:test";

describe("scaffolding", () => {
  test("framework barrel export exists", async () => {
    const mod = await import("../index.js");
    expect(mod).toBeDefined();
  });
});
